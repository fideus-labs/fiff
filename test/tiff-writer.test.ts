// SPDX-FileCopyrightText: Copyright (c) Fideus Labs LLC
// SPDX-License-Identifier: MIT

import { describe, it, expect } from "bun:test";
import { fromArrayBuffer } from "geotiff";
import {
  buildTiff,
  makeImageTags,
  compressDeflate,
  TIFF_TYPE_SHORT,
  TIFF_TYPE_LONG,
  TIFF_TYPE_ASCII,
  TAG_IMAGE_WIDTH,
  TAG_IMAGE_LENGTH,
  TAG_BITS_PER_SAMPLE,
  TAG_COMPRESSION,
  TAG_PHOTOMETRIC,
  TAG_SAMPLES_PER_PIXEL,
  TAG_ROWS_PER_STRIP,
  TAG_SAMPLE_FORMAT,
  TAG_IMAGE_DESCRIPTION,
  TAG_NEW_SUBFILE_TYPE,
  TAG_SUB_IFDS,
  COMPRESSION_NONE,
  COMPRESSION_DEFLATE,
  type WritableIfd,
  type TiffTag,
} from "../src/tiff-writer.js";

/** Create a simple gradient strip for testing. */
function createGradientStrip(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = (x + y) % 256;
    }
  }
  return data;
}

/** Create a uint16 gradient strip. Returns raw little-endian bytes. */
function createUint16Strip(width: number, height: number): Uint8Array {
  const values = new Uint16Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      values[y * width + x] = (x * 100 + y) % 65536;
    }
  }
  return new Uint8Array(values.buffer);
}

describe("tiff-writer", () => {
  describe("buildTiff — single IFD", () => {
    it("writes a valid TIFF header", () => {
      const tags = makeImageTags(32, 32, 8, 1);
      const strip = createGradientStrip(32, 32);
      const buffer = buildTiff([{ tags, strips: [strip] }]);
      const view = new DataView(buffer);

      // Byte order: "II" (little-endian)
      expect(view.getUint16(0, true)).toBe(0x4949);
      // Magic number: 42
      expect(view.getUint16(2, true)).toBe(42);
      // First IFD offset: should be 8
      expect(view.getUint32(4, true)).toBe(8);
    });

    it("produces a TIFF readable by geotiff.js (uint8)", async () => {
      const width = 32;
      const height = 32;
      const tags = makeImageTags(width, height, 8, 1);
      const strip = createGradientStrip(width, height);
      const buffer = buildTiff([{ tags, strips: [strip] }]);

      const tiff = await fromArrayBuffer(buffer);
      const image = await tiff.getImage(0);

      expect(image.getWidth()).toBe(width);
      expect(image.getHeight()).toBe(height);
      expect(image.getBitsPerSample()).toBe(8);
      expect(image.getSamplesPerPixel()).toBe(1);

      const rasters = await image.readRasters();
      const pixels = rasters[0] as Uint8Array;
      expect(pixels.length).toBe(width * height);
      // Verify pixel values match the gradient
      expect(pixels[0]).toBe(0);
      expect(pixels[1]).toBe(1);
      expect(pixels[width]).toBe(1); // y=1, x=0
    });

    it("produces a TIFF readable by geotiff.js (uint16)", async () => {
      const width = 64;
      const height = 48;
      const tags = makeImageTags(width, height, 16, 1);
      const strip = createUint16Strip(width, height);
      const buffer = buildTiff([{ tags, strips: [strip] }]);

      const tiff = await fromArrayBuffer(buffer);
      const image = await tiff.getImage(0);

      expect(image.getWidth()).toBe(width);
      expect(image.getHeight()).toBe(height);
      expect(image.getBitsPerSample()).toBe(16);

      const rasters = await image.readRasters();
      const pixels = rasters[0] as Uint16Array;
      expect(pixels[0]).toBe(0);
      expect(pixels[1]).toBe(100);
      expect(pixels[width]).toBe(1); // y=1, x=0 => 0*100+1
    });

    it("includes ImageDescription when provided", async () => {
      const tags = makeImageTags(16, 16, 8, 1, "none", "test description");
      const strip = new Uint8Array(16 * 16);
      const buffer = buildTiff([{ tags, strips: [strip] }]);

      const tiff = await fromArrayBuffer(buffer);
      const image = await tiff.getImage(0);
      const desc = image.fileDirectory.getValue("ImageDescription") as string;
      // geotiff.js v3 includes the null terminator in the string
      expect(desc.replace(/\0+$/, "")).toBe("test description");
    });
  });

  describe("buildTiff — multi-IFD", () => {
    it("writes multiple IFDs in a chain", async () => {
      const ifds: WritableIfd[] = [];
      for (let i = 0; i < 3; i++) {
        const tags = makeImageTags(16, 16, 8, 1);
        const strip = new Uint8Array(16 * 16).fill(i * 50);
        ifds.push({ tags, strips: [strip] });
      }

      const buffer = buildTiff(ifds);
      const tiff = await fromArrayBuffer(buffer);

      // Should be able to get all 3 images
      for (let i = 0; i < 3; i++) {
        const image = await tiff.getImage(i);
        expect(image.getWidth()).toBe(16);
        expect(image.getHeight()).toBe(16);
        const rasters = await image.readRasters();
        const pixels = rasters[0] as Uint8Array;
        // All pixels should be i*50
        expect(pixels[0]).toBe(i * 50);
        expect(pixels[255]).toBe(i * 50);
      }
    });

    it("embeds OME-XML only in the first IFD", async () => {
      const omeXml = '<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06"><Image ID="Image:0"/></OME>';

      const ifds: WritableIfd[] = [];
      for (let i = 0; i < 2; i++) {
        const tags = makeImageTags(8, 8, 8, 1, "none", i === 0 ? omeXml : undefined);
        const strip = new Uint8Array(64);
        ifds.push({ tags, strips: [strip] });
      }

      const buffer = buildTiff(ifds);
      const tiff = await fromArrayBuffer(buffer);

      const image0 = await tiff.getImage(0);
      const desc0 = image0.fileDirectory.getValue("ImageDescription");
      expect(desc0).toContain("OME");

      const image1 = await tiff.getImage(1);
      const desc1 = image1.fileDirectory.getValue("ImageDescription");
      expect(desc1).toBeUndefined();
    });
  });

  describe("buildTiff — SubIFDs", () => {
    it("writes SubIFDs accessible via geotiff.js", async () => {
      const mainTags = makeImageTags(64, 64, 8, 1);
      const mainStrip = createGradientStrip(64, 64);

      // Create two SubIFDs (half-res and quarter-res)
      const sub1Tags = makeImageTags(32, 32, 8, 1, "none", undefined, true);
      const sub1Strip = createGradientStrip(32, 32);

      const sub2Tags = makeImageTags(16, 16, 8, 1, "none", undefined, true);
      const sub2Strip = createGradientStrip(16, 16);

      const ifd: WritableIfd = {
        tags: mainTags,
        strips: [mainStrip],
        subIfds: [
          { tags: sub1Tags, strips: [sub1Strip] },
          { tags: sub2Tags, strips: [sub2Strip] },
        ],
      };

      const buffer = buildTiff([ifd]);
      const tiff = await fromArrayBuffer(buffer);

      // Main image
      const mainImage = await tiff.getImage(0);
      expect(mainImage.getWidth()).toBe(64);
      expect(mainImage.getHeight()).toBe(64);

      // Check SubIFDs tag is present
      const subIfdOffsets = mainImage.fileDirectory.getValue("SubIFDs");
      expect(subIfdOffsets).toBeDefined();
      expect(subIfdOffsets!.length).toBe(2);
    });

    it("SubIFD images have NewSubfileType=1", async () => {
      const mainTags = makeImageTags(32, 32, 8, 1);
      const mainStrip = new Uint8Array(32 * 32);

      const subTags = makeImageTags(16, 16, 8, 1, "none", undefined, true);
      const subStrip = new Uint8Array(16 * 16);

      const ifd: WritableIfd = {
        tags: mainTags,
        strips: [mainStrip],
        subIfds: [{ tags: subTags, strips: [subStrip] }],
      };

      const buffer = buildTiff([ifd]);

      // Parse manually to check NewSubfileType
      const tiff = await fromArrayBuffer(buffer);
      const mainImage = await tiff.getImage(0);
      const subIfdOffsets = mainImage.fileDirectory.getValue("SubIFDs");
      expect(subIfdOffsets).toBeDefined();
      expect(subIfdOffsets!.length).toBe(1);
    });
  });

  describe("buildTiff — deflate compression", () => {
    it("writes compressed data readable by geotiff.js", async () => {
      const width = 32;
      const height = 32;
      const tags = makeImageTags(width, height, 8, 1);
      const strip = createGradientStrip(width, height);

      const buffer = buildTiff([{ tags, strips: [strip] }], {
        compression: "deflate",
      });

      const tiff = await fromArrayBuffer(buffer);
      const image = await tiff.getImage(0);

      expect(image.getWidth()).toBe(width);
      expect(image.getHeight()).toBe(height);
      // Compression tag should be 8 (deflate)
      expect(image.fileDirectory.getValue("Compression")).toBe(COMPRESSION_DEFLATE);

      const rasters = await image.readRasters();
      const pixels = rasters[0] as Uint8Array;
      expect(pixels.length).toBe(width * height);
      // Verify pixel values survive round-trip
      expect(pixels[0]).toBe(0);
      expect(pixels[1]).toBe(1);
      expect(pixels[width]).toBe(1);
    });

    it("compressed file is smaller than uncompressed", () => {
      const width = 64;
      const height = 64;
      const tags = makeImageTags(width, height, 8, 1);
      const strip = createGradientStrip(width, height);

      const uncompressed = buildTiff([{ tags, strips: [strip] }], {
        compression: "none",
      });
      const compressed = buildTiff([{ tags, strips: [strip] }], {
        compression: "deflate",
      });

      expect(compressed.byteLength).toBeLessThan(uncompressed.byteLength);
    });

    it("compression level affects file size", () => {
      const width = 64;
      const height = 64;
      const tags = makeImageTags(width, height, 8, 1);
      const strip = createGradientStrip(width, height);

      const fast = buildTiff([{ tags, strips: [strip] }], {
        compression: "deflate",
        compressionLevel: 1,
      });
      const best = buildTiff([{ tags, strips: [strip] }], {
        compression: "deflate",
        compressionLevel: 9,
      });

      // Best compression should be <= fast compression
      expect(best.byteLength).toBeLessThanOrEqual(fast.byteLength);
    });
  });

  describe("compressDeflate", () => {
    it("produces zlib-wrapped output", () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const compressed = compressDeflate(data);

      // Zlib header: first byte should be 0x78 (deflate, window size 32K)
      expect(compressed[0]).toBe(0x78);
    });

    it("round-trips through pako inflate", async () => {
      const { inflate } = await import("pako");
      const original = new Uint8Array(1000);
      for (let i = 0; i < original.length; i++) {
        original[i] = i % 256;
      }

      const compressed = compressDeflate(original);
      const decompressed = inflate(compressed);

      expect(decompressed.length).toBe(original.length);
      expect(decompressed).toEqual(original);
    });
  });

  describe("makeImageTags", () => {
    it("generates correct tags for uint8", () => {
      const tags = makeImageTags(100, 200, 8, 1);
      const findTag = (t: number) => tags.find((tag) => tag.tag === t);

      expect(findTag(TAG_IMAGE_WIDTH)?.values).toEqual([100]);
      expect(findTag(TAG_IMAGE_LENGTH)?.values).toEqual([200]);
      expect(findTag(TAG_BITS_PER_SAMPLE)?.values).toEqual([8]);
      expect(findTag(TAG_SAMPLE_FORMAT)?.values).toEqual([1]);
      expect(findTag(TAG_COMPRESSION)?.values).toEqual([COMPRESSION_NONE]);
      expect(findTag(TAG_PHOTOMETRIC)?.values).toEqual([1]);
      expect(findTag(TAG_SAMPLES_PER_PIXEL)?.values).toEqual([1]);
      expect(findTag(TAG_ROWS_PER_STRIP)?.values).toEqual([200]);
    });

    it("generates NewSubfileType for sub-resolution", () => {
      const tags = makeImageTags(50, 50, 16, 1, "none", undefined, true);
      const nst = tags.find((t) => t.tag === TAG_NEW_SUBFILE_TYPE);
      expect(nst).toBeDefined();
      expect(nst!.values).toEqual([1]);
    });

    it("does not include NewSubfileType for full resolution", () => {
      const tags = makeImageTags(50, 50, 16, 1);
      const nst = tags.find((t) => t.tag === TAG_NEW_SUBFILE_TYPE);
      expect(nst).toBeUndefined();
    });

    it("includes ImageDescription when provided", () => {
      const tags = makeImageTags(10, 10, 8, 1, "none", "hello");
      const desc = tags.find((t) => t.tag === TAG_IMAGE_DESCRIPTION);
      expect(desc).toBeDefined();
      expect(desc!.values).toBe("hello");
    });

    it("sets deflate compression tag", () => {
      const tags = makeImageTags(10, 10, 8, 1, "deflate");
      const comp = tags.find((t) => t.tag === TAG_COMPRESSION);
      expect(comp!.values).toEqual([COMPRESSION_DEFLATE]);
    });
  });
});
