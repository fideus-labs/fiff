// SPDX-FileCopyrightText: Copyright (c) Fideus Labs LLC
// SPDX-License-Identifier: MIT

import { describe, it, expect } from "bun:test";
import {
  createNgffImage,
  createAxis,
  createDataset,
  createMetadata,
  createMultiscales,
  type Multiscales,
  type Omero,
  type NgffImage,
} from "@fideus-labs/ngff-zarr";
import * as zarr from "zarrita";
import { toOmeTiff } from "../src/write.js";
import { TiffStore } from "../src/tiff-store.js";
import { fromArrayBuffer } from "geotiff";

// ── Test helpers ────────────────────────────────────────────────────

/** Helper: get typed array constructor for a dtype string. */
function getTypedArrayCtor(dtype: string) {
  switch (dtype) {
    case "uint8": return Uint8Array;
    case "uint16": return Uint16Array;
    case "uint32": return Uint32Array;
    case "int8": return Int8Array;
    case "int16": return Int16Array;
    case "int32": return Int32Array;
    case "float32": return Float32Array;
    case "float64": return Float64Array;
    default: return Uint16Array;
  }
}

/** Create a 2D (y, x) Multiscales with known pixel values. */
async function create2DMultiscales(
  width: number,
  height: number,
  dtype: string = "uint16",
): Promise<Multiscales> {
  const image = await createNgffImage(
    [],
    [height, width],
    dtype,
    ["y", "x"],
    { y: 0.5, x: 0.5 },
    { y: 0.0, x: 0.0 },
    "test-2d",
  );

  // Populate pixel data
  const Ctor = getTypedArrayCtor(dtype);
  const maxVal = dtype === "uint8" ? 256 : 65536;
  const data = new Ctor(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = (x + y * width) % maxVal;
    }
  }
  await zarr.set(image.data as any, null, {
    data,
    shape: [height, width],
    stride: [width, 1],
  });

  const axes = [
    createAxis("y", "space", "micrometer"),
    createAxis("x", "space", "micrometer"),
  ];
  const datasets = [createDataset("0", [0.5, 0.5], [0.0, 0.0])];
  const metadata = createMetadata(axes, datasets, "test-2d");

  return createMultiscales([image], metadata);
}

/** Create a 5D (t, c, z, y, x) Multiscales with known pixel values. */
async function create5DMultiscales(
  sizeT: number,
  sizeC: number,
  sizeZ: number,
  height: number,
  width: number,
  omero?: Omero,
): Promise<Multiscales> {
  const shape = [sizeT, sizeC, sizeZ, height, width];
  const image = await createNgffImage(
    [],
    shape,
    "uint16",
    ["t", "c", "z", "y", "x"],
    { t: 1.0, c: 1.0, z: 2.0, y: 0.5, x: 0.5 },
    { t: 0.0, c: 0.0, z: 0.0, y: 0.0, x: 0.0 },
    "test-5d",
  );

  // Populate pixel data
  const total = sizeT * sizeC * sizeZ * height * width;
  const data = new Uint16Array(total);
  for (let i = 0; i < total; i++) {
    data[i] = i % 65536;
  }
  const stride = [
    sizeC * sizeZ * height * width,
    sizeZ * height * width,
    height * width,
    width,
    1,
  ];
  await zarr.set(image.data as any, null, { data, shape, stride });

  const axes = [
    createAxis("t", "time"),
    createAxis("c", "channel"),
    createAxis("z", "space", "micrometer"),
    createAxis("y", "space", "micrometer"),
    createAxis("x", "space", "micrometer"),
  ];
  const datasets = [createDataset("0", [1, 1, 2, 0.5, 0.5], [0, 0, 0, 0, 0])];
  const meta = createMetadata(axes, datasets, "test-5d");
  if (omero) {
    (meta as any).omero = omero;
  }

  return createMultiscales([image], meta);
}

/** Create a multi-resolution Multiscales (2 levels). */
async function createPyramidMultiscales(
  width: number,
  height: number,
): Promise<Multiscales> {
  // Full resolution
  const fullImage = await createNgffImage(
    [],
    [height, width],
    "uint16",
    ["y", "x"],
    { y: 0.5, x: 0.5 },
    { y: 0.0, x: 0.0 },
    "pyramid",
  );
  const fullData = new Uint16Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      fullData[y * width + x] = (x + y) % 65536;
    }
  }
  await zarr.set(fullImage.data as any, null, {
    data: fullData,
    shape: [height, width],
    stride: [width, 1],
  });

  // Half resolution
  const halfW = Math.floor(width / 2);
  const halfH = Math.floor(height / 2);
  const halfImage = await createNgffImage(
    [],
    [halfH, halfW],
    "uint16",
    ["y", "x"],
    { y: 1.0, x: 1.0 },
    { y: 0.0, x: 0.0 },
    "pyramid-1",
  );
  const halfData = new Uint16Array(halfW * halfH);
  for (let y = 0; y < halfH; y++) {
    for (let x = 0; x < halfW; x++) {
      halfData[y * halfW + x] = (x * 2 + y * 2) % 65536;
    }
  }
  await zarr.set(halfImage.data as any, null, {
    data: halfData,
    shape: [halfH, halfW],
    stride: [halfW, 1],
  });

  const axes = [
    createAxis("y", "space", "micrometer"),
    createAxis("x", "space", "micrometer"),
  ];
  const datasets = [
    createDataset("0", [0.5, 0.5], [0.0, 0.0]),
    createDataset("1", [1.0, 1.0], [0.0, 0.0]),
  ];
  const metadata = createMetadata(axes, datasets, "pyramid");

  return createMultiscales([fullImage, halfImage], metadata);
}

// ── Tests ───────────────────────────────────────────────────────────

describe("toOmeTiff", () => {
  describe("basic round-trip", () => {
    it("writes a 2D image readable by geotiff.js", async () => {
      const ms = await create2DMultiscales(32, 24);
      const buffer = await toOmeTiff(ms, { compression: "none" });

      const tiff = await fromArrayBuffer(buffer);
      const image = await tiff.getImage(0);
      expect(image.getWidth()).toBe(32);
      expect(image.getHeight()).toBe(24);
      expect(image.getBitsPerSample()).toBe(16);
    });

    it("preserves pixel data in round-trip (uncompressed)", async () => {
      const ms = await create2DMultiscales(16, 16, "uint16");
      const buffer = await toOmeTiff(ms, { compression: "none" });

      const tiff = await fromArrayBuffer(buffer);
      const image = await tiff.getImage(0);
      const rasters = await image.readRasters();
      const pixels = rasters[0] as Uint16Array;

      expect(pixels[0]).toBe(0);
      expect(pixels[1]).toBe(1);
      expect(pixels[16]).toBe(16);
    });

    it("preserves pixel data in round-trip (deflate)", async () => {
      const ms = await create2DMultiscales(16, 16, "uint16");
      const buffer = await toOmeTiff(ms, { compression: "deflate" });

      const tiff = await fromArrayBuffer(buffer);
      const image = await tiff.getImage(0);
      const rasters = await image.readRasters();
      const pixels = rasters[0] as Uint16Array;

      expect(pixels[0]).toBe(0);
      expect(pixels[1]).toBe(1);
      expect(pixels[16]).toBe(16);
    });

    it("writes valid OME-XML in ImageDescription", async () => {
      const ms = await create2DMultiscales(16, 16);
      const buffer = await toOmeTiff(ms, { compression: "none" });

      const tiff = await fromArrayBuffer(buffer);
      const image = await tiff.getImage(0);
      const desc = (image.fileDirectory.getValue("ImageDescription") as string)?.replace(/\0+$/, "");

      expect(desc).toBeDefined();
      expect(desc).toContain("OME");
      expect(desc).toContain('SizeX="16"');
      expect(desc).toContain('SizeY="16"');
    });
  });

  describe("tiled output", () => {
    it("writes tiled TIFF for large images", async () => {
      const ms = await create2DMultiscales(512, 512, "uint8");
      const buffer = await toOmeTiff(ms, { compression: "none", tileSize: 256 });

      const tiff = await fromArrayBuffer(buffer);
      const image = await tiff.getImage(0);
      expect(image.getWidth()).toBe(512);
      expect(image.getHeight()).toBe(512);
      expect(image.getTileWidth()).toBe(256);
      expect(image.getTileHeight()).toBe(256);
    });

    it("preserves pixel data with tiled output", async () => {
      const ms = await create2DMultiscales(512, 512, "uint16");
      const buffer = await toOmeTiff(ms, { compression: "none", tileSize: 256 });

      const tiff = await fromArrayBuffer(buffer);
      const image = await tiff.getImage(0);
      const rasters = await image.readRasters();
      const pixels = rasters[0] as Uint16Array;
      expect(pixels.length).toBe(512 * 512);
      expect(pixels[0]).toBe(0);
      expect(pixels[1]).toBe(1);
      expect(pixels[512]).toBe(512); // x=0, y=1
    });

    it("handles non-tile-aligned dimensions", async () => {
      const ms = await create2DMultiscales(300, 200, "uint16");
      const buffer = await toOmeTiff(ms, { compression: "none", tileSize: 256 });

      const tiff = await fromArrayBuffer(buffer);
      const image = await tiff.getImage(0);
      expect(image.getWidth()).toBe(300);
      expect(image.getHeight()).toBe(200);

      const rasters = await image.readRasters();
      const pixels = rasters[0] as Uint16Array;
      expect(pixels.length).toBe(300 * 200);
      expect(pixels[0]).toBe(0);
      expect(pixels[1]).toBe(1);
    });

    it("tiled output with deflate compression round-trips", async () => {
      const ms = await create2DMultiscales(512, 512, "uint16");
      const buffer = await toOmeTiff(ms, { compression: "deflate", tileSize: 256 });

      const tiff = await fromArrayBuffer(buffer);
      const image = await tiff.getImage(0);
      expect(image.fileDirectory.getValue("Compression")).toBe(8);
      expect(image.getTileWidth()).toBe(256);

      const rasters = await image.readRasters();
      const pixels = rasters[0] as Uint16Array;
      expect(pixels[0]).toBe(0);
      expect(pixels[1]).toBe(1);
    });

    it("uses strip layout when tileSize=0", async () => {
      const ms = await create2DMultiscales(16, 16);
      const buffer = await toOmeTiff(ms, { compression: "none", tileSize: 0 });

      const tiff = await fromArrayBuffer(buffer);
      const image = await tiff.getImage(0);
      expect(image.getWidth()).toBe(16);
      // No tile tags present — it's a strip-based image
      expect(image.fileDirectory.getValue("TileWidth")).toBeUndefined();
    });
  });

  describe("multi-channel", () => {
    it("writes multiple IFDs for multi-channel image", async () => {
      const ms = await create5DMultiscales(1, 3, 1, 8, 8);
      const buffer = await toOmeTiff(ms, { compression: "none" });

      const tiff = await fromArrayBuffer(buffer);
      const img0 = await tiff.getImage(0);
      const img1 = await tiff.getImage(1);
      const img2 = await tiff.getImage(2);

      expect(img0.getWidth()).toBe(8);
      expect(img1.getWidth()).toBe(8);
      expect(img2.getWidth()).toBe(8);
    });

    it("OME-XML has correct SizeC for multi-channel", async () => {
      const ms = await create5DMultiscales(1, 2, 1, 8, 8);
      const buffer = await toOmeTiff(ms, { compression: "none" });

      const tiff = await fromArrayBuffer(buffer);
      const image = await tiff.getImage(0);
      const desc = (image.fileDirectory.getValue("ImageDescription") as string)?.replace(/\0+$/, "");
      expect(desc).toContain('SizeC="2"');
    });
  });

  describe("multi-Z", () => {
    it("writes correct number of IFDs for Z stack", async () => {
      const ms = await create5DMultiscales(1, 1, 4, 8, 8);
      const buffer = await toOmeTiff(ms, { compression: "none" });

      const tiff = await fromArrayBuffer(buffer);
      for (let i = 0; i < 4; i++) {
        const img = await tiff.getImage(i);
        expect(img.getWidth()).toBe(8);
      }
    });
  });

  describe("5D image", () => {
    it("writes C*Z*T IFDs for a 5D image", async () => {
      const ms = await create5DMultiscales(2, 2, 3, 8, 8);
      const buffer = await toOmeTiff(ms, { compression: "none" });

      const tiff = await fromArrayBuffer(buffer);
      const totalPlanes = 2 * 2 * 3;
      for (let i = 0; i < totalPlanes; i++) {
        const img = await tiff.getImage(i);
        expect(img.getWidth()).toBe(8);
      }
    });
  });

  describe("pyramid / SubIFDs", () => {
    it("writes SubIFDs for multi-resolution images", async () => {
      const ms = await createPyramidMultiscales(32, 32);
      const buffer = await toOmeTiff(ms, { compression: "none" });

      const tiff = await fromArrayBuffer(buffer);
      const image = await tiff.getImage(0);

      expect(image.getWidth()).toBe(32);
      expect(image.getHeight()).toBe(32);

      const subIfdOffsets = image.fileDirectory.getValue("SubIFDs");
      expect(subIfdOffsets).toBeDefined();
      expect(subIfdOffsets!.length).toBe(1);
    });

    it("full-res and sub-res pixel data is readable", async () => {
      const ms = await createPyramidMultiscales(16, 16);
      const buffer = await toOmeTiff(ms, { compression: "none" });

      const tiff = await fromArrayBuffer(buffer);
      const image = await tiff.getImage(0);

      const rasters = await image.readRasters();
      const pixels = rasters[0] as Uint16Array;
      expect(pixels.length).toBe(16 * 16);
      expect(pixels[0]).toBe(0);
      expect(pixels[1]).toBe(1);
    });
  });

  describe("compression", () => {
    it("deflate compressed file is smaller than uncompressed", async () => {
      const ms = await create2DMultiscales(64, 64);

      const uncompressed = await toOmeTiff(ms, { compression: "none" });
      const compressed = await toOmeTiff(ms, { compression: "deflate" });

      expect(compressed.byteLength).toBeLessThan(uncompressed.byteLength);
    });

    it("deflate compressed data round-trips correctly", async () => {
      const ms = await create2DMultiscales(32, 32, "uint16");
      const buffer = await toOmeTiff(ms, { compression: "deflate" });

      const tiff = await fromArrayBuffer(buffer);
      const image = await tiff.getImage(0);
      const rasters = await image.readRasters();
      const pixels = rasters[0] as Uint16Array;

      expect(pixels[0]).toBe(0);
      expect(pixels[1]).toBe(1);
      expect(pixels[32]).toBe(32);
    });
  });

  describe("concurrency", () => {
    it("concurrency=1 produces same output as default", async () => {
      const ms = await create5DMultiscales(1, 2, 2, 8, 8);
      const buf1 = await toOmeTiff(ms, { compression: "none", concurrency: 1 });
      const buf4 = await toOmeTiff(ms, { compression: "none", concurrency: 4 });

      // Same file size
      expect(buf1.byteLength).toBe(buf4.byteLength);

      // Same pixel data in every IFD
      const tiff1 = await fromArrayBuffer(buf1);
      const tiff4 = await fromArrayBuffer(buf4);
      for (let i = 0; i < 4; i++) {
        const r1 = await (await tiff1.getImage(i)).readRasters();
        const r4 = await (await tiff4.getImage(i)).readRasters();
        expect(r1[0]).toEqual(r4[0]);
      }
    });

    it("concurrency=8 works with many planes", async () => {
      const ms = await create5DMultiscales(2, 2, 2, 8, 8);
      const buffer = await toOmeTiff(ms, { compression: "none", concurrency: 8 });

      const tiff = await fromArrayBuffer(buffer);
      // 2T * 2C * 2Z = 8 IFDs
      for (let i = 0; i < 8; i++) {
        const img = await tiff.getImage(i);
        expect(img.getWidth()).toBe(8);
      }
    });
  });

  describe("BigTIFF format", () => {
    it("produces BigTIFF when format=bigtiff", async () => {
      const ms = await create2DMultiscales(16, 16);
      const buffer = await toOmeTiff(ms, { compression: "none", format: "bigtiff" });

      const view = new DataView(buffer);
      expect(view.getUint16(2, true)).toBe(43); // BigTIFF magic

      // Still readable by geotiff.js
      const tiff = await fromArrayBuffer(buffer);
      const image = await tiff.getImage(0);
      expect(image.getWidth()).toBe(16);
    });

    it("BigTIFF preserves pixel data", async () => {
      const ms = await create2DMultiscales(16, 16, "uint16");
      const buffer = await toOmeTiff(ms, {
        compression: "deflate",
        format: "bigtiff",
      });

      const tiff = await fromArrayBuffer(buffer);
      const image = await tiff.getImage(0);
      const rasters = await image.readRasters();
      const pixels = rasters[0] as Uint16Array;
      expect(pixels[0]).toBe(0);
      expect(pixels[1]).toBe(1);
    });

    it("auto format uses classic TIFF for small files", async () => {
      const ms = await create2DMultiscales(16, 16);
      const buffer = await toOmeTiff(ms, { compression: "none", format: "auto" });

      const view = new DataView(buffer);
      expect(view.getUint16(2, true)).toBe(42); // Classic TIFF
    });
  });

  describe("TiffStore round-trip", () => {
    it("output is readable by TiffStore", async () => {
      const ms = await create2DMultiscales(16, 16);
      const buffer = await toOmeTiff(ms, { compression: "none" });

      const store = await TiffStore.fromArrayBuffer(buffer);
      expect(store.levels).toBeGreaterThanOrEqual(1);
      expect(store.dataType).toBe("uint16");
    });

    it("TiffStore reads correct metadata from written OME-TIFF", async () => {
      const ms = await create5DMultiscales(1, 2, 3, 16, 16);
      const buffer = await toOmeTiff(ms, { compression: "none" });

      const store = await TiffStore.fromArrayBuffer(buffer);
      expect(store.dataType).toBe("uint16");

      const rootJson = await store.get("zarr.json");
      expect(rootJson).toBeDefined();

      const root = JSON.parse(new TextDecoder().decode(rootJson));
      expect(root.zarr_format).toBe(3);
      expect(root.attributes.ome.multiscales).toBeDefined();
    });

    it("full zarrita round-trip: write -> read -> get data", async () => {
      const ms = await create2DMultiscales(16, 16, "uint16");
      const buffer = await toOmeTiff(ms, { compression: "deflate" });

      const store = await TiffStore.fromArrayBuffer(buffer);
      const group = await zarr.open(store as unknown as zarr.Readable, { kind: "group" });
      const arr = await zarr.open(group.resolve("0"), { kind: "array" });

      const result = await zarr.get(arr);
      expect(result.data).toBeDefined();
      expect(result.shape.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("options", () => {
    it("defaults to deflate compression", async () => {
      const ms = await create2DMultiscales(8, 8);
      const buffer = await toOmeTiff(ms);

      const tiff = await fromArrayBuffer(buffer);
      const image = await tiff.getImage(0);
      expect(image.fileDirectory.getValue("Compression")).toBe(8);
    });

    it("respects compression: none", async () => {
      const ms = await create2DMultiscales(8, 8);
      const buffer = await toOmeTiff(ms, { compression: "none" });

      const tiff = await fromArrayBuffer(buffer);
      const image = await tiff.getImage(0);
      expect(image.fileDirectory.getValue("Compression")).toBe(1);
    });
  });
});
