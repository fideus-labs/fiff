/**
 * Utility helpers for key parsing, pixel window computation, and
 * general-purpose functions used across the package.
 */

/**
 * Result of parsing a store key.
 */
export interface ParsedKey {
  /** The resolution level (e.g. 0 for full, 1 for 2x downsample). */
  level: number;
  /** Whether this is a zarr.json metadata key. */
  isMetadata: boolean;
  /** Whether this is a root-level zarr.json. */
  isRootMetadata: boolean;
  /** Chunk indices for data keys (e.g. [0, 3, 5] for c=0, y=3, x=5). */
  chunkIndices?: number[];
}

/**
 * Parse a zarr store key into its components.
 *
 * Expected key patterns (Zarr v3 with "/" separator):
 *   "zarr.json"                -> root group metadata
 *   "0/zarr.json"              -> level 0 array metadata
 *   "0/c/0/0/3/5"             -> level 0, chunk at indices [0, 0, 3, 5]
 *
 * @param key - The store key (may or may not have a leading "/").
 * @returns Parsed key information.
 */
export function parseStoreKey(key: string): ParsedKey {
  // Normalize: strip leading "/"
  const normalized = key.startsWith("/") ? key.slice(1) : key;

  // Root metadata
  if (normalized === "zarr.json") {
    return { level: -1, isMetadata: true, isRootMetadata: true };
  }

  const parts = normalized.split("/");

  // Level metadata: "{level}/zarr.json"
  if (parts.length === 2 && parts[1] === "zarr.json") {
    const level = parseInt(parts[0], 10);
    if (isNaN(level)) {
      return { level: -1, isMetadata: false, isRootMetadata: false };
    }
    return { level, isMetadata: true, isRootMetadata: false };
  }

  // Chunk data: "{level}/c/{indices...}"
  // In Zarr v3 with default chunk_key_encoding (separator="/"),
  // chunk keys look like: "{level}/c/{i0}/{i1}/..."
  if (parts.length >= 3 && parts[1] === "c") {
    const level = parseInt(parts[0], 10);
    if (isNaN(level)) {
      return { level: -1, isMetadata: false, isRootMetadata: false };
    }
    const chunkIndices = parts.slice(2).map((p) => parseInt(p, 10));
    if (chunkIndices.some(isNaN)) {
      return { level: -1, isMetadata: false, isRootMetadata: false };
    }
    return { level, isMetadata: false, isRootMetadata: false, chunkIndices };
  }

  // Unknown key
  return { level: -1, isMetadata: false, isRootMetadata: false };
}

/**
 * Compute the pixel window for a chunk within an image.
 *
 * @param chunkX - The x chunk index.
 * @param chunkY - The y chunk index.
 * @param chunkWidth - The width of each chunk in pixels.
 * @param chunkHeight - The height of each chunk in pixels.
 * @param imageWidth - The total image width in pixels.
 * @param imageHeight - The total image height in pixels.
 * @returns The pixel window [left, top, right, bottom] for geotiff readRasters.
 */
export function computePixelWindow(
  chunkX: number,
  chunkY: number,
  chunkWidth: number,
  chunkHeight: number,
  imageWidth: number,
  imageHeight: number,
): [number, number, number, number] {
  const left = chunkX * chunkWidth;
  const top = chunkY * chunkHeight;
  const right = Math.min(left + chunkWidth, imageWidth);
  const bottom = Math.min(top + chunkHeight, imageHeight);
  return [left, top, right, bottom];
}

/**
 * Encode a TypedArray as raw little-endian bytes (Uint8Array).
 * geotiff.js returns platform-endian typed arrays, and modern systems
 * are little-endian which matches Zarr's default byte order.
 *
 * For edge chunks that don't fill the full chunk shape, the data is
 * padded with the fill value (0) to the full chunk size.
 */
export function encodeChunkBytes(
  data: ArrayBufferView,
  expectedElements: number,
  bytesPerElement: number,
): Uint8Array {
  const actualElements =
    data.byteLength / bytesPerElement;

  if (actualElements === expectedElements) {
    // Fast path: data matches expected size exactly
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  // Edge chunk: pad with zeros to fill the expected chunk size
  const outputBytes = expectedElements * bytesPerElement;
  const output = new Uint8Array(outputBytes);
  output.set(
    new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    0,
  );
  return output;
}

/**
 * Compute the number of chunks along each dimension.
 */
export function computeChunkCounts(
  shape: number[],
  chunkShape: number[],
): number[] {
  return shape.map((s, i) => Math.ceil(s / chunkShape[i]));
}

/**
 * Determine a reasonable chunk shape for TIFF tile dimensions.
 * Uses the TIFF's native tile size if available, otherwise defaults.
 */
export function computeChunkShape(
  tileWidth: number,
  tileHeight: number,
  ndim: number,
): number[] {
  // For spatial dimensions use TIFF tile size; for other dims use 1
  // Shape ordering: [t?, c?, z?, y, x]
  const chunks = new Array(ndim).fill(1);
  chunks[ndim - 2] = tileHeight; // y
  chunks[ndim - 1] = tileWidth; // x
  return chunks;
}

/**
 * Return the previous power of 2 that is <= n.
 */
export function prevPowerOf2(n: number): number {
  if (n <= 0) return 1;
  let p = 1;
  while (p * 2 <= n) p *= 2;
  return p;
}
