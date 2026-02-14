// SPDX-FileCopyrightText: Copyright (c) Fideus Labs LLC
// SPDX-License-Identifier: MIT

import { describe, it, expect } from "bun:test";
import { fromArrayBuffer } from "geotiff";
import type { GeoTIFFImage } from "geotiff";
import { readChunk } from "../src/chunk-reader.js";
import { createSimpleTiff, createUint16Tiff } from "./fixtures.js";
import type { PlaneSelection } from "../src/ifd-indexer.js";

describe("readChunk", () => {
  it("reads the full image as a single chunk", async () => {
    const buffer = createSimpleTiff(); // 64x64 uint8
    const tiff = await fromArrayBuffer(buffer);
    const image = await tiff.getImage(0);

    const getImage = async (_sel: PlaneSelection, _level: number) => image;

    const chunk = await readChunk(
      getImage,
      { c: 0, z: 0, t: 0 },
      0,
      0, // chunkY
      0, // chunkX
      64, // chunkHeight = full image
      64, // chunkWidth = full image
      64, // imageWidth
      64, // imageHeight
      "uint8",
    );

    expect(chunk).toBeDefined();
    expect(chunk.length).toBe(64 * 64 * 1); // uint8

    // Verify gradient pattern: value = (x + y) % 256
    expect(chunk[0]).toBe(0); // x=0, y=0
    expect(chunk[1]).toBe(1); // x=1, y=0
    expect(chunk[64]).toBe(1); // x=0, y=1
    expect(chunk[65]).toBe(2); // x=1, y=1
  });

  it("reads a sub-region chunk", async () => {
    const buffer = createUint16Tiff(); // 128x128 uint16, strip-based
    const tiff = await fromArrayBuffer(buffer);
    const image = await tiff.getImage(0);

    const getImage = async (_sel: PlaneSelection, _level: number) => image;

    // Read chunk at (1, 0) -> pixels [32, 0] to [64, 32]
    const chunk = await readChunk(
      getImage,
      { c: 0, z: 0, t: 0 },
      0,
      0, // chunkY
      1, // chunkX
      32, // chunkHeight
      32, // chunkWidth
      128, // imageWidth
      128, // imageHeight
      "uint16",
    );

    expect(chunk).toBeDefined();
    expect(chunk.length).toBe(32 * 32 * 2); // uint16

    // Verify values: fixture pattern is (x * 100 + y) % 65536
    const view = new Uint16Array(
      chunk.buffer,
      chunk.byteOffset,
      chunk.byteLength / 2,
    );
    // First pixel in this chunk: x=32, y=0 -> (32 * 100 + 0) % 65536 = 3200
    expect(view[0]).toBe(3200);
  });

  it("handles edge chunks with zero padding", async () => {
    // Create a 64x64 image and request a 32x32 chunk that extends beyond
    const buffer = createSimpleTiff(); // 64x64 uint8
    const tiff = await fromArrayBuffer(buffer);
    const image = await tiff.getImage(0);

    const getImage = async (_sel: PlaneSelection, _level: number) => image;

    // Request chunk at (1, 1) with 64x64 chunk size on a 64x64 image
    // This means chunk starts at (64, 64) which is outside the image
    // The computePixelWindow will clip to [64, 64, 64, 64] -> empty
    const chunk = await readChunk(
      getImage,
      { c: 0, z: 0, t: 0 },
      0,
      2, // chunkY = 2 (starts at 64, beyond the 64px image)
      0, // chunkX
      32, // chunkHeight
      32, // chunkWidth
      64, // imageWidth
      64, // imageHeight
      "uint8",
    );

    // Should return zero-filled data since the chunk is entirely outside
    expect(chunk).toBeDefined();
    expect(chunk.length).toBe(32 * 32);
    expect(chunk.every((b: number) => b === 0)).toBe(true);
  });
});
