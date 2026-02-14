// SPDX-FileCopyrightText: Copyright (c) Fideus Labs LLC
// SPDX-License-Identifier: MIT

/**
 * High-level OME-TIFF writer.
 *
 * Converts an ngff-zarr Multiscales object to a complete OME-TIFF file
 * as an ArrayBuffer. Supports multi-resolution pyramids (via SubIFDs)
 * and optional deflate compression.
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

import type { Multiscales, NgffImage } from "@fideus-labs/ngff-zarr";
import * as zarr from "zarrita";
import type { ZarrDataType } from "./dtypes.js";
import { zarrToTiffDtype, bytesPerElement } from "./dtypes.js";
import { buildOmeXml, extractDimensions } from "./ome-xml-writer.js";
import type { DimensionInfo } from "./ome-xml-writer.js";
import {
  buildTiff,
  makeImageTags,
  type WritableIfd,
} from "./tiff-writer.js";
import { getIfdIndex } from "./ome-xml.js";
import type { OmePixels } from "./ome-xml.js";

/** Options for the OME-TIFF writer. */
export interface WriteOptions {
  /**
   * DimensionOrder for the TIFF IFD layout.
   * Determines the order in which C, Z, T planes are stored.
   * Default: "XYZCT".
   */
  dimensionOrder?:
    | "XYZCT"
    | "XYZTC"
    | "XYCTZ"
    | "XYCZT"
    | "XYTCZ"
    | "XYTZC";

  /**
   * Compression to apply to pixel data.
   * - "none": no compression (larger files, faster write)
   * - "deflate": zlib/deflate compression (smaller files, compatible with all readers)
   * Default: "deflate".
   */
  compression?: "none" | "deflate";

  /**
   * Deflate compression level (1-9).
   * Higher values produce smaller files but take longer.
   * Only used when compression is "deflate".
   * Default: 6.
   */
  compressionLevel?: number;

  /** Creator string embedded in the OME-XML. Default: "fiff". */
  creator?: string;

  /** Image name. Falls back to multiscales.metadata.name or "image". */
  imageName?: string;
}

/**
 * Convert an ngff-zarr Multiscales to an OME-TIFF ArrayBuffer.
 *
 * Writes all resolution levels as SubIFDs (pyramids) if the
 * Multiscales has more than one image. The highest-resolution
 * level goes in the main IFD chain; lower-resolution levels
 * are attached as SubIFDs to each corresponding main IFD.
 *
 * @param multiscales - The ngff-zarr Multiscales object to write.
 * @param options - Writer options.
 * @returns A complete OME-TIFF file as an ArrayBuffer.
 */
export async function toOmeTiff(
  multiscales: Multiscales,
  options: WriteOptions = {},
): Promise<ArrayBuffer> {
  const dimensionOrder = options.dimensionOrder ?? "XYZCT";
  const compression = options.compression ?? "deflate";
  const compressionLevel = options.compressionLevel ?? 6;

  const fullResImage = multiscales.images[0];
  const dtype = fullResImage.data.dtype as ZarrDataType;
  const dims = extractDimensions(multiscales);
  const bpe = bytesPerElement(dtype);
  const tiffDtype = zarrToTiffDtype(dtype);

  // Generate OME-XML for the first IFD
  const omeXml = buildOmeXml(multiscales, dtype, {
    dimensionOrder,
    creator: options.creator,
    imageName: options.imageName,
  });

  // Build a pseudo OmePixels for IFD index computation
  const pixels: OmePixels = {
    dimensionOrder: dimensionOrder as OmePixels["dimensionOrder"],
    type: "",
    sizeX: dims.sizeX,
    sizeY: dims.sizeY,
    sizeZ: dims.sizeZ,
    sizeC: dims.sizeC,
    sizeT: dims.sizeT,
    bigEndian: false,
    interleaved: false,
    channels: [],
  };

  const totalPlanes = dims.sizeC * dims.sizeZ * dims.sizeT;
  const numLevels = multiscales.images.length;

  // Iterate planes in DimensionOrder order and build main IFDs
  const mainIfds: WritableIfd[] = [];

  for (let ifdIdx = 0; ifdIdx < totalPlanes; ifdIdx++) {
    // Find the (c, z, t) that maps to this IFD index
    const { c, z, t } = ifdIndexToPlane(ifdIdx, dims, dimensionOrder);

    // Read pixel data for full-resolution plane
    const stripData = await readPlane(fullResImage, dims, c, z, t, bpe);

    // Build tags
    const isFirst = ifdIdx === 0;
    const tags = makeImageTags(
      dims.sizeX,
      dims.sizeY,
      tiffDtype.bitsPerSample,
      tiffDtype.sampleFormat,
      "none", // compression handled by buildTiff
      isFirst ? omeXml : undefined,
      false,
    );

    // Build SubIFDs for pyramid levels (if any)
    const subIfds: WritableIfd[] = [];
    for (let level = 1; level < numLevels; level++) {
      const subImage = multiscales.images[level];
      const subDims = extractLevelDimensions(subImage, dims);
      const subStripData = await readPlane(subImage, subDims, c, z, t, bpe);

      const subTags = makeImageTags(
        subDims.sizeX,
        subDims.sizeY,
        tiffDtype.bitsPerSample,
        tiffDtype.sampleFormat,
        "none", // compression handled by buildTiff
        undefined,
        true, // isSubResolution
      );

      subIfds.push({ tags: subTags, strips: [subStripData] });
    }

    mainIfds.push({
      tags,
      strips: [stripData],
      subIfds: subIfds.length > 0 ? subIfds : undefined,
    });
  }

  return buildTiff(mainIfds, { compression, compressionLevel });
}

// ── Internal helpers ────────────────────────────────────────────────

/**
 * Map a linear IFD index back to (c, z, t) based on DimensionOrder.
 * This is the inverse of getIfdIndex.
 */
function ifdIndexToPlane(
  ifdIdx: number,
  dims: DimensionInfo,
  dimensionOrder: string,
): { c: number; z: number; t: number } {
  const { sizeC, sizeZ, sizeT } = dims;

  // The DimensionOrder string is XYNNN where NNN are the three varying dims
  // from fastest to slowest (after XY which are always the plane dimensions).
  // e.g. "XYZCT" means Z varies fastest, then C, then T.
  const order = dimensionOrder.slice(2); // e.g. "ZCT"

  // Sizes and names in fastest-to-slowest order
  const sizeMap: Record<string, number> = { Z: sizeZ, C: sizeC, T: sizeT };
  const sizes = [sizeMap[order[0]], sizeMap[order[1]], sizeMap[order[2]]];

  // Decompose ifdIdx: idx = d0 + sizes[0] * (d1 + sizes[1] * d2)
  const d0 = ifdIdx % sizes[0];
  const d1 = Math.floor(ifdIdx / sizes[0]) % sizes[1];
  const d2 = Math.floor(ifdIdx / (sizes[0] * sizes[1]));

  const result: Record<string, number> = {};
  result[order[0]] = d0;
  result[order[1]] = d1;
  result[order[2]] = d2;

  return {
    c: result["C"] ?? 0,
    z: result["Z"] ?? 0,
    t: result["T"] ?? 0,
  };
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
): Promise<Uint8Array> {
  const dimNames = image.dims;
  const shape = image.data.shape;

  // Build selection: scalar indices for t, c, z; null for y, x
  const selection: (number | null)[] = [];
  for (let i = 0; i < dimNames.length; i++) {
    switch (dimNames[i]) {
      case "t":
        selection.push(Math.min(t, shape[i] - 1));
        break;
      case "c":
        selection.push(Math.min(c, shape[i] - 1));
        break;
      case "z":
        selection.push(Math.min(z, shape[i] - 1));
        break;
      default:
        // y, x — take all
        selection.push(null);
        break;
    }
  }

  const result = await zarr.get(image.data, selection as any);
  const typedArray = (result as any).data as
    | Uint8Array
    | Int8Array
    | Uint16Array
    | Int16Array
    | Uint32Array
    | Int32Array
    | Float32Array
    | Float64Array;

  // Convert to raw bytes (little-endian)
  return new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
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
  const shape = image.data.shape;
  const dimNames = image.dims;

  let sizeX = fullDims.sizeX;
  let sizeY = fullDims.sizeY;

  for (let i = 0; i < dimNames.length; i++) {
    if (dimNames[i] === "x") sizeX = shape[i];
    if (dimNames[i] === "y") sizeY = shape[i];
  }

  return {
    ...fullDims,
    sizeX,
    sizeY,
  };
}
