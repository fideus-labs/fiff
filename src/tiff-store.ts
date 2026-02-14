/**
 * TiffStore: a zarrita.js-compatible AsyncReadable store that presents
 * TIFF files as OME-Zarr v0.5 datasets.
 *
 * Usage:
 *   const store = await TiffStore.fromUrl("https://example.com/image.ome.tif");
 *   const group = await zarr.open(store, { kind: "group" });
 *   // ... use zarrita.js as normal
 */

import { fromUrl, fromArrayBuffer, fromBlob } from "geotiff";
import type GeoTIFF from "geotiff";
import type { GeoTIFFImage } from "geotiff";
import { tiffDtypeToZarr, omePixelTypeToZarr, type ZarrDataType } from "./dtypes.js";
import {
  isOmeXml,
  parseOmeXml,
  type OmeImage,
  type OmePixels,
} from "./ome-xml.js";
import {
  detectPyramid,
  createOmeIndexer,
  createPlainIndexer,
  type PyramidInfo,
  type PlaneSelection,
} from "./ifd-indexer.js";
import { readChunk } from "./chunk-reader.js";
import {
  buildMultiscales,
  buildOmero,
  buildRootGroupJson,
  buildArrayJson,
  buildShape,
  type ZarrGroupMetadata,
  type ZarrArrayMetadata,
  type OmeMultiscale,
  type OmeroMetadata,
} from "./metadata.js";
import { parseStoreKey, computeChunkShape } from "./utils.js";

/** Options for opening a TiffStore. */
export interface TiffStoreOptions {
  /** Pre-computed IFD byte offsets for fast random access. */
  offsets?: number[];
  /** Additional HTTP headers for remote TIFF requests. */
  headers?: Record<string, string>;
}

/**
 * A zarrita.js AsyncReadable store backed by a TIFF file.
 *
 * Implements the zarrita `AsyncReadable` interface:
 *   get(key: string): Promise<Uint8Array | undefined>
 *
 * Keys are routed as follows:
 *   - "zarr.json"           -> root group metadata (OME-Zarr 0.5)
 *   - "{level}/zarr.json"   -> array metadata for resolution level
 *   - "{level}/c/{indices}" -> chunk data (delegates to geotiff.js)
 */
export class TiffStore {
  private tiff: GeoTIFF;
  private omeImages: OmeImage[];
  private pixels: OmePixels | undefined;
  private pyramid: PyramidInfo;
  private dtype: ZarrDataType;
  private dimNames: string[];
  private chunkShapes: number[][];
  private shapes: number[][];
  private multiscale: OmeMultiscale;
  private omero: OmeroMetadata | undefined;
  private indexer: (
    sel: PlaneSelection,
    level: number,
  ) => Promise<GeoTIFFImage>;
  private offsets?: number[];

  // Cached serialized metadata
  private rootJsonBytes: Uint8Array | undefined;
  private arrayJsonCache = new Map<number, Uint8Array>();

  private constructor(
    tiff: GeoTIFF,
    omeImages: OmeImage[],
    pixels: OmePixels | undefined,
    pyramid: PyramidInfo,
    dtype: ZarrDataType,
    dimNames: string[],
    chunkShapes: number[][],
    shapes: number[][],
    multiscale: OmeMultiscale,
    omero: OmeroMetadata | undefined,
    indexer: (sel: PlaneSelection, level: number) => Promise<GeoTIFFImage>,
    offsets?: number[],
  ) {
    this.tiff = tiff;
    this.omeImages = omeImages;
    this.pixels = pixels;
    this.pyramid = pyramid;
    this.dtype = dtype;
    this.dimNames = dimNames;
    this.chunkShapes = chunkShapes;
    this.shapes = shapes;
    this.multiscale = multiscale;
    this.omero = omero;
    this.indexer = indexer;
    this.offsets = offsets;
  }

  /**
   * Open a TiffStore from a remote URL.
   * The TIFF will be accessed via HTTP range requests.
   */
  static async fromUrl(
    url: string,
    options: TiffStoreOptions = {},
  ): Promise<TiffStore> {
    const tiff = await fromUrl(url, { headers: options.headers });
    return TiffStore.fromGeoTIFF(tiff, options);
  }

  /**
   * Open a TiffStore from an in-memory ArrayBuffer.
   */
  static async fromArrayBuffer(
    buffer: ArrayBuffer,
    options: TiffStoreOptions = {},
  ): Promise<TiffStore> {
    const tiff = await fromArrayBuffer(buffer);
    return TiffStore.fromGeoTIFF(tiff, options);
  }

  /**
   * Open a TiffStore from a Blob or File.
   */
  static async fromBlob(
    blob: Blob,
    options: TiffStoreOptions = {},
  ): Promise<TiffStore> {
    const tiff = await fromBlob(blob);
    return TiffStore.fromGeoTIFF(tiff, options);
  }

  /**
   * Open a TiffStore from an already-opened GeoTIFF instance.
   */
  static async fromGeoTIFF(
    tiff: GeoTIFF,
    options: TiffStoreOptions = {},
  ): Promise<TiffStore> {
    const firstImage = await tiff.getImage(0);

    // Try to parse OME-XML from the ImageDescription tag
    let omeImages: OmeImage[] = [];
    let pixels: OmePixels | undefined;
    let imageDescription: string | undefined;

    try {
      imageDescription = firstImage.fileDirectory.getValue("ImageDescription");
    } catch {
      // Tag not available synchronously, try async
      try {
        imageDescription = await firstImage.fileDirectory.loadValue(
          "ImageDescription",
        );
      } catch {
        // No ImageDescription
      }
    }

    if (imageDescription && isOmeXml(imageDescription)) {
      omeImages = parseOmeXml(imageDescription);
      if (omeImages.length > 0) {
        pixels = omeImages[0].pixels;
      }
    }

    // Determine data type
    let dtype: ZarrDataType;
    if (pixels) {
      dtype = omePixelTypeToZarr(pixels.type);
    } else {
      const sampleFormat = firstImage.getSampleFormat() ?? 1;
      const bitsPerSample = firstImage.getBitsPerSample();
      dtype = tiffDtypeToZarr(sampleFormat, bitsPerSample);
    }

    // Detect pyramid structure
    const planesPerImage = pixels
      ? pixels.sizeC * pixels.sizeZ * pixels.sizeT
      : 1;
    const pyramid = await detectPyramid(tiff, omeImages.length, planesPerImage);

    // Build metadata
    const imageName = omeImages[0]?.name;
    const { multiscale, dimNames } = buildMultiscales(
      pixels,
      pyramid,
      imageName,
    );
    const omero = buildOmero(pixels, dtype);

    // Compute shapes and chunk shapes for each level
    const tileWidth = firstImage.getTileWidth();
    const tileHeight = firstImage.getTileHeight();

    const shapes: number[][] = [];
    const chunkShapes: number[][] = [];
    for (let level = 0; level < pyramid.levels; level++) {
      const shape = buildShape(pixels, pyramid, level, dimNames);
      shapes.push(shape);

      // Use the same tile size for all levels, but clamp to actual dimensions
      const levelTileW = Math.min(tileWidth, pyramid.widths[level]);
      const levelTileH = Math.min(tileHeight, pyramid.heights[level]);
      chunkShapes.push(computeChunkShape(levelTileW, levelTileH, dimNames.length));
    }

    // Create the appropriate indexer
    let indexer: (sel: PlaneSelection, level: number) => Promise<GeoTIFFImage>;
    if (pixels) {
      indexer = createOmeIndexer(tiff, pixels, pyramid, 0, options.offsets);
    } else {
      indexer = createPlainIndexer(tiff, options.offsets);
    }

    return new TiffStore(
      tiff,
      omeImages,
      pixels,
      pyramid,
      dtype,
      dimNames,
      chunkShapes,
      shapes,
      multiscale,
      omero,
      indexer,
      options.offsets,
    );
  }

  // ------- AsyncReadable interface -------

  /**
   * Get a value from the store by key.
   *
   * This is the core zarrita.js AsyncReadable interface method.
   */
  async get(key: string): Promise<Uint8Array | undefined> {
    const parsed = parseStoreKey(key);

    // Root group metadata
    if (parsed.isRootMetadata) {
      return this.getRootGroupJson();
    }

    // Array-level metadata
    if (parsed.isMetadata && parsed.level >= 0) {
      return this.getArrayJson(parsed.level);
    }

    // Chunk data
    if (parsed.chunkIndices && parsed.level >= 0) {
      return this.getChunkData(parsed.level, parsed.chunkIndices);
    }

    // Unknown key
    return undefined;
  }

  // ------- Public accessors -------

  /** The number of resolution levels. */
  get levels(): number {
    return this.pyramid.levels;
  }

  /** The Zarr data type string. */
  get dataType(): ZarrDataType {
    return this.dtype;
  }

  /** The OME-XML images (if parsed). */
  get ome(): OmeImage[] {
    return this.omeImages;
  }

  /** The pyramid information. */
  get pyramidInfo(): PyramidInfo {
    return this.pyramid;
  }

  /** Get the shape for a given level. */
  getShape(level: number): number[] {
    return this.shapes[level];
  }

  /** Get the chunk shape for a given level. */
  getChunkShape(level: number): number[] {
    return this.chunkShapes[level];
  }

  /** The dimension names. */
  get dimensionNames(): string[] {
    return this.dimNames;
  }

  // ------- Private methods -------

  private getRootGroupJson(): Uint8Array {
    if (!this.rootJsonBytes) {
      const json = buildRootGroupJson(this.multiscale, this.omero);
      this.rootJsonBytes = encodeJson(json);
    }
    return this.rootJsonBytes;
  }

  private getArrayJson(level: number): Uint8Array | undefined {
    if (level < 0 || level >= this.pyramid.levels) {
      return undefined;
    }

    if (!this.arrayJsonCache.has(level)) {
      const json = buildArrayJson(
        this.shapes[level],
        this.chunkShapes[level],
        this.dtype,
        this.dimNames,
      );
      this.arrayJsonCache.set(level, encodeJson(json));
    }
    return this.arrayJsonCache.get(level);
  }

  private async getChunkData(
    level: number,
    chunkIndices: number[],
  ): Promise<Uint8Array | undefined> {
    if (level < 0 || level >= this.pyramid.levels) {
      return undefined;
    }

    // Map chunk indices to selection + spatial indices
    // Dimension ordering matches dimNames: [t?, c?, z?, y, x]
    const sel = this.indicesToSelection(chunkIndices);
    const shape = this.shapes[level];
    const chunkShape = this.chunkShapes[level];

    // The last two indices are always y, x
    const yIdx = this.dimNames.indexOf("y");
    const xIdx = this.dimNames.indexOf("x");
    const chunkY = chunkIndices[yIdx];
    const chunkX = chunkIndices[xIdx];

    const imageWidth = shape[xIdx];
    const imageHeight = shape[yIdx];
    const chunkWidth = chunkShape[xIdx];
    const chunkHeight = chunkShape[yIdx];

    return readChunk(
      this.indexer,
      sel,
      level,
      chunkY,
      chunkX,
      chunkHeight,
      chunkWidth,
      imageWidth,
      imageHeight,
      this.dtype,
    );
  }

  /**
   * Map chunk indices to a plane selection.
   * Non-spatial dimensions (t, c, z) map directly from chunk indices;
   * spatial dimensions (y, x) are handled separately.
   */
  private indicesToSelection(chunkIndices: number[]): PlaneSelection {
    const sel: PlaneSelection = { c: 0, z: 0, t: 0 };
    for (let i = 0; i < this.dimNames.length; i++) {
      const dim = this.dimNames[i];
      if (dim === "t") sel.t = chunkIndices[i];
      else if (dim === "c") sel.c = chunkIndices[i];
      else if (dim === "z") sel.z = chunkIndices[i];
    }
    return sel;
  }
}

// ---------- internal helpers ----------

function encodeJson(obj: ZarrGroupMetadata | ZarrArrayMetadata): Uint8Array {
  const str = JSON.stringify(obj);
  return new TextEncoder().encode(str);
}
