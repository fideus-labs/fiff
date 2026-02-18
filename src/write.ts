// SPDX-FileCopyrightText: Copyright (c) Fideus Labs LLC
// SPDX-License-Identifier: MIT

/**
 * High-level OME-TIFF writer.
 *
 * Converts an ngff-zarr Multiscales object to a complete OME-TIFF file
 * as an ArrayBuffer. Supports multi-resolution pyramids (via SubIFDs),
 * tiled output, deflate compression, parallel plane reading, and
 * automatic BigTIFF detection.
 *
 * @example
 * ```ts
 * import { toOmeTiff } from "@fideus-labs/fiff";
 * import type { Multiscales } from "@fideus-labs/ngff-zarr";
 *
 * const buffer = await toOmeTiff(multiscales);
 * // buffer is a valid OME-TIFF ArrayBuffer
 * ```
 */

import type { Multiscales, NgffImage } from "@fideus-labs/ngff-zarr"
import * as zarr from "zarrita"

import type { ZarrDataType } from "./dtypes.js"
import { bytesPerElement, zarrToTiffDtype } from "./dtypes.js"
import type { OmePixels } from "./ome-xml.js"

/**
 * Callback that reads a zarr array slice.
 *
 * Mirrors the signature of `zarr.get()` from zarrita: receives an
 * array and a per-dimension selection, and must return an object whose
 * `.data` property is a typed array of pixel values.
 *
 * The return type uses `ArrayLike<unknown>` so that zarrita's
 * `Chunk<DataType>` (whose `.data` may be `Array<string>` for string
 * dtypes at the type level) is assignable here.  In practice only
 * numeric typed arrays are valid — fiff casts `.data` internally.
 *
 * @see {@link WriteOptions.getPlane}
 */
export type GetPlane = (
  data: zarr.Array<zarr.DataType, zarr.Readable>,
  selection: (number | null)[],
) => Promise<{ data: ArrayLike<unknown> }>

import type { DimensionInfo } from "./ome-xml-writer.js"
import { buildOmeXml, extractDimensions } from "./ome-xml-writer.js"
import {
  buildTiff,
  DEFAULT_TILE_SIZE,
  makeImageTags,
  sliceTiles,
  type WritableIfd,
} from "./tiff-writer.js"

/** Options for the OME-TIFF writer. */
export interface WriteOptions {
  /**
   * DimensionOrder for the TIFF IFD layout.
   * Determines the order in which C, Z, T planes are stored.
   * Default: "XYZCT".
   */
  dimensionOrder?: "XYZCT" | "XYZTC" | "XYCTZ" | "XYCZT" | "XYTCZ" | "XYTZC"

  /**
   * Compression to apply to pixel data.
   * - "none": no compression (larger files, faster write)
   * - "deflate": zlib/deflate compression (smaller files, compatible with all readers)
   * Default: "deflate".
   */
  compression?: "none" | "deflate"

  /**
   * Deflate compression level (1-9).
   * Higher values produce smaller files but take longer.
   * Only used when compression is "deflate".
   * Default: 6.
   */
  compressionLevel?: number

  /** Creator string embedded in the OME-XML. Default: "fiff". */
  creator?: string

  /** Image name. Falls back to multiscales.metadata.name or "image". */
  imageName?: string

  /**
   * Tile size in pixels. Images larger than this in either dimension
   * will use tiled output. Must be a multiple of 16.
   * Default: 256 (OME-TIFF convention).
   * Set to 0 to disable tiling (strip-based output).
   */
  tileSize?: number

  /**
   * Maximum number of planes to read concurrently.
   * Higher values use more memory but can speed up writes when
   * reading from async data sources.
   * Default: 4.
   */
  concurrency?: number

  /**
   * TIFF format to use.
   * - "auto": Classic TIFF when possible, BigTIFF for files > 4 GB.
   * - "classic": Force classic TIFF (fails if file > 4 GB).
   * - "bigtiff": Force BigTIFF (64-bit offsets).
   * Default: "auto".
   */
  format?: "auto" | "classic" | "bigtiff"

  /**
   * Optional worker pool for offloading deflate compression to Web Workers.
   *
   * When provided and compression is "deflate" with the default level (6),
   * tile compression uses CompressionStream on pool workers — releasing the
   * main thread entirely.
   *
   * When not provided (or for non-default compression levels), falls back
   * to the existing main-thread path (CompressionStream -> pako).
   *
   * Accepts any object matching the `DeflatePool` interface from
   * `@fideus-labs/worker-pool`.
   */
  pool?: import("./worker-utils.js").DeflatePool
  /** Custom worker script URL. Only used when `pool` is provided. */
  workerUrl?: string

  /**
   * Custom plane reader to replace the internal `zarr.get()` call.
   *
   * When provided, `toOmeTiff` calls this function instead of the
   * built-in `zarr.get()` to read each (c, z, t) plane.
   *
   * This is useful for:
   * - Offloading blosc decompression to a worker pool (e.g. ngff-zarr's
   *   `zarrGet`) when the in-memory zarr arrays use blosc codecs.
   * - Bypassing decompression entirely when the arrays use
   *   `bytesOnlyCodecs()` (no-op reads from uncompressed data).
   *
   * The callback receives the zarr array and a per-dimension selection
   * (scalar index or `null` for "take all") and must return an object
   * with a `.data` typed-array property — the same shape as
   * `zarr.get()`.
   */
  getPlane?: GetPlane
}

/**
 * Convert an ngff-zarr Multiscales to an OME-TIFF ArrayBuffer.
 *
 * Writes all resolution levels as SubIFDs (pyramids) if the
 * Multiscales has more than one image. The highest-resolution
 * level goes in the main IFD chain; lower-resolution levels
 * are attached as SubIFDs to each corresponding main IFD.
 *
 * Planes are read with bounded concurrency and tiles are compressed
 * eagerly to minimise peak memory.
 *
 * @param multiscales - The ngff-zarr Multiscales object to write.
 * @param options - Writer options.
 * @returns A complete OME-TIFF file as an ArrayBuffer.
 */
export async function toOmeTiff(
  multiscales: Multiscales,
  options: WriteOptions = {},
): Promise<ArrayBuffer> {
  const dimensionOrder = options.dimensionOrder ?? "XYZCT"
  const compression = options.compression ?? "deflate"
  const compressionLevel = options.compressionLevel ?? 6
  const tileSize = options.tileSize ?? DEFAULT_TILE_SIZE
  const concurrency = options.concurrency ?? 4
  const { getPlane } = options
  const format = options.format ?? "auto"

  const fullResImage = multiscales.images[0]
  const dtype = fullResImage.data.dtype as ZarrDataType
  const dims = extractDimensions(multiscales)
  const bpe = bytesPerElement(dtype)
  const tiffDtype = zarrToTiffDtype(dtype)

  // Generate OME-XML for the first IFD
  const omeXml = buildOmeXml(multiscales, dtype, {
    dimensionOrder,
    creator: options.creator,
    imageName: options.imageName,
  })

  const totalPlanes = dims.sizeC * dims.sizeZ * dims.sizeT
  const numLevels = multiscales.images.length

  // Build one IFD (with SubIFDs) for a given plane index.
  const buildPlaneIfd = async (ifdIdx: number): Promise<WritableIfd> => {
    const { c, z, t } = ifdIndexToPlane(ifdIdx, dims, dimensionOrder)

    // Read + tile the full-resolution plane
    const planeData = await readPlane(
      fullResImage,
      dims,
      c,
      z,
      t,
      bpe,
      getPlane,
    )
    const mainTiles = slicePlane(
      planeData,
      dims.sizeX,
      dims.sizeY,
      bpe,
      tileSize,
    )

    const isFirst = ifdIdx === 0
    const tags = makeImageTags(
      dims.sizeX,
      dims.sizeY,
      tiffDtype.bitsPerSample,
      tiffDtype.sampleFormat,
      "none", // compression handled by buildTiff
      isFirst ? omeXml : undefined,
      false,
      tileSize,
    )

    // Build SubIFDs for pyramid levels (if any)
    const subIfds: WritableIfd[] = []
    for (let level = 1; level < numLevels; level++) {
      const subImage = multiscales.images[level]
      const subDims = extractLevelDimensions(subImage, dims)
      const subPlane = await readPlane(
        subImage,
        subDims,
        c,
        z,
        t,
        bpe,
        getPlane,
      )
      const subTiles = slicePlane(
        subPlane,
        subDims.sizeX,
        subDims.sizeY,
        bpe,
        tileSize,
      )

      const subTags = makeImageTags(
        subDims.sizeX,
        subDims.sizeY,
        tiffDtype.bitsPerSample,
        tiffDtype.sampleFormat,
        "none",
        undefined,
        true, // isSubResolution
        tileSize,
      )

      subIfds.push({ tags: subTags, tiles: subTiles })
    }

    return {
      tags,
      tiles: mainTiles,
      subIfds: subIfds.length > 0 ? subIfds : undefined,
    }
  }

  // Read planes with bounded concurrency
  const mainIfds: WritableIfd[] = new Array(totalPlanes)
  const effectiveConcurrency = Math.max(1, Math.min(concurrency, totalPlanes))

  for (let start = 0; start < totalPlanes; start += effectiveConcurrency) {
    const end = Math.min(start + effectiveConcurrency, totalPlanes)
    const batch = []
    for (let i = start; i < end; i++) {
      batch.push(
        buildPlaneIfd(i).then((ifd) => {
          mainIfds[i] = ifd
        }),
      )
    }
    await Promise.all(batch)
  }

  return buildTiff(mainIfds, {
    compression,
    compressionLevel,
    format,
    pool: options.pool,
    workerUrl: options.workerUrl,
  })
}

// ── Internal helpers ────────────────────────────────────────────────

/**
 * Slice a plane into tiles or return as a single strip.
 * Decides based on whether the image is large enough to warrant tiling.
 */
function slicePlane(
  planeBytes: Uint8Array,
  width: number,
  height: number,
  bpe: number,
  tileSize: number,
): Uint8Array[] {
  if (tileSize > 0 && (width > tileSize || height > tileSize)) {
    return sliceTiles(planeBytes, width, height, bpe, tileSize, tileSize)
  }
  // Small image: single strip
  return [planeBytes]
}

/**
 * Map a linear IFD index back to (c, z, t) based on DimensionOrder.
 * This is the inverse of getIfdIndex.
 */
function ifdIndexToPlane(
  ifdIdx: number,
  dims: DimensionInfo,
  dimensionOrder: string,
): { c: number; z: number; t: number } {
  const { sizeC, sizeZ, sizeT } = dims

  // The DimensionOrder string is XYNNN where NNN are the three varying dims
  // from fastest to slowest (after XY which are always the plane dimensions).
  // e.g. "XYZCT" means Z varies fastest, then C, then T.
  const order = dimensionOrder.slice(2) // e.g. "ZCT"

  // Sizes and names in fastest-to-slowest order
  const sizeMap: Record<string, number> = { Z: sizeZ, C: sizeC, T: sizeT }
  const sizes = [sizeMap[order[0]], sizeMap[order[1]], sizeMap[order[2]]]

  // Decompose ifdIdx: idx = d0 + sizes[0] * (d1 + sizes[1] * d2)
  const d0 = ifdIdx % sizes[0]
  const d1 = Math.floor(ifdIdx / sizes[0]) % sizes[1]
  const d2 = Math.floor(ifdIdx / (sizes[0] * sizes[1]))

  const result: Record<string, number> = {}
  result[order[0]] = d0
  result[order[1]] = d1
  result[order[2]] = d2

  return {
    c: result["C"] ?? 0,
    z: result["Z"] ?? 0,
    t: result["T"] ?? 0,
  }
}

/**
 * Read a single (c, z, t) plane from an NgffImage as raw bytes.
 * Returns a Uint8Array of little-endian pixel data.
 */
async function readPlane(
  image: NgffImage,
  dims: DimensionInfo,
  c: number,
  z: number,
  t: number,
  bpe: number,
  getPlane?: GetPlane,
): Promise<Uint8Array> {
  const dimNames = image.dims
  const shape = image.data.shape

  // Build selection: scalar indices for t, c, z; null for y, x
  const selection: (number | null)[] = []
  for (let i = 0; i < dimNames.length; i++) {
    switch (dimNames[i]) {
      case "t":
        selection.push(Math.min(t, shape[i] - 1))
        break
      case "c":
        selection.push(Math.min(c, shape[i] - 1))
        break
      case "z":
        selection.push(Math.min(z, shape[i] - 1))
        break
      default:
        // y, x — take all
        selection.push(null)
        break
    }
  }

  const result = getPlane
    ? await getPlane(image.data, selection)
    : await zarr.get(image.data, selection as any)
  const typedArray = (result as any).data as
    | Uint8Array
    | Int8Array
    | Uint16Array
    | Int16Array
    | Uint32Array
    | Int32Array
    | Float32Array
    | Float64Array

  // Convert to raw bytes (little-endian)
  return new Uint8Array(
    typedArray.buffer,
    typedArray.byteOffset,
    typedArray.byteLength,
  )
}

/**
 * Extract dimension info for a sub-resolution image.
 * Non-spatial dimensions (C, Z, T) are inherited from the full-res dims.
 * Spatial dimensions (X, Y) come from the sub-resolution image's shape.
 */
function extractLevelDimensions(
  image: NgffImage,
  fullDims: DimensionInfo,
): DimensionInfo {
  const shape = image.data.shape
  const dimNames = image.dims

  let sizeX = fullDims.sizeX
  let sizeY = fullDims.sizeY

  for (let i = 0; i < dimNames.length; i++) {
    if (dimNames[i] === "x") sizeX = shape[i]
    if (dimNames[i] === "y") sizeY = shape[i]
  }

  return {
    ...fullDims,
    sizeX,
    sizeY,
  }
}
