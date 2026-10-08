// SPDX-FileCopyrightText: Copyright (c) Fideus Labs LLC
// SPDX-License-Identifier: MIT

import { describe, it, expect } from "bun:test";
import { fromArrayBuffer } from "geotiff";
import {
  detectPyramid,
  createOmeIndexer,
  createPlainIndexer,
} from "../src/ifd-indexer.js";
import { buildTiff, makeImageTags } from "../src/tiff-writer.js";
import { createSimpleTiff, createUint16Tiff } from "./fixtures.js";
import type { OmePixels } from "../src/ome-xml.js";

/** A 64x64 uint8 image with two SubIFD levels whose sizes are not halvings. */
async function createSubIfdPyramid(): Promise<ArrayBuffer> {
  const level = (width: number, height: number, isSubResolution: boolean, value: number) => ({
    tags: makeImageTags(width, height, 8, 1, "none", undefined, isSubResolution, 0),
    tiles: [new Uint8Array(width * height).fill(value)],
  });
  return buildTiff([
    { ...level(64, 64, false, 10), subIfds: [level(40, 24, true, 20), level(13, 7, true, 30)] },
  ]);
}

const singlePlane: OmePixels = {
  sizeX: 64,
  sizeY: 64,
  sizeZ: 1,
  sizeC: 1,
  sizeT: 1,
  dimensionOrder: "XYZCT",
  type: "uint8",
  bigEndian: false,
  interleaved: false,
  channels: [],
  tiffData: [],
};

describe("detectPyramid", () => {
  it("detects single-level for simple TIFF", async () => {
    const buffer = createSimpleTiff();
    const tiff = await fromArrayBuffer(buffer);

    const pyramid = await detectPyramid(tiff, 0, 1);

    expect(pyramid.levels).toBe(1);
    expect(pyramid.usesSubIfds).toBe(false);
    expect(pyramid.widths).toEqual([64]);
    expect(pyramid.heights).toEqual([64]);
  });

  it("detects single-level for uint16 TIFF", async () => {
    const buffer = createUint16Tiff();
    const tiff = await fromArrayBuffer(buffer);

    const pyramid = await detectPyramid(tiff, 0, 1);

    expect(pyramid.levels).toBe(1);
    expect(pyramid.widths).toEqual([128]);
    expect(pyramid.heights).toEqual([128]);
  });

  it("reads each SubIFD level's dimensions", async () => {
    const tiff = await fromArrayBuffer(await createSubIfdPyramid());

    const pyramid = await detectPyramid(tiff, 1, 1);

    expect(pyramid.levels).toBe(3);
    expect(pyramid.usesSubIfds).toBe(true);
    expect(pyramid.widths).toEqual([64, 40, 13]);
    expect(pyramid.heights).toEqual([64, 24, 7]);
  });

  it("detects correct image dimensions", async () => {
    const buffer = createSimpleTiff();
    const tiff = await fromArrayBuffer(buffer);

    const pyramid = await detectPyramid(tiff, 0, 1);

    expect(pyramid.widths[0]).toBe(64);
    expect(pyramid.heights[0]).toBe(64);
  });
});

describe("createOmeIndexer", () => {
  it("returns SubIFD images for sub-resolution levels", async () => {
    const tiff = await fromArrayBuffer(await createSubIfdPyramid());
    const pyramid = await detectPyramid(tiff, 1, 1);
    const indexer = createOmeIndexer(tiff, singlePlane, pyramid);

    for (const [level, width, height, value] of [
      [0, 64, 64, 10],
      [1, 40, 24, 20],
      [2, 13, 7, 30],
    ]) {
      const image = await indexer({ c: 0, z: 0, t: 0 }, level);
      expect(image.getWidth()).toBe(width);
      expect(image.getHeight()).toBe(height);
      const [band] = (await image.readRasters()) as unknown as Uint8Array[];
      expect(band.length).toBe(width * height);
      expect(band.every((pixel) => pixel === value)).toBe(true);
    }
  });
});

describe("pre-computed IFD offsets", () => {
  it("reads the base image at its byte offset", async () => {
    const buffer = await createSubIfdPyramid();
    const firstIfdOffset = new DataView(buffer).getUint32(4, true);
    const tiff = await fromArrayBuffer(buffer);
    const pyramid = await detectPyramid(tiff, 1, 1);
    const indexer = createOmeIndexer(tiff, singlePlane, pyramid, 0, [firstIfdOffset]);

    const image = await indexer({ c: 0, z: 0, t: 0 }, 0);

    expect(image.getWidth()).toBe(64);
    expect(image.getHeight()).toBe(64);
  });
});

describe("createPlainIndexer", () => {
  it("returns the correct image for level 0", async () => {
    const buffer = createSimpleTiff();
    const tiff = await fromArrayBuffer(buffer);

    const indexer = createPlainIndexer(tiff);
    const image = await indexer({ c: 0, z: 0, t: 0 }, 0);

    expect(image).toBeDefined();
    expect(image.getWidth()).toBe(64);
    expect(image.getHeight()).toBe(64);
  });

  it("ignores selection for plain TIFFs", async () => {
    const buffer = createSimpleTiff();
    const tiff = await fromArrayBuffer(buffer);

    const indexer = createPlainIndexer(tiff);
    const image1 = await indexer({ c: 0, z: 0, t: 0 }, 0);
    const image2 = await indexer({ c: 5, z: 3, t: 1 }, 0);

    // Both should return the same image (level 0)
    expect(image1.getWidth()).toBe(image2.getWidth());
    expect(image1.getHeight()).toBe(image2.getHeight());
  });
});
