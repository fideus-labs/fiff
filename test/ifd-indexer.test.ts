import { describe, it, expect } from "bun:test";
import { fromArrayBuffer } from "geotiff";
import {
  detectPyramid,
  createPlainIndexer,
} from "../src/ifd-indexer.js";
import { createSimpleTiff, createUint16Tiff } from "./fixtures.js";

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

  it("detects correct image dimensions", async () => {
    const buffer = createSimpleTiff();
    const tiff = await fromArrayBuffer(buffer);

    const pyramid = await detectPyramid(tiff, 0, 1);

    expect(pyramid.widths[0]).toBe(64);
    expect(pyramid.heights[0]).toBe(64);
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
