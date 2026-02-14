// SPDX-FileCopyrightText: Copyright (c) Fideus Labs LLC
// SPDX-License-Identifier: MIT

/**
 * Integration tests: verify that TiffStore produces valid OME-Zarr
 * that can be read back by zarrita.js and @fideus-labs/ngff-zarr.
 */
import { describe, it, expect } from "bun:test";
import * as zarr from "zarrita";
import { TiffStore } from "../src/tiff-store.js";
import { computeChunkCounts } from "../src/utils.js";
import {
  createSimpleTiff,
  createUint16Tiff,
  createFloat32Tiff,
  createSinglePlaneOmeTiff,
} from "./fixtures.js";

/**
 * Materialize a TiffStore into a MemoryStore (Map<string, Uint8Array>).
 * This populates all metadata and chunk keys eagerly so that it can be
 * consumed by libraries that expect a Map-based store (like fromNgffZarr).
 */
async function toMemoryStore(
  tiffStore: TiffStore,
): Promise<Map<string, Uint8Array>> {
  const memStore = new Map<string, Uint8Array>();

  // Root group metadata
  const rootJson = await tiffStore.get("zarr.json");
  if (rootJson) memStore.set("/zarr.json", rootJson);

  // For each resolution level, add array metadata and all chunk data
  for (let level = 0; level < tiffStore.levels; level++) {
    const arrJson = await tiffStore.get(`${level}/zarr.json`);
    if (arrJson) memStore.set(`/${level}/zarr.json`, arrJson);

    // Materialize all chunks for this level
    const shape = tiffStore.getShape(level);
    const chunkShape = tiffStore.getChunkShape(level);
    const chunkCounts = computeChunkCounts(shape, chunkShape);

    // Generate all chunk index combinations
    const allIndices = cartesianProduct(chunkCounts);
    for (const indices of allIndices) {
      const key = `${level}/c/${indices.join("/")}`;
      const chunkData = await tiffStore.get(key);
      if (chunkData) memStore.set(`/${key}`, chunkData);
    }
  }

  return memStore;
}

/** Generate cartesian product of ranges [0, n) for each n in counts. */
function cartesianProduct(counts: number[]): number[][] {
  if (counts.length === 0) return [[]];
  const result: number[][] = [];
  function recurse(depth: number, current: number[]) {
    if (depth === counts.length) {
      result.push([...current]);
      return;
    }
    for (let i = 0; i < counts[depth]; i++) {
      current[depth] = i;
      recurse(depth + 1, current);
    }
  }
  recurse(0, new Array(counts.length));
  return result;
}

describe("zarrita.js integration", () => {
  it("opens simple TIFF as zarr group", async () => {
    const buffer = createSimpleTiff();
    const store = await TiffStore.fromArrayBuffer(buffer);

    const group = await zarr.open(store as unknown as zarr.Readable, {
      kind: "group",
    });
    expect(group).toBeDefined();
    expect(group.attrs).toBeDefined();

    // Check OME attributes
    const ome = (group.attrs as Record<string, unknown>).ome as Record<
      string,
      unknown
    >;
    expect(ome).toBeDefined();
    expect(ome.version).toBe("0.5");
  });

  it("opens resolution level as zarr array", async () => {
    const buffer = createSimpleTiff();
    const store = await TiffStore.fromArrayBuffer(buffer);

    const group = await zarr.open(store as unknown as zarr.Readable, {
      kind: "group",
    });
    const arr = await zarr.open(group.resolve("0"), { kind: "array" });

    expect(arr).toBeDefined();
    expect(arr.shape).toEqual([64, 64]);
    expect(arr.dtype).toBe("uint8");
  });

  it("reads chunk data through zarrita", async () => {
    const buffer = createSimpleTiff();
    const store = await TiffStore.fromArrayBuffer(buffer);

    const group = await zarr.open(store as unknown as zarr.Readable, {
      kind: "group",
    });
    const arr = await zarr.open(group.resolve("0"), { kind: "array" });

    const chunk = await arr.getChunk([0, 0]);
    expect(chunk).toBeDefined();
    expect(chunk.data).toBeDefined();
    expect(chunk.data.length).toBeGreaterThan(0);

    // Verify pixel values: gradient pattern (x + y) % 256
    const typedData = chunk.data as Uint8Array;
    expect(typedData[0]).toBe(0); // x=0, y=0 -> 0
  });

  it("reads uint16 TIFF chunk data", async () => {
    const buffer = createUint16Tiff();
    const store = await TiffStore.fromArrayBuffer(buffer);

    const group = await zarr.open(store as unknown as zarr.Readable, {
      kind: "group",
    });
    const arr = await zarr.open(group.resolve("0"), { kind: "array" });

    expect(arr.shape).toEqual([128, 128]);
    expect(arr.dtype).toBe("uint16");

    const chunk = await arr.getChunk([0, 0]);
    expect(chunk).toBeDefined();
    expect(chunk.data.length).toBeGreaterThan(0);
  });

  it("reads float32 TIFF through zarrita", async () => {
    const buffer = createFloat32Tiff();
    const store = await TiffStore.fromArrayBuffer(buffer);

    const group = await zarr.open(store as unknown as zarr.Readable, {
      kind: "group",
    });
    const arr = await zarr.open(group.resolve("0"), { kind: "array" });

    expect(arr.dtype).toBe("float32");

    const chunk = await arr.getChunk([0, 0]);
    const data = chunk.data as Float32Array;
    expect(data[0]).toBeCloseTo(0.0);
  });

  it("reads OME-TIFF with correct metadata structure", async () => {
    const buffer = createSinglePlaneOmeTiff(64, 48);
    const store = await TiffStore.fromArrayBuffer(buffer);

    const group = await zarr.open(store as unknown as zarr.Readable, {
      kind: "group",
    });

    const ome = (group.attrs as Record<string, unknown>).ome as Record<
      string,
      unknown
    >;
    expect(ome.version).toBe("0.5");

    const multiscales = ome.multiscales as Array<Record<string, unknown>>;
    expect(multiscales).toHaveLength(1);

    const ms = multiscales[0];
    expect(ms.axes).toBeDefined();
    expect(ms.datasets).toBeDefined();

    const arr = await zarr.open(group.resolve("0"), { kind: "array" });
    expect(arr.dtype).toBe("uint16");
    const shape = arr.shape;
    expect(shape[shape.length - 1]).toBe(64); // x
    expect(shape[shape.length - 2]).toBe(48); // y
  });

  it("reads correct pixel values from OME-TIFF", async () => {
    const buffer = createSinglePlaneOmeTiff(64, 48);
    const store = await TiffStore.fromArrayBuffer(buffer);

    const group = await zarr.open(store as unknown as zarr.Readable, {
      kind: "group",
    });
    const arr = await zarr.open(group.resolve("0"), { kind: "array" });

    const chunk = await arr.getChunk([0, 0]);
    const data = chunk.data as Uint16Array;

    // Fixture pattern: value = x + y * width (width=64)
    expect(data[0]).toBe(0);  // x=0, y=0
    expect(data[1]).toBe(1);  // x=1, y=0
  });

  it("validates multiscales axes have correct types", async () => {
    const buffer = createSinglePlaneOmeTiff();
    const store = await TiffStore.fromArrayBuffer(buffer);

    const group = await zarr.open(store as unknown as zarr.Readable, {
      kind: "group",
    });

    const ome = (group.attrs as Record<string, unknown>).ome as Record<
      string,
      unknown
    >;
    const multiscales = ome.multiscales as Array<Record<string, unknown>>;
    const axes = multiscales[0].axes as Array<{
      name: string;
      type: string;
      unit?: string;
    }>;

    for (const axis of axes) {
      expect(["space", "time", "channel"]).toContain(axis.type);
    }

    const xAxis = axes.find((a) => a.name === "x");
    const yAxis = axes.find((a) => a.name === "y");
    expect(xAxis?.type).toBe("space");
    expect(yAxis?.type).toBe("space");
  });

  it("validates coordinate transformations are present", async () => {
    const buffer = createSinglePlaneOmeTiff();
    const store = await TiffStore.fromArrayBuffer(buffer);

    const group = await zarr.open(store as unknown as zarr.Readable, {
      kind: "group",
    });

    const ome = (group.attrs as Record<string, unknown>).ome as Record<
      string,
      unknown
    >;
    const multiscales = ome.multiscales as Array<Record<string, unknown>>;
    const datasets = multiscales[0].datasets as Array<
      Record<string, unknown>
    >;

    for (const dataset of datasets) {
      const transforms = dataset.coordinateTransformations as Array<
        Record<string, unknown>
      >;
      expect(transforms).toBeDefined();
      expect(transforms.length).toBeGreaterThanOrEqual(1);
      expect(transforms[0].type).toBe("scale");
      expect(transforms[0].scale).toBeDefined();
    }
  });
});

describe("ngff-zarr integration", () => {
  it("reads simple TIFF store with fromNgffZarr", async () => {
    const { fromNgffZarr } = await import("@fideus-labs/ngff-zarr");

    const buffer = createSimpleTiff();
    const tiffStore = await TiffStore.fromArrayBuffer(buffer);
    const memStore = await toMemoryStore(tiffStore);

    const multiscales = await fromNgffZarr(memStore, { version: "0.5" });

    expect(multiscales).toBeDefined();
    expect(multiscales.images).toBeDefined();
    expect(multiscales.images.length).toBeGreaterThanOrEqual(1);

    const image = multiscales.images[0];
    expect(image.dims).toContain("y");
    expect(image.dims).toContain("x");
  });

  it("reads OME-TIFF store with correct metadata", async () => {
    const { fromNgffZarr } = await import("@fideus-labs/ngff-zarr");

    const buffer = createSinglePlaneOmeTiff(64, 48);
    const tiffStore = await TiffStore.fromArrayBuffer(buffer);
    const memStore = await toMemoryStore(tiffStore);

    const multiscales = await fromNgffZarr(memStore, { version: "0.5" });

    expect(multiscales).toBeDefined();
    expect(multiscales.metadata).toBeDefined();
    expect(multiscales.metadata.version).toBe("0.5");

    const axes = multiscales.metadata.axes;
    expect(axes).toBeDefined();
    const axisNames = axes.map((a: { name: string }) => a.name);
    expect(axisNames).toContain("y");
    expect(axisNames).toContain("x");

    expect(multiscales.metadata.datasets.length).toBeGreaterThanOrEqual(1);
    expect(multiscales.metadata.datasets[0].path).toBe("0");
  });

  it("reads pixel data through ngff-zarr", async () => {
    const { fromNgffZarr } = await import("@fideus-labs/ngff-zarr");

    const buffer = createSimpleTiff();
    const tiffStore = await TiffStore.fromArrayBuffer(buffer);
    const memStore = await toMemoryStore(tiffStore);

    const multiscales = await fromNgffZarr(memStore, { version: "0.5" });

    const image = multiscales.images[0];
    expect(image.data).toBeDefined();
    expect(image.data.shape).toBeDefined();
    expect(image.data.shape.length).toBeGreaterThanOrEqual(2);
  });

  it("produces valid float32 OME-Zarr", async () => {
    const { fromNgffZarr } = await import("@fideus-labs/ngff-zarr");

    const buffer = createFloat32Tiff();
    const tiffStore = await TiffStore.fromArrayBuffer(buffer);
    const memStore = await toMemoryStore(tiffStore);

    const multiscales = await fromNgffZarr(memStore, { version: "0.5" });

    expect(multiscales.images[0].data.dtype).toBe("float32");
  });

  it("produces correct scale metadata", async () => {
    const { fromNgffZarr } = await import("@fideus-labs/ngff-zarr");

    const buffer = createSinglePlaneOmeTiff(64, 48);
    const tiffStore = await TiffStore.fromArrayBuffer(buffer);
    const memStore = await toMemoryStore(tiffStore);

    const multiscales = await fromNgffZarr(memStore, { version: "0.5" });

    // Check that the image has scale metadata
    const image = multiscales.images[0];
    expect(image.scale).toBeDefined();
    // Physical sizes were set to 0.5 in the fixture
    const xScale = image.scale["x"];
    const yScale = image.scale["y"];
    expect(xScale).toBeCloseTo(0.5);
    expect(yScale).toBeCloseTo(0.5);
  });

  it("round-trips pixel values correctly", async () => {
    const { fromNgffZarr } = await import("@fideus-labs/ngff-zarr");

    const buffer = createSimpleTiff(); // 64x64 uint8, gradient pattern
    const tiffStore = await TiffStore.fromArrayBuffer(buffer);
    const memStore = await toMemoryStore(tiffStore);

    const multiscales = await fromNgffZarr(memStore, { version: "0.5" });

    // Read the data through ngff-zarr's zarr array
    const image = multiscales.images[0];
    const arr = image.data;

    // Read a chunk
    const chunk = await arr.getChunk([0, 0]);
    const data = chunk.data as Uint8Array;

    // Verify gradient pattern
    expect(data[0]).toBe(0); // (0+0)%256
    expect(data[1]).toBe(1); // (1+0)%256
  });
});
