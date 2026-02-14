// SPDX-FileCopyrightText: Copyright (c) Fideus Labs LLC
// SPDX-License-Identifier: MIT

/**
 * Low-level TIFF binary builder.
 *
 * Assembles IFD entries, tag values, strip data, and SubIFD chains into
 * a valid classic TIFF file (little-endian, magic 42).
 *
 * Layout strategy (two-pass):
 *   Pass 1: Collect all IFDs and pixel data, compute sizes.
 *   Pass 2: Compute offsets and write into a pre-allocated ArrayBuffer.
 *
 * File layout:
 *   [Header 8 bytes]
 *   [Main IFD 0 entries + overflow data + strip data]
 *   [Main IFD 1 entries + overflow data + strip data]
 *   ...
 *   [SubIFD 0,0 entries + overflow data + strip data]
 *   [SubIFD 0,1 entries + overflow data + strip data]
 *   ...
 */

import { deflate } from "pako";

// ── TIFF constants ──────────────────────────────────────────────────

/** TIFF tag data types and their byte sizes. */
export const TIFF_TYPE_BYTE = 1; // 1 byte
export const TIFF_TYPE_ASCII = 2; // 1 byte (null-terminated)
export const TIFF_TYPE_SHORT = 3; // 2 bytes
export const TIFF_TYPE_LONG = 4; // 4 bytes
export const TIFF_TYPE_RATIONAL = 5; // 8 bytes (two LONGs)

const TYPE_SIZES: Record<number, number> = {
  [TIFF_TYPE_BYTE]: 1,
  [TIFF_TYPE_ASCII]: 1,
  [TIFF_TYPE_SHORT]: 2,
  [TIFF_TYPE_LONG]: 4,
  [TIFF_TYPE_RATIONAL]: 8,
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
export const TAG_SAMPLE_FORMAT = 339;
export const TAG_SUB_IFDS = 330;

/** TIFF compression codes. */
export const COMPRESSION_NONE = 1;
export const COMPRESSION_DEFLATE = 8;

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
  /** Tags for this IFD (excluding StripOffsets/StripByteCounts — those are auto-generated). */
  tags: TiffTag[];
  /** Raw (possibly compressed) strip data. Each entry is one strip. */
  strips: Uint8Array[];
  /** Optional SubIFDs attached to this IFD (for pyramid sub-resolutions). */
  subIfds?: WritableIfd[];
}

/** Options for buildTiff. */
export interface BuildTiffOptions {
  /** Compression to apply to strip data before writing. Default: "none". */
  compression?: "none" | "deflate";
  /** Deflate compression level (1-9). Default: 6. */
  compressionLevel?: number;
}

// ── Internal types ──────────────────────────────────────────────────

/** Resolved tag with computed byte representation. */
interface ResolvedTag {
  tag: number;
  type: number;
  count: number;
  /** Serialized value bytes (may be <= 4 bytes for inline, or > 4 for overflow). */
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
  /** Absolute byte offset where strip data starts. */
  stripDataOffset: number;
  /** Strip byte arrays. */
  strips: Uint8Array[];
  /** SubIFD placed entries (if any). */
  subIfds: PlacedIfd[];
  /** Absolute byte offset of the next IFD (0 if last in chain). */
  nextIfdOffset: number;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Build a complete TIFF file from a list of IFDs.
 *
 * @param ifds - Main IFD chain (linked via next-IFD pointers).
 * @param options - Build options (compression, etc.).
 * @returns A complete TIFF file as an ArrayBuffer.
 */
export function buildTiff(
  ifds: WritableIfd[],
  options: BuildTiffOptions = {},
): ArrayBuffer {
  const compression = options.compression ?? "none";
  const compressionLevel = options.compressionLevel ?? 6;

  // Compress strips if needed
  const processedIfds = ifds.map((ifd) => processIfd(ifd, compression, compressionLevel));

  // Pass 1: compute sizes and place all IFDs
  const placed = placeIfds(processedIfds);

  // Pass 2: compute total file size
  const totalSize = computeTotalSize(placed);

  // Pass 3: write into buffer
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);

  // Write TIFF header (little-endian)
  view.setUint16(0, 0x4949, true); // "II" byte order
  view.setUint16(2, 42, true); // magic number
  view.setUint32(4, placed.length > 0 ? placed[0].ifdOffset : 0, true); // offset to first IFD

  // Write all placed IFDs
  for (const p of placed) {
    writeIfd(view, buffer, p);
  }

  return buffer;
}

/**
 * Compress a Uint8Array using deflate (zlib-wrapped, RFC 1950).
 * Compatible with TIFF compression code 8 and geotiff.js's pako.inflate().
 */
export function compressDeflate(
  data: Uint8Array,
  level: number = 6,
): Uint8Array {
  return deflate(data, { level: level as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 });
}

// ── Internal helpers ────────────────────────────────────────────────

/**
 * Process an IFD: compress strips if needed, add compression tag,
 * and recursively process SubIFDs.
 */
function processIfd(
  ifd: WritableIfd,
  compression: "none" | "deflate",
  level: number,
): WritableIfd {
  let strips = ifd.strips;
  const tags = [...ifd.tags];

  if (compression === "deflate") {
    strips = strips.map((s) => compressDeflate(s, level));
    // Replace or add Compression tag
    const compIdx = tags.findIndex((t) => t.tag === TAG_COMPRESSION);
    if (compIdx >= 0) {
      tags[compIdx] = { tag: TAG_COMPRESSION, type: TIFF_TYPE_SHORT, values: [COMPRESSION_DEFLATE] };
    } else {
      tags.push({ tag: TAG_COMPRESSION, type: TIFF_TYPE_SHORT, values: [COMPRESSION_DEFLATE] });
    }
  }

  const subIfds = ifd.subIfds?.map((sub) => processIfd(sub, compression, level));

  return { tags, strips, subIfds };
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
      case TIFF_TYPE_RATIONAL:
        // Rationals are stored as two LONGs (numerator, denominator)
        dv.setUint32(i * 4, tag.values[i], true);
        break;
    }
  }

  return { tag: tag.tag, type: tag.type, count, valueBytes };
}

/**
 * Compute the byte size of an IFD entry block:
 *   2 bytes (entry count) + 12 bytes per entry + 4 bytes (next IFD offset)
 */
function ifdEntryBlockSize(numTags: number): number {
  return 2 + numTags * 12 + 4;
}

/** Compute overflow size for resolved tags (values that don't fit in 4 bytes). */
function overflowSize(tags: ResolvedTag[]): number {
  let size = 0;
  for (const t of tags) {
    if (t.valueBytes.length > 4) {
      size += t.valueBytes.length;
      // Pad to word boundary (2-byte alignment)
      if (t.valueBytes.length % 2 !== 0) size += 1;
    }
  }
  return size;
}

/** Compute total strip data size. */
function totalStripSize(strips: Uint8Array[]): number {
  return strips.reduce((sum, s) => sum + s.length, 0);
}

/**
 * Place all IFDs sequentially, computing absolute offsets.
 * Returns a flat list of PlacedIfds (main chain first, then SubIFDs).
 */
function placeIfds(ifds: WritableIfd[]): PlacedIfd[] {
  const allPlaced: PlacedIfd[] = [];

  // First pass: resolve all tags and compute sizes
  interface IfdInfo {
    tags: ResolvedTag[];
    strips: Uint8Array[];
    subIfdInfos: IfdInfo[];
    entryBlockSize: number;
    overflow: number;
    stripSize: number;
    // Will be filled in placement pass
    placed?: PlacedIfd;
  }

  function resolveIfdInfo(ifd: WritableIfd): IfdInfo {
    // Build tags list — we'll add StripOffsets and StripByteCounts as placeholders
    // They'll be patched during the write phase
    const userTags = ifd.tags.map(resolveTag);

    // Add StripOffsets (placeholder — count = number of strips, values will be patched)
    const stripOffsetsTag: ResolvedTag = {
      tag: TAG_STRIP_OFFSETS,
      type: TIFF_TYPE_LONG,
      count: ifd.strips.length,
      valueBytes: new Uint8Array(ifd.strips.length * 4),
    };

    // Add StripByteCounts
    const stripByteCountsBytes = new Uint8Array(ifd.strips.length * 4);
    const sbcView = new DataView(stripByteCountsBytes.buffer);
    for (let i = 0; i < ifd.strips.length; i++) {
      sbcView.setUint32(i * 4, ifd.strips[i].length, true);
    }
    const stripByteCountsTag: ResolvedTag = {
      tag: TAG_STRIP_BYTE_COUNTS,
      type: TIFF_TYPE_LONG,
      count: ifd.strips.length,
      valueBytes: stripByteCountsBytes,
    };

    const allTags = [...userTags, stripOffsetsTag, stripByteCountsTag];

    // Add SubIFDs tag if there are SubIFDs
    const subIfdInfos = (ifd.subIfds ?? []).map(resolveIfdInfo);
    if (subIfdInfos.length > 0) {
      const subIfdsTag: ResolvedTag = {
        tag: TAG_SUB_IFDS,
        type: TIFF_TYPE_LONG,
        count: subIfdInfos.length,
        valueBytes: new Uint8Array(subIfdInfos.length * 4), // placeholder offsets
      };
      allTags.push(subIfdsTag);
    }

    // Sort by tag number (TIFF spec requires this)
    allTags.sort((a, b) => a.tag - b.tag);

    return {
      tags: allTags,
      strips: ifd.strips,
      subIfdInfos,
      entryBlockSize: ifdEntryBlockSize(allTags.length),
      overflow: overflowSize(allTags),
      stripSize: totalStripSize(ifd.strips),
    };
  }

  const mainInfos = ifds.map(resolveIfdInfo);

  // Second pass: place IFDs sequentially
  let cursor = 8; // Start after TIFF header

  function placeIfdInfo(info: IfdInfo): PlacedIfd {
    const ifdOffset = cursor;
    cursor += info.entryBlockSize;

    const overflowOffset = cursor;
    cursor += info.overflow;

    const stripDataOffset = cursor;
    cursor += info.stripSize;

    const placed: PlacedIfd = {
      ifdOffset,
      tags: info.tags,
      overflowOffset,
      overflowSize: info.overflow,
      stripDataOffset,
      strips: info.strips,
      subIfds: [], // will be filled after SubIFD placement
      nextIfdOffset: 0, // will be patched below for main chain
    };

    info.placed = placed;
    allPlaced.push(placed);

    // Place SubIFDs immediately after this IFD's strip data
    for (const subInfo of info.subIfdInfos) {
      placed.subIfds.push(placeIfdInfo(subInfo));
    }

    return placed;
  }

  // Place main chain IFDs (SubIFDs are placed within each main IFD's placeIfdInfo call)
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
function computeTotalSize(placed: PlacedIfd[]): number {
  if (placed.length === 0) return 8;
  let maxEnd = 8;
  for (const p of placed) {
    const end = p.stripDataOffset + totalStripSize(p.strips);
    if (end > maxEnd) maxEnd = end;
  }
  return maxEnd;
}

/** Write a single placed IFD (and its SubIFDs) into the buffer. */
function writeIfd(view: DataView, buffer: ArrayBuffer, placed: PlacedIfd): void {
  let pos = placed.ifdOffset;

  // Write entry count
  view.setUint16(pos, placed.tags.length, true);
  pos += 2;

  // Compute strip offsets for this IFD
  const stripOffsets: number[] = [];
  let stripCursor = placed.stripDataOffset;
  for (const strip of placed.strips) {
    stripOffsets.push(stripCursor);
    stripCursor += strip.length;
  }

  // Compute SubIFD offsets
  const subIfdOffsets = placed.subIfds.map((s) => s.ifdOffset);

  // Track overflow cursor
  let overflowCursor = placed.overflowOffset;

  // Write each tag entry (12 bytes each)
  for (const tag of placed.tags) {
    view.setUint16(pos, tag.tag, true);
    view.setUint16(pos + 2, tag.type, true);
    view.setUint32(pos + 4, tag.count, true);

    // Determine the value bytes to write
    let valueBytes = tag.valueBytes;

    // Patch StripOffsets
    if (tag.tag === TAG_STRIP_OFFSETS) {
      valueBytes = new Uint8Array(stripOffsets.length * 4);
      const dv = new DataView(valueBytes.buffer, valueBytes.byteOffset, valueBytes.byteLength);
      for (let i = 0; i < stripOffsets.length; i++) {
        dv.setUint32(i * 4, stripOffsets[i], true);
      }
    }

    // Patch SubIFDs offsets
    if (tag.tag === TAG_SUB_IFDS && subIfdOffsets.length > 0) {
      valueBytes = new Uint8Array(subIfdOffsets.length * 4);
      const dv = new DataView(valueBytes.buffer, valueBytes.byteOffset, valueBytes.byteLength);
      for (let i = 0; i < subIfdOffsets.length; i++) {
        dv.setUint32(i * 4, subIfdOffsets[i], true);
      }
    }

    if (valueBytes.length <= 4) {
      // Inline: write value bytes directly in the 4-byte value/offset field
      const dest = new Uint8Array(buffer, pos + 8, 4);
      dest.fill(0);
      dest.set(valueBytes);
    } else {
      // Overflow: write offset to overflow area, then write bytes there
      view.setUint32(pos + 8, overflowCursor, true);
      const dest = new Uint8Array(buffer, overflowCursor, valueBytes.length);
      dest.set(valueBytes);
      overflowCursor += valueBytes.length;
      // Pad to word boundary
      if (valueBytes.length % 2 !== 0) overflowCursor += 1;
    }

    pos += 12;
  }

  // Write next IFD offset
  view.setUint32(pos, placed.nextIfdOffset, true);

  // Write strip data
  let stripPos = placed.stripDataOffset;
  for (const strip of placed.strips) {
    const dest = new Uint8Array(buffer, stripPos, strip.length);
    dest.set(strip);
    stripPos += strip.length;
  }

  // SubIFDs are already in allPlaced and will be written by the caller's loop
}

// ── Convenience helpers for building IFD tags ───────────────────────

/** Create a standard set of tags for a grayscale image plane. */
export function makeImageTags(
  width: number,
  height: number,
  bitsPerSample: number,
  sampleFormat: number,
  compression: "none" | "deflate" = "none",
  imageDescription?: string,
  isSubResolution?: boolean,
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
  tags.push({ tag: TAG_ROWS_PER_STRIP, type: TIFF_TYPE_LONG, values: [height] }); // single strip
  tags.push({ tag: TAG_PLANAR_CONFIGURATION, type: TIFF_TYPE_SHORT, values: [1] }); // chunky
  tags.push({ tag: TAG_SAMPLE_FORMAT, type: TIFF_TYPE_SHORT, values: [sampleFormat] });

  if (imageDescription) {
    tags.push({ tag: TAG_IMAGE_DESCRIPTION, type: TIFF_TYPE_ASCII, values: imageDescription });
  }

  return tags;
}
