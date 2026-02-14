import { describe, it, expect } from "bun:test";
import {
  parseStoreKey,
  computePixelWindow,
  encodeChunkBytes,
  computeChunkCounts,
  computeChunkShape,
  prevPowerOf2,
} from "../src/utils.js";

describe("parseStoreKey", () => {
  it("parses root metadata key", () => {
    const result = parseStoreKey("zarr.json");
    expect(result.isMetadata).toBe(true);
    expect(result.isRootMetadata).toBe(true);
  });

  it("parses root metadata key with leading slash", () => {
    const result = parseStoreKey("/zarr.json");
    expect(result.isMetadata).toBe(true);
    expect(result.isRootMetadata).toBe(true);
  });

  it("parses array metadata key", () => {
    const result = parseStoreKey("0/zarr.json");
    expect(result.isMetadata).toBe(true);
    expect(result.isRootMetadata).toBe(false);
    expect(result.level).toBe(0);
  });

  it("parses array metadata for higher levels", () => {
    const result = parseStoreKey("3/zarr.json");
    expect(result.isMetadata).toBe(true);
    expect(result.level).toBe(3);
  });

  it("parses chunk key with 2D indices", () => {
    const result = parseStoreKey("0/c/3/5");
    expect(result.isMetadata).toBe(false);
    expect(result.level).toBe(0);
    expect(result.chunkIndices).toEqual([3, 5]);
  });

  it("parses chunk key with 5D indices", () => {
    const result = parseStoreKey("1/c/0/2/0/7/12");
    expect(result.isMetadata).toBe(false);
    expect(result.level).toBe(1);
    expect(result.chunkIndices).toEqual([0, 2, 0, 7, 12]);
  });

  it("parses chunk key with leading slash", () => {
    const result = parseStoreKey("/0/c/0/0");
    expect(result.level).toBe(0);
    expect(result.chunkIndices).toEqual([0, 0]);
  });

  it("returns undefined for unknown keys", () => {
    const result = parseStoreKey("unknown/path");
    expect(result.isMetadata).toBe(false);
    expect(result.chunkIndices).toBeUndefined();
  });

  it("returns undefined for non-numeric levels", () => {
    const result = parseStoreKey("abc/zarr.json");
    expect(result.isMetadata).toBe(false);
  });
});

describe("computePixelWindow", () => {
  it("computes window for interior chunk", () => {
    const [left, top, right, bottom] = computePixelWindow(
      1,
      2,
      256,
      256,
      1024,
      1024,
    );
    expect(left).toBe(256);
    expect(top).toBe(512);
    expect(right).toBe(512);
    expect(bottom).toBe(768);
  });

  it("clips at image boundaries", () => {
    // Image is 500 wide, chunk at x=1 with width 256
    // Should clip right to 500
    const [left, top, right, bottom] = computePixelWindow(
      1,
      1,
      256,
      256,
      500,
      400,
    );
    expect(left).toBe(256);
    expect(top).toBe(256);
    expect(right).toBe(500);
    expect(bottom).toBe(400);
  });

  it("handles first chunk", () => {
    const [left, top, right, bottom] = computePixelWindow(
      0,
      0,
      128,
      128,
      512,
      512,
    );
    expect(left).toBe(0);
    expect(top).toBe(0);
    expect(right).toBe(128);
    expect(bottom).toBe(128);
  });
});

describe("encodeChunkBytes", () => {
  it("returns data as-is when size matches", () => {
    const data = new Uint16Array([1, 2, 3, 4]);
    const result = encodeChunkBytes(data, 4, 2);
    expect(result.length).toBe(8); // 4 elements * 2 bytes
    // Verify content
    const view = new Uint16Array(
      result.buffer,
      result.byteOffset,
      result.byteLength / 2,
    );
    expect(Array.from(view)).toEqual([1, 2, 3, 4]);
  });

  it("pads with zeros for edge chunks", () => {
    const data = new Uint8Array([1, 2, 3]);
    const result = encodeChunkBytes(data, 5, 1);
    expect(result.length).toBe(5);
    expect(result[0]).toBe(1);
    expect(result[1]).toBe(2);
    expect(result[2]).toBe(3);
    expect(result[3]).toBe(0);
    expect(result[4]).toBe(0);
  });
});

describe("computeChunkCounts", () => {
  it("computes exact divisions", () => {
    expect(computeChunkCounts([256, 256], [128, 128])).toEqual([2, 2]);
  });

  it("rounds up for non-exact divisions", () => {
    expect(computeChunkCounts([500, 300], [256, 256])).toEqual([2, 2]);
    expect(computeChunkCounts([257, 256], [256, 256])).toEqual([2, 1]);
  });

  it("handles single-element chunks", () => {
    expect(computeChunkCounts([3, 10, 10], [1, 5, 5])).toEqual([3, 2, 2]);
  });
});

describe("computeChunkShape", () => {
  it("creates 2D chunk shape", () => {
    expect(computeChunkShape(256, 256, 2)).toEqual([256, 256]);
  });

  it("creates 3D chunk shape with z", () => {
    expect(computeChunkShape(256, 256, 3)).toEqual([1, 256, 256]);
  });

  it("creates 5D chunk shape", () => {
    expect(computeChunkShape(128, 128, 5)).toEqual([1, 1, 1, 128, 128]);
  });
});

describe("prevPowerOf2", () => {
  it("returns power of 2 for exact powers", () => {
    expect(prevPowerOf2(256)).toBe(256);
    expect(prevPowerOf2(512)).toBe(512);
    expect(prevPowerOf2(1)).toBe(1);
  });

  it("returns previous power of 2 for non-powers", () => {
    expect(prevPowerOf2(300)).toBe(256);
    expect(prevPowerOf2(500)).toBe(256);
    expect(prevPowerOf2(1023)).toBe(512);
  });

  it("handles edge cases", () => {
    expect(prevPowerOf2(0)).toBe(1);
    expect(prevPowerOf2(-1)).toBe(1);
  });
});
