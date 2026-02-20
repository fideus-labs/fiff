// SPDX-FileCopyrightText: Copyright (c) Fideus Labs LLC
// SPDX-License-Identifier: MIT

/**
 * Low-level TIFF binary builder.
 *
 * Assembles IFD entries, tag values, tile/strip data, and SubIFD chains into
 * a valid TIFF file (little-endian). Supports both classic TIFF (32-bit
 * offsets, magic 42) and BigTIFF (64-bit offsets, magic 43).
 *
 * Features:
 *   - Tiled output (default 256x256, configurable)
 *   - Deflate compression via CompressionStream (async, non-blocking)
 *     with synchronous fflate fallback
 *   - Automatic BigTIFF when offsets exceed 4 GB
 *   - Compress-and-release: tiles are compressed eagerly, uncompressed
 *     data is released immediately to minimise peak memory
 *
 * Layout strategy (two-pass):
 *   Pass 1: Compress tiles, resolve tags, compute sizes and offsets.
 *   Pass 2: Write into a pre-allocated ArrayBuffer.
 *
 * File layout:
 *   [Header 8 or 16 bytes]
 *   [Main IFD 0 entries + overflow data + tile data]
 *     [SubIFD 0,0 ...]
 *     [SubIFD 0,1 ...]
 *   [Main IFD 1 entries + overflow data + tile data]
 *   ...
 */

import { zlibSync } from "fflate";
import { compressTilesOnPool, type DeflatePool } from "./worker-utils.js";

// ── TIFF constants ──────────────────────────────────────────────────

/** TIFF tag data types and their byte sizes. */
export const TIFF_TYPE_BYTE = 1; // 1 byte
export const TIFF_TYPE_ASCII = 2; // 1 byte (null-terminated)
export const TIFF_TYPE_SHORT = 3; // 2 bytes
export const TIFF_TYPE_LONG = 4; // 4 bytes
export const TIFF_TYPE_RATIONAL = 5; // 8 bytes (two LONGs)
export const TIFF_TYPE_LONG8 = 16; // 8 bytes (BigTIFF only)

const TYPE_SIZES: Record<number, number> = {
  [TIFF_TYPE_BYTE]: 1,
  [TIFF_TYPE_ASCII]: 1,
  [TIFF_TYPE_SHORT]: 2,
  [TIFF_TYPE_LONG]: 4,
  [TIFF_TYPE_RATIONAL]: 8,
  [TIFF_TYPE_LONG8]: 8,
};

/** Well-known TIFF tags. */
export const TAG_NEW_SUBFILE_TYPE = 254;
export const TAG_IMAGE_WIDTH = 256;
export const TAG_IMAGE_LENGTH = 257;
export const TAG_BITS_PER_SAMPLE = 258;
export const TAG_COMPRESSION = 259;
export const TAG_PHOTOMETRIC = 262;
export const TAG_IMAGE_DESCRIPTION = 270;
export const TAG_STRIP_OFFSETS = 273;
export const TAG_SAMPLES_PER_PIXEL = 277;
export const TAG_ROWS_PER_STRIP = 278;
export const TAG_STRIP_BYTE_COUNTS = 279;
export const TAG_PLANAR_CONFIGURATION = 284;
export const TAG_TILE_WIDTH = 322;
export const TAG_TILE_LENGTH = 323;
export const TAG_TILE_OFFSETS = 324;
export const TAG_TILE_BYTE_COUNTS = 325;
export const TAG_SUB_IFDS = 330;
export const TAG_SAMPLE_FORMAT = 339;

/** TIFF compression codes. */
export const COMPRESSION_NONE = 1;
export const COMPRESSION_DEFLATE = 8;

/** Default tile size (OME-TIFF convention). Must be a multiple of 16. */
export const DEFAULT_TILE_SIZE = 256;

// ── Public types ────────────────────────────────────────────────────

/** A single TIFF tag entry. */
export interface TiffTag {
  /** TIFF tag number (e.g. 256 for ImageWidth). */
  tag: number;
  /** TIFF data type (e.g. TIFF_TYPE_SHORT = 3). */
  type: number;
  /** Tag values. For ASCII tags, pass a string. */
  values: number[] | string;
}

/** Describes one IFD (image) to be written. */
export interface WritableIfd {
  /** Tags for this IFD (excluding offset/bytecount tags — those are auto-generated). */
  tags: TiffTag[];
  /**
   * Raw pixel data tiles. Each entry is one tile (row-major, left-to-right
   * then top-to-bottom). For strip-based images, this is a single entry
   * containing the entire plane.
   */
  tiles: Uint8Array[];
  /** Optional SubIFDs attached to this IFD (for pyramid sub-resolutions). */
  subIfds?: WritableIfd[];
}

/** Options for buildTiff. */
export interface BuildTiffOptions {
  /** Compression to apply to tile data before writing. Default: "none". */
  compression?: "none" | "deflate";
  /** Deflate compression level (1-9). Default: 6. */
  compressionLevel?: number;
  /**
   * TIFF format to use.
   * - "auto": Use classic TIFF when possible, BigTIFF when file exceeds 4 GB.
   * - "classic": Force classic TIFF (32-bit offsets). Fails if file > 4 GB.
   * - "bigtiff": Force BigTIFF (64-bit offsets).
   * Default: "auto".
   */
  format?: "auto" | "classic" | "bigtiff";
  /**
   * Optional worker pool for offloading deflate compression to Web Workers.
   *
   * When provided and compression is "deflate" with the default level (6),
   * tile compression uses CompressionStream on pool workers — releasing the
   * main thread entirely.
   *
   * When not provided (or for non-default compression levels), falls back
   * to the existing main-thread path (CompressionStream -> fflate).
   *
   * Accepts any object matching the `DeflatePool` interface from
   * `@fideus-labs/worker-pool`.
   */
  pool?: import("./worker-utils.js").DeflatePool;
  /** Custom worker script URL. Only used when `pool` is provided. */
  workerUrl?: string;
}

// ── Internal types ──────────────────────────────────────────────────

/** Resolved tag with computed byte representation. */
interface ResolvedTag {
  tag: number;
  type: number;
  count: number;
  /** Serialized value bytes (may be <= inlineThreshold for inline, or larger for overflow). */
  valueBytes: Uint8Array;
}

/** An IFD with all offsets computed, ready to write. */
interface PlacedIfd {
  /** Absolute byte offset of this IFD in the file. */
  ifdOffset: number;
  /** Resolved tags (sorted by tag number). */
  tags: ResolvedTag[];
  /** Absolute byte offset where overflow data starts. */
  overflowOffset: number;
  /** Total bytes of overflow data. */
  overflowSize: number;
  /** Absolute byte offset where tile data starts. */
  tileDataOffset: number;
  /** Tile byte arrays. */
  tiles: Uint8Array[];
  /** SubIFD placed entries (if any). */
  subIfds: PlacedIfd[];
  /** Absolute byte offset of the next IFD (0 if last in chain). */
  nextIfdOffset: number;
}

/**
 * Format-dependent parameters for classic vs BigTIFF.
 */
interface TiffFormat {
  readonly headerSize: number;
  readonly ifdEntrySize: number; // 12 for classic, 20 for BigTIFF
  readonly offsetSize: number; // 4 for classic, 8 for BigTIFF
  readonly inlineThreshold: number; // max bytes that fit in value/offset field
  /** TIFF type to use for offset arrays (LONG or LONG8). */
  readonly offsetType: number;
  readonly magic: number; // 42 or 43
}

const CLASSIC_FORMAT: TiffFormat = {
  headerSize: 8,
  ifdEntrySize: 12,
  offsetSize: 4,
  inlineThreshold: 4,
  offsetType: TIFF_TYPE_LONG,
  magic: 42,
};

const BIGTIFF_FORMAT: TiffFormat = {
  headerSize: 16,
  ifdEntrySize: 20,
  offsetSize: 8,
  inlineThreshold: 8,
  offsetType: TIFF_TYPE_LONG8,
  magic: 43,
};

// ── Public API ──────────────────────────────────────────────────────

/**
 * Build a complete TIFF file from a list of IFDs.
 *
 * Tiles are compressed (if requested) eagerly and in parallel where
 * possible. The uncompressed data is released after compression to
 * minimise peak memory usage.
 *
 * @param ifds - Main IFD chain (linked via next-IFD pointers).
 * @param options - Build options (compression, format, etc.).
 * @returns A complete TIFF file as an ArrayBuffer.
 */
export async function buildTiff(
  ifds: WritableIfd[],
  options: BuildTiffOptions = {},
): Promise<ArrayBuffer> {
  const compression = options.compression ?? "none";
  const compressionLevel = options.compressionLevel ?? 6;
  const formatOpt = options.format ?? "auto";
  const pool = options.pool;
  const workerUrl = options.workerUrl;

  // Phase 1: Compress tiles eagerly (compress-and-release)
  const processedIfds = await Promise.all(
    ifds.map((ifd) => processIfdAsync(ifd, compression, compressionLevel, pool, workerUrl)),
  );

  // Phase 2: Determine format (auto-detect BigTIFF if needed)
  const rawSize = estimateRawSize(processedIfds);
  let fmt: TiffFormat;
  if (formatOpt === "bigtiff") {
    fmt = BIGTIFF_FORMAT;
  } else if (formatOpt === "classic") {
    fmt = CLASSIC_FORMAT;
    if (rawSize > 0xffff_fffe) {
      throw new Error(
        `File size (~${(rawSize / 1e9).toFixed(1)} GB) exceeds classic TIFF 4 GB limit. ` +
        `Use format: "auto" or "bigtiff".`,
      );
    }
  } else {
    // auto: use BigTIFF if estimated size > 3.9 GB (conservative)
    fmt = rawSize > 3.9e9 ? BIGTIFF_FORMAT : CLASSIC_FORMAT;
  }

  // Phase 3: Compute sizes and place all IFDs
  const placed = placeIfds(processedIfds, fmt);

  // Phase 4: Compute total file size
  const totalSize = computeTotalSize(placed, fmt);

  // Phase 5: Write into buffer
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);

  writeHeader(view, fmt, placed.length > 0 ? placed[0].ifdOffset : 0);

  for (const p of placed) {
    writeIfd(view, buffer, p, fmt);
  }

  return buffer;
}

/**
 * Compress a Uint8Array using deflate (zlib-wrapped, RFC 1950).
 * Compatible with TIFF compression code 8 and geotiff.js's inflate.
 *
 * Prefers the native CompressionStream API (async, non-blocking) when
 * available, falling back to synchronous fflate.zlibSync().
 */
export async function compressDeflateAsync(
  data: Uint8Array,
  level: number = 6,
): Promise<Uint8Array> {
  // CompressionStream("deflate") produces zlib-wrapped output (RFC 1950),
  // which is what TIFF code 8 expects and what geotiff.js decompresses.
  // However, CompressionStream doesn't support compression level, so we
  // only use it for the default level to avoid surprising behaviour.
  // For non-default levels, we fall back to fflate.
  if (
    typeof globalThis.CompressionStream !== "undefined" &&
    level === 6
  ) {
    const stream = new CompressionStream("deflate");
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();

    // Write and close
    writer.write(data as unknown as BufferSource);
    writer.close();

    // Collect chunks
    const chunks: Uint8Array[] = [];
    let totalLen = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalLen += value.length;
    }

    // Concatenate
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  return compressDeflate(data, level);
}

/**
 * Compress a Uint8Array using deflate (zlib-wrapped, RFC 1950) synchronously.
 * Compatible with TIFF compression code 8 and geotiff.js's inflate.
 */
export function compressDeflate(
  data: Uint8Array,
  level: number = 6,
): Uint8Array {
  return zlibSync(data, { level: level as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 });
}

// ── Internal helpers ────────────────────────────────────────────────

/**
 * Process an IFD: compress tiles if needed, add compression tag,
 * and recursively process SubIFDs. Async for CompressionStream support.
 *
 * This is the "compress-and-release" step: after compression, the
 * original uncompressed tile data can be GC'd.
 *
 * When a `pool` is provided and the compression level is the default (6),
 * tiles are compressed on Web Workers via CompressionStream, fully
 * releasing the main thread. Otherwise falls back to the main-thread
 * path (CompressionStream -> fflate).
 */
async function processIfdAsync(
  ifd: WritableIfd,
  compression: "none" | "deflate",
  level: number,
  pool?: DeflatePool,
  workerUrl?: string,
): Promise<WritableIfd> {
  let tiles = ifd.tiles;
  const tags = [...ifd.tags];

  if (compression === "deflate") {
    if (pool && level === 6) {
      // Offload compression to worker pool (CompressionStream on workers)
      tiles = await compressTilesOnPool(tiles, pool, workerUrl);
    } else {
      // Main-thread path: CompressionStream (async) -> fflate (sync fallback)
      tiles = await Promise.all(
        tiles.map((t) => compressDeflateAsync(t, level)),
      );
    }
    // Replace or add Compression tag
    const compIdx = tags.findIndex((t) => t.tag === TAG_COMPRESSION);
    if (compIdx >= 0) {
      tags[compIdx] = { tag: TAG_COMPRESSION, type: TIFF_TYPE_SHORT, values: [COMPRESSION_DEFLATE] };
    } else {
      tags.push({ tag: TAG_COMPRESSION, type: TIFF_TYPE_SHORT, values: [COMPRESSION_DEFLATE] });
    }
  }

  const subIfds = ifd.subIfds
    ? await Promise.all(ifd.subIfds.map((sub) => processIfdAsync(sub, compression, level, pool, workerUrl)))
    : undefined;

  return { tags, tiles, subIfds };
}

/**
 * Estimate raw file size (sum of all tile data + overhead per IFD).
 * Used for BigTIFF auto-detection.
 */
function estimateRawSize(ifds: WritableIfd[]): number {
  let size = 16; // BigTIFF header (conservative)
  for (const ifd of ifds) {
    size += 256; // tags overhead estimate
    for (const tile of ifd.tiles) {
      size += tile.length;
    }
    if (ifd.subIfds) {
      size += estimateRawSize(ifd.subIfds);
    }
  }
  return size;
}

/** Write the TIFF file header. */
function writeHeader(view: DataView, fmt: TiffFormat, firstIfdOffset: number): void {
  // Byte order: "II" (little-endian)
  view.setUint16(0, 0x4949, true);

  if (fmt.magic === 42) {
    // Classic TIFF
    view.setUint16(2, 42, true);
    view.setUint32(4, firstIfdOffset, true);
  } else {
    // BigTIFF
    view.setUint16(2, 43, true);
    view.setUint16(4, 8, true); // offset size
    view.setUint16(6, 0, true); // padding
    setBigUint64(view, 8, firstIfdOffset);
  }
}

/** Resolve a TiffTag to its byte representation. */
function resolveTag(tag: TiffTag): ResolvedTag {
  if (typeof tag.values === "string") {
    // ASCII: null-terminated
    const encoder = new TextEncoder();
    const strBytes = encoder.encode(tag.values);
    const valueBytes = new Uint8Array(strBytes.length + 1); // +1 for null terminator
    valueBytes.set(strBytes);
    valueBytes[strBytes.length] = 0;
    return { tag: tag.tag, type: TIFF_TYPE_ASCII, count: valueBytes.length, valueBytes };
  }

  const typeSize = TYPE_SIZES[tag.type];
  if (!typeSize) {
    throw new Error(`Unknown TIFF type: ${tag.type}`);
  }

  const count = tag.type === TIFF_TYPE_RATIONAL ? tag.values.length / 2 : tag.values.length;
  const totalBytes = count * typeSize;
  const valueBytes = new Uint8Array(totalBytes);
  const dv = new DataView(valueBytes.buffer, valueBytes.byteOffset, valueBytes.byteLength);

  for (let i = 0; i < tag.values.length; i++) {
    switch (tag.type) {
      case TIFF_TYPE_BYTE:
        dv.setUint8(i, tag.values[i]);
        break;
      case TIFF_TYPE_SHORT:
        dv.setUint16(i * 2, tag.values[i], true);
        break;
      case TIFF_TYPE_LONG:
        dv.setUint32(i * 4, tag.values[i], true);
        break;
      case TIFF_TYPE_LONG8:
        setBigUint64(dv, i * 8, tag.values[i]);
        break;
      case TIFF_TYPE_RATIONAL:
        // Rationals are stored as two LONGs (numerator, denominator)
        dv.setUint32(i * 4, tag.values[i], true);
        break;
    }
  }

  return { tag: tag.tag, type: tag.type, count, valueBytes };
}

/**
 * Compute the byte size of an IFD entry block.
 * Classic: 2 + 12*N + 4
 * BigTIFF: 8 + 20*N + 8
 */
function ifdEntryBlockSize(numTags: number, fmt: TiffFormat): number {
  if (fmt.magic === 42) {
    return 2 + numTags * 12 + 4;
  }
  // BigTIFF: 8 bytes entry count + 20 bytes per entry + 8 bytes next offset
  return 8 + numTags * 20 + 8;
}

/** Compute overflow size for resolved tags (values that don't fit inline). */
function overflowSize(tags: ResolvedTag[], fmt: TiffFormat): number {
  let size = 0;
  for (const t of tags) {
    if (t.valueBytes.length > fmt.inlineThreshold) {
      size += t.valueBytes.length;
      // Pad to word boundary (2-byte alignment)
      if (t.valueBytes.length % 2 !== 0) size += 1;
    }
  }
  return size;
}

/** Compute total tile data size. */
function totalTileSize(tiles: Uint8Array[]): number {
  return tiles.reduce((sum, t) => sum + t.length, 0);
}

/**
 * Place all IFDs sequentially, computing absolute offsets.
 * Returns a flat list of PlacedIfds (main chain first, then SubIFDs interleaved).
 */
function placeIfds(ifds: WritableIfd[], fmt: TiffFormat): PlacedIfd[] {
  const allPlaced: PlacedIfd[] = [];

  interface IfdInfo {
    tags: ResolvedTag[];
    tiles: Uint8Array[];
    subIfdInfos: IfdInfo[];
    entryBlockSize: number;
    overflow: number;
    tileSize: number;
    placed?: PlacedIfd;
  }

  function resolveIfdInfo(ifd: WritableIfd): IfdInfo {
    const userTags = ifd.tags.map(resolveTag);

    // Determine if this is tiled or stripped based on tags
    const hasTileWidth = ifd.tags.some((t) => t.tag === TAG_TILE_WIDTH);

    // Add offset and byte-count tags as placeholders
    const offsetTag = hasTileWidth ? TAG_TILE_OFFSETS : TAG_STRIP_OFFSETS;
    const countTag = hasTileWidth ? TAG_TILE_BYTE_COUNTS : TAG_STRIP_BYTE_COUNTS;

    const tileOffsetsTag: ResolvedTag = {
      tag: offsetTag,
      type: fmt.offsetType,
      count: ifd.tiles.length,
      valueBytes: new Uint8Array(ifd.tiles.length * fmt.offsetSize),
    };

    const tileByteCountsBytes = new Uint8Array(ifd.tiles.length * fmt.offsetSize);
    const tbcView = new DataView(tileByteCountsBytes.buffer);
    for (let i = 0; i < ifd.tiles.length; i++) {
      if (fmt.offsetSize === 8) {
        setBigUint64(tbcView, i * 8, ifd.tiles[i].length);
      } else {
        tbcView.setUint32(i * 4, ifd.tiles[i].length, true);
      }
    }
    const tileByteCountsTag: ResolvedTag = {
      tag: countTag,
      type: fmt.offsetType,
      count: ifd.tiles.length,
      valueBytes: tileByteCountsBytes,
    };

    const allTags = [...userTags, tileOffsetsTag, tileByteCountsTag];

    // Add SubIFDs tag if there are SubIFDs
    const subIfdInfos = (ifd.subIfds ?? []).map(resolveIfdInfo);
    if (subIfdInfos.length > 0) {
      const subIfdsTag: ResolvedTag = {
        tag: TAG_SUB_IFDS,
        type: fmt.offsetType,
        count: subIfdInfos.length,
        valueBytes: new Uint8Array(subIfdInfos.length * fmt.offsetSize),
      };
      allTags.push(subIfdsTag);
    }

    // Sort by tag number (TIFF spec requires this)
    allTags.sort((a, b) => a.tag - b.tag);

    return {
      tags: allTags,
      tiles: ifd.tiles,
      subIfdInfos,
      entryBlockSize: ifdEntryBlockSize(allTags.length, fmt),
      overflow: overflowSize(allTags, fmt),
      tileSize: totalTileSize(ifd.tiles),
    };
  }

  const mainInfos = ifds.map(resolveIfdInfo);

  // Place IFDs sequentially
  let cursor = fmt.headerSize;

  function placeIfdInfo(info: IfdInfo): PlacedIfd {
    const ifdOffset = cursor;
    cursor += info.entryBlockSize;

    const overflowOffset = cursor;
    cursor += info.overflow;

    const tileDataOffset = cursor;
    cursor += info.tileSize;

    const placed: PlacedIfd = {
      ifdOffset,
      tags: info.tags,
      overflowOffset,
      overflowSize: info.overflow,
      tileDataOffset,
      tiles: info.tiles,
      subIfds: [],
      nextIfdOffset: 0,
    };

    info.placed = placed;
    allPlaced.push(placed);

    // Place SubIFDs immediately after this IFD's tile data
    for (const subInfo of info.subIfdInfos) {
      placed.subIfds.push(placeIfdInfo(subInfo));
    }

    return placed;
  }

  const mainPlaced: PlacedIfd[] = [];
  for (let i = 0; i < mainInfos.length; i++) {
    mainPlaced.push(placeIfdInfo(mainInfos[i]));
  }

  // Link main chain next-IFD pointers
  for (let i = 0; i < mainPlaced.length - 1; i++) {
    mainPlaced[i].nextIfdOffset = mainPlaced[i + 1].ifdOffset;
  }

  return allPlaced;
}

/** Compute total file size from placed IFDs. */
function computeTotalSize(placed: PlacedIfd[], fmt: TiffFormat): number {
  if (placed.length === 0) return fmt.headerSize;
  let maxEnd = fmt.headerSize;
  for (const p of placed) {
    const end = p.tileDataOffset + totalTileSize(p.tiles);
    if (end > maxEnd) maxEnd = end;
  }
  return maxEnd;
}

/** Write a single placed IFD into the buffer. */
function writeIfd(view: DataView, buffer: ArrayBuffer, placed: PlacedIfd, fmt: TiffFormat): void {
  let pos = placed.ifdOffset;
  const isBig = fmt.magic === 43;

  // Write entry count
  if (isBig) {
    setBigUint64(view, pos, placed.tags.length);
    pos += 8;
  } else {
    view.setUint16(pos, placed.tags.length, true);
    pos += 2;
  }

  // Compute tile offsets for this IFD
  const tileOffsets: number[] = [];
  let tileCursor = placed.tileDataOffset;
  for (const tile of placed.tiles) {
    tileOffsets.push(tileCursor);
    tileCursor += tile.length;
  }

  // Compute SubIFD offsets
  const subIfdOffsets = placed.subIfds.map((s) => s.ifdOffset);

  // Track overflow cursor
  let overflowCursor = placed.overflowOffset;

  // Determine which offset/bytecount tag numbers are in play
  const isOffsetTag = (t: number) =>
    t === TAG_TILE_OFFSETS || t === TAG_STRIP_OFFSETS;
  const isByteCountTag = (t: number) =>
    t === TAG_TILE_BYTE_COUNTS || t === TAG_STRIP_BYTE_COUNTS;

  // Write each tag entry
  for (const tag of placed.tags) {
    if (isBig) {
      view.setUint16(pos, tag.tag, true);
      view.setUint16(pos + 2, tag.type, true);
      setBigUint64(view, pos + 4, tag.count);
    } else {
      view.setUint16(pos, tag.tag, true);
      view.setUint16(pos + 2, tag.type, true);
      view.setUint32(pos + 4, tag.count, true);
    }

    const valueFieldOffset = isBig ? pos + 12 : pos + 8;

    // Determine the value bytes to write
    let valueBytes = tag.valueBytes;

    // Patch offset tags
    if (isOffsetTag(tag.tag)) {
      valueBytes = new Uint8Array(tileOffsets.length * fmt.offsetSize);
      const dv = new DataView(valueBytes.buffer, valueBytes.byteOffset, valueBytes.byteLength);
      for (let i = 0; i < tileOffsets.length; i++) {
        if (fmt.offsetSize === 8) {
          setBigUint64(dv, i * 8, tileOffsets[i]);
        } else {
          dv.setUint32(i * 4, tileOffsets[i], true);
        }
      }
    }

    // Patch byte count tags — recompute from actual tile sizes
    if (isByteCountTag(tag.tag)) {
      valueBytes = new Uint8Array(placed.tiles.length * fmt.offsetSize);
      const dv = new DataView(valueBytes.buffer, valueBytes.byteOffset, valueBytes.byteLength);
      for (let i = 0; i < placed.tiles.length; i++) {
        if (fmt.offsetSize === 8) {
          setBigUint64(dv, i * 8, placed.tiles[i].length);
        } else {
          dv.setUint32(i * 4, placed.tiles[i].length, true);
        }
      }
    }

    // Patch SubIFDs offsets
    if (tag.tag === TAG_SUB_IFDS && subIfdOffsets.length > 0) {
      valueBytes = new Uint8Array(subIfdOffsets.length * fmt.offsetSize);
      const dv = new DataView(valueBytes.buffer, valueBytes.byteOffset, valueBytes.byteLength);
      for (let i = 0; i < subIfdOffsets.length; i++) {
        if (fmt.offsetSize === 8) {
          setBigUint64(dv, i * 8, subIfdOffsets[i]);
        } else {
          dv.setUint32(i * 4, subIfdOffsets[i], true);
        }
      }
    }

    if (valueBytes.length <= fmt.inlineThreshold) {
      // Inline: write value bytes directly in the value/offset field
      const dest = new Uint8Array(buffer, valueFieldOffset, fmt.inlineThreshold);
      dest.fill(0);
      dest.set(valueBytes);
    } else {
      // Overflow: write offset to overflow area, then write bytes there
      if (fmt.offsetSize === 8) {
        setBigUint64(view, valueFieldOffset, overflowCursor);
      } else {
        view.setUint32(valueFieldOffset, overflowCursor, true);
      }
      const dest = new Uint8Array(buffer, overflowCursor, valueBytes.length);
      dest.set(valueBytes);
      overflowCursor += valueBytes.length;
      // Pad to word boundary
      if (valueBytes.length % 2 !== 0) overflowCursor += 1;
    }

    pos += fmt.ifdEntrySize;
  }

  // Write next IFD offset
  if (isBig) {
    setBigUint64(view, pos, placed.nextIfdOffset);
  } else {
    view.setUint32(pos, placed.nextIfdOffset, true);
  }

  // Write tile data
  let tilePos = placed.tileDataOffset;
  for (const tile of placed.tiles) {
    const dest = new Uint8Array(buffer, tilePos, tile.length);
    dest.set(tile);
    tilePos += tile.length;
  }
}

// ── Convenience helpers for building IFD tags ───────────────────────

/**
 * Create a standard set of tags for a tiled grayscale image plane.
 *
 * @param width - Image width in pixels.
 * @param height - Image height in pixels.
 * @param bitsPerSample - Bits per sample (8, 16, 32, 64).
 * @param sampleFormat - TIFF SampleFormat (1=uint, 2=int, 3=float).
 * @param compression - Compression type. Default: "none".
 * @param imageDescription - Optional OME-XML string for the first IFD.
 * @param isSubResolution - Whether this is a SubIFD (sets NewSubfileType=1).
 * @param tileSize - Tile width and height. Default: 256. Use 0 for strip-based.
 */
export function makeImageTags(
  width: number,
  height: number,
  bitsPerSample: number,
  sampleFormat: number,
  compression: "none" | "deflate" = "none",
  imageDescription?: string,
  isSubResolution?: boolean,
  tileSize: number = DEFAULT_TILE_SIZE,
): TiffTag[] {
  const tags: TiffTag[] = [];

  if (isSubResolution) {
    tags.push({ tag: TAG_NEW_SUBFILE_TYPE, type: TIFF_TYPE_LONG, values: [1] });
  }

  tags.push({ tag: TAG_IMAGE_WIDTH, type: TIFF_TYPE_LONG, values: [width] });
  tags.push({ tag: TAG_IMAGE_LENGTH, type: TIFF_TYPE_LONG, values: [height] });
  tags.push({ tag: TAG_BITS_PER_SAMPLE, type: TIFF_TYPE_SHORT, values: [bitsPerSample] });
  tags.push({
    tag: TAG_COMPRESSION,
    type: TIFF_TYPE_SHORT,
    values: [compression === "deflate" ? COMPRESSION_DEFLATE : COMPRESSION_NONE],
  });
  tags.push({ tag: TAG_PHOTOMETRIC, type: TIFF_TYPE_SHORT, values: [1] }); // MinIsBlack
  tags.push({ tag: TAG_SAMPLES_PER_PIXEL, type: TIFF_TYPE_SHORT, values: [1] });
  tags.push({ tag: TAG_PLANAR_CONFIGURATION, type: TIFF_TYPE_SHORT, values: [1] }); // chunky
  tags.push({ tag: TAG_SAMPLE_FORMAT, type: TIFF_TYPE_SHORT, values: [sampleFormat] });

  if (tileSize > 0 && (width > tileSize || height > tileSize)) {
    // Tiled layout
    tags.push({ tag: TAG_TILE_WIDTH, type: TIFF_TYPE_LONG, values: [tileSize] });
    tags.push({ tag: TAG_TILE_LENGTH, type: TIFF_TYPE_LONG, values: [tileSize] });
  } else {
    // Strip layout (single strip = entire plane) for small images
    tags.push({ tag: TAG_ROWS_PER_STRIP, type: TIFF_TYPE_LONG, values: [height] });
  }

  if (imageDescription) {
    tags.push({ tag: TAG_IMAGE_DESCRIPTION, type: TIFF_TYPE_ASCII, values: imageDescription });
  }

  return tags;
}

/**
 * Slice a 2D pixel plane into tiles suitable for TIFF tiled output.
 *
 * Tiles that extend beyond the image boundary are zero-padded to the
 * full tile size (required by the TIFF spec for tiled images).
 *
 * @param planeBytes - Raw pixel data for the entire plane (row-major, little-endian).
 * @param width - Image width in pixels.
 * @param height - Image height in pixels.
 * @param bytesPerPixel - Bytes per pixel (e.g. 2 for uint16).
 * @param tileW - Tile width in pixels.
 * @param tileH - Tile height in pixels.
 * @returns Array of tile buffers, in row-major tile order (left-to-right, top-to-bottom).
 */
export function sliceTiles(
  planeBytes: Uint8Array,
  width: number,
  height: number,
  bytesPerPixel: number,
  tileW: number,
  tileH: number,
): Uint8Array[] {
  const tilesX = Math.ceil(width / tileW);
  const tilesY = Math.ceil(height / tileH);
  const tiles: Uint8Array[] = [];
  const rowBytes = width * bytesPerPixel;
  const tileRowBytes = tileW * bytesPerPixel;
  const tileBytes = tileW * tileH * bytesPerPixel;

  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const tile = new Uint8Array(tileBytes); // zero-filled (handles padding)
      const startY = ty * tileH;
      const startX = tx * tileW;

      // Number of valid rows/cols in this tile
      const validRows = Math.min(tileH, height - startY);
      const validCols = Math.min(tileW, width - startX);
      const validRowBytes = validCols * bytesPerPixel;

      for (let row = 0; row < validRows; row++) {
        const srcOffset = (startY + row) * rowBytes + startX * bytesPerPixel;
        const dstOffset = row * tileRowBytes;
        tile.set(
          planeBytes.subarray(srcOffset, srcOffset + validRowBytes),
          dstOffset,
        );
      }

      tiles.push(tile);
    }
  }

  return tiles;
}

// ── BigTIFF helpers ─────────────────────────────────────────────────

/**
 * Write a 64-bit unsigned integer to a DataView at the given offset.
 * Uses two 32-bit writes since DataView.setBigUint64 may not be
 * available in all environments.
 */
function setBigUint64(view: DataView, offset: number, value: number): void {
  // Split into low 32 bits and high 32 bits (little-endian)
  const lo = value >>> 0;
  const hi = (value / 0x1_0000_0000) >>> 0;
  view.setUint32(offset, lo, true);
  view.setUint32(offset + 4, hi, true);
}
