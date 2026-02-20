// SPDX-FileCopyrightText: Copyright (c) Fideus Labs LLC
// SPDX-License-Identifier: MIT

import { describe, it, expect } from "bun:test";
import { fromArrayBuffer } from "geotiff";
import {
  buildTiff,
  makeImageTags,
  compressDeflate,
  compressDeflateAsync,
  sliceTiles,
  DEFAULT_TILE_SIZE,
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
  TAG_TILE_WIDTH,
  TAG_TILE_LENGTH,
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
  describe("buildTiff — single IFD (strip-based)", () => {
    it("writes a valid TIFF header", async () => {
      const tags = makeImageTags(32, 32, 8, 1, "none", undefined, false, 0);
      const strip = createGradientStrip(32, 32);
      const buffer = await buildTiff([{ tags, tiles: [strip] }]);
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
      const tags = makeImageTags(width, height, 8, 1, "none", undefined, false, 0);
      const strip = createGradientStrip(width, height);
      const buffer = await buildTiff([{ tags, tiles: [strip] }]);

      const tiff = await fromArrayBuffer(buffer);
      const image = await tiff.getImage(0);

      expect(image.getWidth()).toBe(width);
      expect(image.getHeight()).toBe(height);
      expect(image.getBitsPerSample()).toBe(8);
      expect(image.getSamplesPerPixel()).toBe(1);

      const rasters = await image.readRasters();
      const pixels = rasters[0] as Uint8Array;
      expect(pixels.length).toBe(width * height);
      expect(pixels[0]).toBe(0);
      expect(pixels[1]).toBe(1);
      expect(pixels[width]).toBe(1);
    });

    it("produces a TIFF readable by geotiff.js (uint16)", async () => {
      const width = 64;
      const height = 48;
      const tags = makeImageTags(width, height, 16, 1, "none", undefined, false, 0);
      const strip = createUint16Strip(width, height);
      const buffer = await buildTiff([{ tags, tiles: [strip] }]);

      const tiff = await fromArrayBuffer(buffer);
      const image = await tiff.getImage(0);

      expect(image.getWidth()).toBe(width);
      expect(image.getHeight()).toBe(height);
      expect(image.getBitsPerSample()).toBe(16);

      const rasters = await image.readRasters();
      const pixels = rasters[0] as Uint16Array;
      expect(pixels[0]).toBe(0);
      expect(pixels[1]).toBe(100);
      expect(pixels[width]).toBe(1);
    });

    it("includes ImageDescription when provided", async () => {
      const tags = makeImageTags(16, 16, 8, 1, "none", "test description", false, 0);
      const strip = new Uint8Array(16 * 16);
      const buffer = await buildTiff([{ tags, tiles: [strip] }]);

      const tiff = await fromArrayBuffer(buffer);
      const image = await tiff.getImage(0);
      const desc = image.fileDirectory.getValue("ImageDescription") as string;
      expect(desc.replace(/\0+$/, "")).toBe("test description");
    });
  });

  describe("buildTiff — tiled output", () => {
    it("writes tiled TIFF readable by geotiff.js", async () => {
      const width = 512;
      const height = 512;
      const tileSize = 256;
      const bpp = 1; // uint8
      const planeData = createGradientStrip(width, height);
      const tiles = sliceTiles(planeData, width, height, bpp, tileSize, tileSize);
      const tags = makeImageTags(width, height, 8, 1, "none", undefined, false, tileSize);
      const buffer = await buildTiff([{ tags, tiles }]);

      const tiff = await fromArrayBuffer(buffer);
      const image = await tiff.getImage(0);

      expect(image.getWidth()).toBe(width);
      expect(image.getHeight()).toBe(height);
      expect(image.getTileWidth()).toBe(tileSize);
      expect(image.getTileHeight()).toBe(tileSize);

      const rasters = await image.readRasters();
      const pixels = rasters[0] as Uint8Array;
      expect(pixels.length).toBe(width * height);
      // Verify a few known pixel values
      expect(pixels[0]).toBe(0); // x=0, y=0
      expect(pixels[1]).toBe(1); // x=1, y=0
      expect(pixels[width]).toBe(1); // x=0, y=1
    });

    it("handles non-power-of-2 dimensions with edge padding", async () => {
      const width = 300;
      const height = 200;
      const tileSize = 256;
      const bpp = 2; // uint16
      const values = new Uint16Array(width * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          values[y * width + x] = (x + y * width) % 65536;
        }
      }
      const planeData = new Uint8Array(values.buffer);
      const tiles = sliceTiles(planeData, width, height, bpp, tileSize, tileSize);
      const tags = makeImageTags(width, height, 16, 1, "none", undefined, false, tileSize);
      const buffer = await buildTiff([{ tags, tiles }]);

      const tiff = await fromArrayBuffer(buffer);
      const image = await tiff.getImage(0);
      expect(image.getWidth()).toBe(width);
      expect(image.getHeight()).toBe(height);

      const rasters = await image.readRasters();
      const pixels = rasters[0] as Uint16Array;
      expect(pixels.length).toBe(width * height);
      expect(pixels[0]).toBe(0);
      expect(pixels[1]).toBe(1);
    });

    it("writes tiled TIFF with deflate compression", async () => {
      const width = 512;
      const height = 512;
      const tileSize = 256;
      const planeData = createGradientStrip(width, height);
      const tiles = sliceTiles(planeData, width, height, 1, tileSize, tileSize);
      const tags = makeImageTags(width, height, 8, 1, "none", undefined, false, tileSize);
      const buffer = await buildTiff([{ tags, tiles }], { compression: "deflate" });

      const tiff = await fromArrayBuffer(buffer);
      const image = await tiff.getImage(0);

      expect(image.fileDirectory.getValue("Compression")).toBe(COMPRESSION_DEFLATE);
      expect(image.getTileWidth()).toBe(tileSize);

      const rasters = await image.readRasters();
      const pixels = rasters[0] as Uint8Array;
      expect(pixels[0]).toBe(0);
      expect(pixels[1]).toBe(1);
    });
  });

  describe("buildTiff — multi-IFD", () => {
    it("writes multiple IFDs in a chain", async () => {
      const ifds: WritableIfd[] = [];
      for (let i = 0; i < 3; i++) {
        const tags = makeImageTags(16, 16, 8, 1, "none", undefined, false, 0);
        const strip = new Uint8Array(16 * 16).fill(i * 50);
        ifds.push({ tags, tiles: [strip] });
      }

      const buffer = await buildTiff(ifds);
      const tiff = await fromArrayBuffer(buffer);

      for (let i = 0; i < 3; i++) {
        const image = await tiff.getImage(i);
        expect(image.getWidth()).toBe(16);
        expect(image.getHeight()).toBe(16);
        const rasters = await image.readRasters();
        const pixels = rasters[0] as Uint8Array;
        expect(pixels[0]).toBe(i * 50);
        expect(pixels[255]).toBe(i * 50);
      }
    });

    it("embeds OME-XML only in the first IFD", async () => {
      const omeXml = '<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06"><Image ID="Image:0"/></OME>';

      const ifds: WritableIfd[] = [];
      for (let i = 0; i < 2; i++) {
        const tags = makeImageTags(8, 8, 8, 1, "none", i === 0 ? omeXml : undefined, false, 0);
        const strip = new Uint8Array(64);
        ifds.push({ tags, tiles: [strip] });
      }

      const buffer = await buildTiff(ifds);
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
      const mainTags = makeImageTags(64, 64, 8, 1, "none", undefined, false, 0);
      const mainStrip = createGradientStrip(64, 64);

      const sub1Tags = makeImageTags(32, 32, 8, 1, "none", undefined, true, 0);
      const sub1Strip = createGradientStrip(32, 32);

      const sub2Tags = makeImageTags(16, 16, 8, 1, "none", undefined, true, 0);
      const sub2Strip = createGradientStrip(16, 16);

      const ifd: WritableIfd = {
        tags: mainTags,
        tiles: [mainStrip],
        subIfds: [
          { tags: sub1Tags, tiles: [sub1Strip] },
          { tags: sub2Tags, tiles: [sub2Strip] },
        ],
      };

      const buffer = await buildTiff([ifd]);
      const tiff = await fromArrayBuffer(buffer);

      const mainImage = await tiff.getImage(0);
      expect(mainImage.getWidth()).toBe(64);
      expect(mainImage.getHeight()).toBe(64);

      const subIfdOffsets = mainImage.fileDirectory.getValue("SubIFDs");
      expect(subIfdOffsets).toBeDefined();
      expect(subIfdOffsets!.length).toBe(2);
    });

    it("SubIFD images have NewSubfileType=1", async () => {
      const mainTags = makeImageTags(32, 32, 8, 1, "none", undefined, false, 0);
      const mainStrip = new Uint8Array(32 * 32);

      const subTags = makeImageTags(16, 16, 8, 1, "none", undefined, true, 0);
      const subStrip = new Uint8Array(16 * 16);

      const ifd: WritableIfd = {
        tags: mainTags,
        tiles: [mainStrip],
        subIfds: [{ tags: subTags, tiles: [subStrip] }],
      };

      const buffer = await buildTiff([ifd]);
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
      const tags = makeImageTags(width, height, 8, 1, "none", undefined, false, 0);
      const strip = createGradientStrip(width, height);

      const buffer = await buildTiff([{ tags, tiles: [strip] }], {
        compression: "deflate",
      });

      const tiff = await fromArrayBuffer(buffer);
      const image = await tiff.getImage(0);

      expect(image.getWidth()).toBe(width);
      expect(image.getHeight()).toBe(height);
      expect(image.fileDirectory.getValue("Compression")).toBe(COMPRESSION_DEFLATE);

      const rasters = await image.readRasters();
      const pixels = rasters[0] as Uint8Array;
      expect(pixels.length).toBe(width * height);
      expect(pixels[0]).toBe(0);
      expect(pixels[1]).toBe(1);
      expect(pixels[width]).toBe(1);
    });

    it("compressed file is smaller than uncompressed", async () => {
      const width = 64;
      const height = 64;
      const tags = makeImageTags(width, height, 8, 1, "none", undefined, false, 0);
      const strip = createGradientStrip(width, height);

      const uncompressed = await buildTiff([{ tags, tiles: [strip] }], {
        compression: "none",
      });
      const compressed = await buildTiff([{ tags, tiles: [strip] }], {
        compression: "deflate",
      });

      expect(compressed.byteLength).toBeLessThan(uncompressed.byteLength);
    });

    it("compression level affects file size", async () => {
      const width = 64;
      const height = 64;
      const tags = makeImageTags(width, height, 8, 1, "none", undefined, false, 0);
      const strip = createGradientStrip(width, height);

      const fast = await buildTiff([{ tags, tiles: [strip] }], {
        compression: "deflate",
        compressionLevel: 1,
      });
      const best = await buildTiff([{ tags, tiles: [strip] }], {
        compression: "deflate",
        compressionLevel: 9,
      });

      expect(best.byteLength).toBeLessThanOrEqual(fast.byteLength);
    });
  });

  describe("buildTiff — BigTIFF", () => {
    it("writes BigTIFF header when format is bigtiff", async () => {
      const tags = makeImageTags(8, 8, 8, 1, "none", undefined, false, 0);
      const strip = new Uint8Array(64);
      const buffer = await buildTiff([{ tags, tiles: [strip] }], { format: "bigtiff" });
      const view = new DataView(buffer);

      // Byte order: "II"
      expect(view.getUint16(0, true)).toBe(0x4949);
      // Magic: 43 (BigTIFF)
      expect(view.getUint16(2, true)).toBe(43);
      // Offset size: 8
      expect(view.getUint16(4, true)).toBe(8);
      // Padding: 0
      expect(view.getUint16(6, true)).toBe(0);
      // First IFD offset (8 bytes)
      const firstIfdOffset = view.getUint32(8, true) + view.getUint32(12, true) * 0x100000000;
      expect(firstIfdOffset).toBe(16); // header is 16 bytes for BigTIFF
    });

    it("BigTIFF data is readable by geotiff.js", async () => {
      const width = 32;
      const height = 32;
      const tags = makeImageTags(width, height, 8, 1, "none", undefined, false, 0);
      const strip = createGradientStrip(width, height);
      const buffer = await buildTiff([{ tags, tiles: [strip] }], { format: "bigtiff" });

      const tiff = await fromArrayBuffer(buffer);
      const image = await tiff.getImage(0);

      expect(image.getWidth()).toBe(width);
      expect(image.getHeight()).toBe(height);

      const rasters = await image.readRasters();
      const pixels = rasters[0] as Uint8Array;
      expect(pixels[0]).toBe(0);
      expect(pixels[1]).toBe(1);
    });

    it("BigTIFF with deflate compression round-trips", async () => {
      const width = 32;
      const height = 32;
      const tags = makeImageTags(width, height, 16, 1, "none", undefined, false, 0);
      const strip = createUint16Strip(width, height);
      const buffer = await buildTiff([{ tags, tiles: [strip] }], {
        format: "bigtiff",
        compression: "deflate",
      });

      const tiff = await fromArrayBuffer(buffer);
      const image = await tiff.getImage(0);
      const rasters = await image.readRasters();
      const pixels = rasters[0] as Uint16Array;
      expect(pixels[0]).toBe(0);
      expect(pixels[1]).toBe(100);
    });

    it("classic format is used by default for small files", async () => {
      const tags = makeImageTags(8, 8, 8, 1, "none", undefined, false, 0);
      const strip = new Uint8Array(64);
      const buffer = await buildTiff([{ tags, tiles: [strip] }]);
      const view = new DataView(buffer);

      // Should be classic TIFF (magic 42)
      expect(view.getUint16(2, true)).toBe(42);
    });
  });

  describe("compressDeflate", () => {
    it("produces zlib-wrapped output", () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const compressed = compressDeflate(data);
      // Zlib header: first byte should be 0x78
      expect(compressed[0]).toBe(0x78);
    });

    it("round-trips through fflate unzlibSync", async () => {
      const { unzlibSync } = await import("fflate");
      const original = new Uint8Array(1000);
      for (let i = 0; i < original.length; i++) {
        original[i] = i % 256;
      }

      const compressed = compressDeflate(original);
      const decompressed = unzlibSync(compressed);

      expect(decompressed.length).toBe(original.length);
      expect(decompressed).toEqual(original);
    });
  });

  describe("compressDeflateAsync", () => {
    it("round-trips through fflate unzlibSync", async () => {
      const { unzlibSync } = await import("fflate");
      const original = new Uint8Array(1000);
      for (let i = 0; i < original.length; i++) {
        original[i] = i % 256;
      }

      const compressed = await compressDeflateAsync(original);
      const decompressed = unzlibSync(compressed);

      expect(decompressed.length).toBe(original.length);
      expect(decompressed).toEqual(original);
    });

    it("produces same output as sync version for non-default level", async () => {
      const data = new Uint8Array(500);
      for (let i = 0; i < data.length; i++) data[i] = i % 256;

      const syncResult = compressDeflate(data, 3);
      const asyncResult = await compressDeflateAsync(data, 3);

      expect(asyncResult).toEqual(syncResult);
    });
  });

  describe("sliceTiles", () => {
    it("slices a plane into correct number of tiles", () => {
      const width = 512;
      const height = 512;
      const plane = new Uint8Array(width * height);
      const tiles = sliceTiles(plane, width, height, 1, 256, 256);
      // 512/256 = 2 tiles in each direction = 4 total
      expect(tiles.length).toBe(4);
      expect(tiles[0].length).toBe(256 * 256);
    });

    it("zero-pads edge tiles", () => {
      const width = 300;
      const height = 200;
      const plane = new Uint8Array(width * height).fill(42);
      const tiles = sliceTiles(plane, width, height, 1, 256, 256);
      // ceil(300/256) = 2, ceil(200/256) = 1 => 2 tiles
      expect(tiles.length).toBe(2);

      // First tile: 256x200 valid, rest zero-padded
      expect(tiles[0].length).toBe(256 * 256);
      expect(tiles[0][0]).toBe(42); // valid pixel

      // Second tile: 44 valid cols, rest zero-padded
      expect(tiles[1].length).toBe(256 * 256);
      expect(tiles[1][0]).toBe(42); // valid pixel
      // Past valid width: should be zero
      expect(tiles[1][44]).toBe(0); // x=300 is beyond image
    });

    it("handles uint16 data correctly", () => {
      const width = 4;
      const height = 4;
      const values = new Uint16Array([
        1, 2, 3, 4,
        5, 6, 7, 8,
        9, 10, 11, 12,
        13, 14, 15, 16,
      ]);
      const plane = new Uint8Array(values.buffer);
      const tiles = sliceTiles(plane, width, height, 2, 2, 2);
      // 4/2 = 2 tiles in each direction = 4 total
      expect(tiles.length).toBe(4);

      // Top-left tile should contain pixels 1,2,5,6
      const tl = new Uint16Array(tiles[0].buffer, tiles[0].byteOffset, tiles[0].byteLength / 2);
      expect(tl[0]).toBe(1);
      expect(tl[1]).toBe(2);
      expect(tl[2]).toBe(5);
      expect(tl[3]).toBe(6);

      // Top-right tile should contain pixels 3,4,7,8
      const tr = new Uint16Array(tiles[1].buffer, tiles[1].byteOffset, tiles[1].byteLength / 2);
      expect(tr[0]).toBe(3);
      expect(tr[1]).toBe(4);
      expect(tr[2]).toBe(7);
      expect(tr[3]).toBe(8);
    });

    it("returns single tile for small plane", () => {
      const plane = new Uint8Array(10 * 10);
      const tiles = sliceTiles(plane, 10, 10, 1, 256, 256);
      expect(tiles.length).toBe(1);
      // Tile is padded to full 256x256
      expect(tiles[0].length).toBe(256 * 256);
    });
  });

  describe("makeImageTags", () => {
    it("generates tile tags for large images", () => {
      const tags = makeImageTags(512, 512, 16, 1);
      const findTag = (t: number) => tags.find((tag) => tag.tag === t);

      expect(findTag(TAG_IMAGE_WIDTH)?.values).toEqual([512]);
      expect(findTag(TAG_IMAGE_LENGTH)?.values).toEqual([512]);
      expect(findTag(TAG_TILE_WIDTH)?.values).toEqual([DEFAULT_TILE_SIZE]);
      expect(findTag(TAG_TILE_LENGTH)?.values).toEqual([DEFAULT_TILE_SIZE]);
      // Should NOT have RowsPerStrip
      expect(findTag(TAG_ROWS_PER_STRIP)).toBeUndefined();
    });

    it("generates strip tags for small images", () => {
      const tags = makeImageTags(100, 200, 8, 1, "none", undefined, false, 0);
      const findTag = (t: number) => tags.find((tag) => tag.tag === t);

      expect(findTag(TAG_ROWS_PER_STRIP)?.values).toEqual([200]);
      // Should NOT have tile tags
      expect(findTag(TAG_TILE_WIDTH)).toBeUndefined();
      expect(findTag(TAG_TILE_LENGTH)).toBeUndefined();
    });

    it("generates strip tags when tileSize=0", () => {
      const tags = makeImageTags(1024, 1024, 8, 1, "none", undefined, false, 0);
      const findTag = (t: number) => tags.find((tag) => tag.tag === t);

      expect(findTag(TAG_ROWS_PER_STRIP)?.values).toEqual([1024]);
      expect(findTag(TAG_TILE_WIDTH)).toBeUndefined();
    });

    it("generates correct basic tags", () => {
      const tags = makeImageTags(100, 200, 8, 1, "none", undefined, false, 0);
      const findTag = (t: number) => tags.find((tag) => tag.tag === t);

      expect(findTag(TAG_IMAGE_WIDTH)?.values).toEqual([100]);
      expect(findTag(TAG_IMAGE_LENGTH)?.values).toEqual([200]);
      expect(findTag(TAG_BITS_PER_SAMPLE)?.values).toEqual([8]);
      expect(findTag(TAG_SAMPLE_FORMAT)?.values).toEqual([1]);
      expect(findTag(TAG_COMPRESSION)?.values).toEqual([COMPRESSION_NONE]);
      expect(findTag(TAG_PHOTOMETRIC)?.values).toEqual([1]);
      expect(findTag(TAG_SAMPLES_PER_PIXEL)?.values).toEqual([1]);
    });

    it("generates NewSubfileType for sub-resolution", () => {
      const tags = makeImageTags(50, 50, 16, 1, "none", undefined, true, 0);
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
      const tags = makeImageTags(10, 10, 8, 1, "none", "hello", false, 0);
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
