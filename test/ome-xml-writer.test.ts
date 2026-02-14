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
} from "@fideus-labs/ngff-zarr";
import {
  buildOmeXml,
  extractDimensions,
  hexColorToOmeInt,
  omeIntToHexColor,
} from "../src/ome-xml-writer.js";
import { parseOmeXml, isOmeXml } from "../src/ome-xml.js";
import type { ZarrDataType } from "../src/dtypes.js";

/** Create a simple 3D (y, x) Multiscales for testing. */
async function createSimpleMultiscales(
  width: number,
  height: number,
  dtype: string = "uint16",
): Promise<Multiscales> {
  const data = new Array(width * height).fill(0);
  const image = await createNgffImage(
    data,
    [height, width],
    dtype,
    ["y", "x"],
    { y: 0.5, x: 0.5 },
    { y: 0.0, x: 0.0 },
    "test-image",
  );

  const axes = [
    createAxis("y", "space", "micrometer"),
    createAxis("x", "space", "micrometer"),
  ];
  const datasets = [createDataset("0", [0.5, 0.5], [0.0, 0.0])];
  const metadata = createMetadata(axes, datasets, "test-image");

  return createMultiscales([image], metadata);
}

/** Create a 5D (t, c, z, y, x) Multiscales for testing. */
async function create5DMultiscales(
  sizeT: number,
  sizeC: number,
  sizeZ: number,
  height: number,
  width: number,
  dtype: string = "uint16",
  omero?: Omero,
): Promise<Multiscales> {
  const totalPixels = sizeT * sizeC * sizeZ * height * width;
  const data = new Array(totalPixels).fill(0);
  const image = await createNgffImage(
    data,
    [sizeT, sizeC, sizeZ, height, width],
    dtype,
    ["t", "c", "z", "y", "x"],
    { t: 1.0, c: 1.0, z: 2.0, y: 0.5, x: 0.5 },
    { t: 0.0, c: 0.0, z: 0.0, y: 0.0, x: 0.0 },
    "5d-image",
  );

  const axes = [
    createAxis("t", "time", "second"),
    createAxis("c", "channel"),
    createAxis("z", "space", "micrometer"),
    createAxis("y", "space", "micrometer"),
    createAxis("x", "space", "micrometer"),
  ];
  const datasets = [createDataset("0", [1.0, 1.0, 2.0, 0.5, 0.5], [0, 0, 0, 0, 0])];
  const meta = createMetadata(axes, datasets, "5d-image");
  // Attach omero if provided
  if (omero) {
    (meta as any).omero = omero;
  }

  return createMultiscales([image], meta);
}

describe("ome-xml-writer", () => {
  describe("buildOmeXml", () => {
    it("generates valid OME-XML for a simple 2D image", async () => {
      const ms = await createSimpleMultiscales(64, 48);
      const xml = buildOmeXml(ms, "uint16");

      expect(isOmeXml(xml)).toBe(true);
      expect(xml).toContain('xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06"');
      expect(xml).toContain('Creator="fiff"');
      expect(xml).toContain('SizeX="64"');
      expect(xml).toContain('SizeY="48"');
      expect(xml).toContain('SizeZ="1"');
      expect(xml).toContain('SizeC="1"');
      expect(xml).toContain('SizeT="1"');
      expect(xml).toContain('Type="uint16"');
      expect(xml).toContain('DimensionOrder="XYZCT"');
      expect(xml).toContain('BigEndian="false"');
      expect(xml).toContain("<TiffData/>");
    });

    it("generates parseable XML round-tripping through parseOmeXml", async () => {
      const ms = await createSimpleMultiscales(32, 24);
      const xml = buildOmeXml(ms, "uint8");

      const images = parseOmeXml(xml);
      expect(images.length).toBe(1);

      const pixels = images[0].pixels;
      expect(pixels.sizeX).toBe(32);
      expect(pixels.sizeY).toBe(24);
      expect(pixels.sizeZ).toBe(1);
      expect(pixels.sizeC).toBe(1);
      expect(pixels.sizeT).toBe(1);
      expect(pixels.type.toLowerCase()).toBe("uint8");
    });

    it("generates 5D image metadata", async () => {
      const ms = await create5DMultiscales(2, 3, 5, 64, 64);
      const xml = buildOmeXml(ms, "uint16");

      const images = parseOmeXml(xml);
      const pixels = images[0].pixels;
      expect(pixels.sizeT).toBe(2);
      expect(pixels.sizeC).toBe(3);
      expect(pixels.sizeZ).toBe(5);
      expect(pixels.sizeX).toBe(64);
      expect(pixels.sizeY).toBe(64);
    });

    it("includes channel elements from omero metadata", async () => {
      const omero: Omero = {
        channels: [
          { color: "FF0000", window: { min: 0, max: 255 }, label: "DAPI" },
          { color: "00FF00", window: { min: 0, max: 255 }, label: "GFP" },
        ],
      };
      const ms = await create5DMultiscales(1, 2, 1, 16, 16, "uint8", omero);
      const xml = buildOmeXml(ms, "uint8");

      expect(xml).toContain('Name="DAPI"');
      expect(xml).toContain('Name="GFP"');
      expect(xml).toContain('Channel ID="Channel:0:0"');
      expect(xml).toContain('Channel ID="Channel:0:1"');
    });

    it("includes physical sizes from axis metadata", async () => {
      const ms = await createSimpleMultiscales(32, 32);
      const xml = buildOmeXml(ms, "uint16");

      expect(xml).toContain('PhysicalSizeX="0.5"');
      expect(xml).toContain('PhysicalSizeY="0.5"');
    });

    it("maps NGFF unit names to OME-XML symbols", async () => {
      const ms = await createSimpleMultiscales(32, 32);
      const xml = buildOmeXml(ms, "uint16");

      // "micrometer" should become "µm" (U+00B5)
      expect(xml).toContain("PhysicalSizeXUnit=\"\u00B5m\"");
    });

    it("includes physical size Z for 3D images", async () => {
      const ms = await create5DMultiscales(1, 1, 10, 32, 32);
      const xml = buildOmeXml(ms, "uint16");

      expect(xml).toContain('PhysicalSizeZ="2"');
    });

    it("supports all Zarr data types", async () => {
      const dtypes: ZarrDataType[] = [
        "uint8", "uint16", "uint32",
        "int8", "int16", "int32",
        "float32", "float64",
      ];
      const omeTypes = [
        "uint8", "uint16", "uint32",
        "int8", "int16", "int32",
        "float", "double",
      ];

      for (let i = 0; i < dtypes.length; i++) {
        const ms = await createSimpleMultiscales(4, 4, dtypes[i]);
        const xml = buildOmeXml(ms, dtypes[i]);
        expect(xml).toContain(`Type="${omeTypes[i]}"`);
      }
    });

    it("respects custom DimensionOrder", async () => {
      const ms = await create5DMultiscales(1, 2, 3, 8, 8);
      const xml = buildOmeXml(ms, "uint16", { dimensionOrder: "XYCZT" });
      expect(xml).toContain('DimensionOrder="XYCZT"');
    });

    it("respects custom creator", async () => {
      const ms = await createSimpleMultiscales(8, 8);
      const xml = buildOmeXml(ms, "uint8", { creator: "my-tool v1.0" });
      expect(xml).toContain('Creator="my-tool v1.0"');
    });

    it("respects custom image name", async () => {
      const ms = await createSimpleMultiscales(8, 8);
      const xml = buildOmeXml(ms, "uint8", { imageName: "custom-name" });
      expect(xml).toContain('Name="custom-name"');
    });

    it("escapes XML special characters in strings", async () => {
      const ms = await createSimpleMultiscales(8, 8);
      const xml = buildOmeXml(ms, "uint8", { imageName: 'test<>&"name' });
      expect(xml).toContain("test&lt;&gt;&amp;&quot;name");
    });
  });

  describe("extractDimensions", () => {
    it("extracts dimensions from a 2D image", async () => {
      const ms = await createSimpleMultiscales(64, 48);
      const dims = extractDimensions(ms);

      expect(dims.sizeX).toBe(64);
      expect(dims.sizeY).toBe(48);
      expect(dims.sizeZ).toBe(1);
      expect(dims.sizeC).toBe(1);
      expect(dims.sizeT).toBe(1);
    });

    it("extracts dimensions from a 5D image", async () => {
      const ms = await create5DMultiscales(2, 3, 5, 128, 256);
      const dims = extractDimensions(ms);

      expect(dims.sizeT).toBe(2);
      expect(dims.sizeC).toBe(3);
      expect(dims.sizeZ).toBe(5);
      expect(dims.sizeY).toBe(128);
      expect(dims.sizeX).toBe(256);
    });

    it("extracts physical sizes", async () => {
      const ms = await createSimpleMultiscales(32, 32);
      const dims = extractDimensions(ms);

      expect(dims.physicalSizeX).toBe(0.5);
      expect(dims.physicalSizeY).toBe(0.5);
    });
  });

  describe("hexColorToOmeInt / omeIntToHexColor", () => {
    it("converts red to negative int", () => {
      expect(hexColorToOmeInt("FF0000")).toBe(-16776961);
    });

    it("converts green to positive int", () => {
      expect(hexColorToOmeInt("00FF00")).toBe(16711935);
    });

    it("converts blue to positive int", () => {
      expect(hexColorToOmeInt("0000FF")).toBe(65535);
    });

    it("handles leading #", () => {
      expect(hexColorToOmeInt("#FF0000")).toBe(-16776961);
    });

    it("round-trips through omeIntToHexColor", () => {
      const colors = ["FF0000", "00FF00", "0000FF", "FFFF00", "00FFFF", "FF00FF", "FFFFFF", "000000"];
      for (const color of colors) {
        const int = hexColorToOmeInt(color);
        const back = omeIntToHexColor(int);
        expect(back).toBe(color);
      }
    });
  });
});
