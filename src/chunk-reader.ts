// SPDX-FileCopyrightText: Copyright (c) Fideus Labs LLC
// SPDX-License-Identifier: MIT

/**
 * Chunk reader: reads pixel data from a GeoTIFFImage for a specific chunk,
 * returning raw bytes suitable for a Zarr store response.
 */

import type { GeoTIFFImage } from "geotiff";
import type { ZarrDataType } from "./dtypes.js";
import { bytesPerElement } from "./dtypes.js";
import { computePixelWindow, encodeChunkBytes } from "./utils.js";
import type { PlaneSelection } from "./ifd-indexer.js";

/**
 * Read a single chunk of data from a TIFF image.
 *
 * @param getImage - Function to resolve (selection, level) to a GeoTIFFImage.
 * @param sel - The plane selection (c, z, t).
 * @param level - The resolution level.
 * @param chunkY - The y chunk index within the image.
 * @param chunkX - The x chunk index within the image.
 * @param chunkHeight - Chunk size in pixels (y dimension).
 * @param chunkWidth - Chunk size in pixels (x dimension).
 * @param imageWidth - Total image width at this level.
 * @param imageHeight - Total image height at this level.
 * @param dtype - The Zarr data type of the output.
 * @param signal - Optional abort signal.
 * @returns Raw bytes for this chunk, zero-padded for edge chunks.
 */
export async function readChunk(
  getImage: (
    sel: PlaneSelection,
    level: number,
  ) => Promise<GeoTIFFImage>,
  sel: PlaneSelection,
  level: number,
  chunkY: number,
  chunkX: number,
  chunkHeight: number,
  chunkWidth: number,
  imageWidth: number,
  imageHeight: number,
  dtype: ZarrDataType,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const [left, top, right, bottom] = computePixelWindow(
    chunkX,
    chunkY,
    chunkWidth,
    chunkHeight,
    imageWidth,
    imageHeight,
  );

  const windowWidth = right - left;
  const windowHeight = bottom - top;

  if (windowWidth <= 0 || windowHeight <= 0) {
    // Chunk is entirely outside the image; return fill value (zeros)
    const bpe = bytesPerElement(dtype);
    return new Uint8Array(chunkWidth * chunkHeight * bpe);
  }

  const image = await getImage(sel, level);

  // Read the pixel data for this window
  // interleave=true gives a single flat TypedArray
  const rasterData = await image.readRasters({
    window: [left, top, right, bottom],
    width: windowWidth,
    height: windowHeight,
    interleave: true,
    samples: [0], // single sample; channel is handled at IFD level
    signal,
  });

  // readRasters with interleave returns a single TypedArray
  const pixelData = rasterData as unknown as ArrayBufferView;
  const bpe = bytesPerElement(dtype);
  const expectedElements = chunkWidth * chunkHeight;

  // For edge chunks, we need to properly pad the data.
  // The data from readRasters has shape (windowHeight, windowWidth) but
  // we need it in a buffer of shape (chunkHeight, chunkWidth).
  if (windowWidth < chunkWidth || windowHeight < chunkHeight) {
    return padEdgeChunk(
      pixelData,
      windowWidth,
      windowHeight,
      chunkWidth,
      chunkHeight,
      bpe,
    );
  }

  return encodeChunkBytes(pixelData, expectedElements, bpe);
}

/**
 * Pad an edge chunk by copying row-by-row into a full-size buffer.
 * Edge chunks occur at the right and bottom boundaries of the image.
 */
function padEdgeChunk(
  data: ArrayBufferView,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
  bytesPerEl: number,
): Uint8Array {
  const output = new Uint8Array(dstWidth * dstHeight * bytesPerEl);
  const src = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const srcRowBytes = srcWidth * bytesPerEl;
  const dstRowBytes = dstWidth * bytesPerEl;

  for (let row = 0; row < srcHeight; row++) {
    const srcOffset = row * srcRowBytes;
    const dstOffset = row * dstRowBytes;
    output.set(src.subarray(srcOffset, srcOffset + srcRowBytes), dstOffset);
  }

  return output;
}
