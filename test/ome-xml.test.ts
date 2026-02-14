import { describe, it, expect } from "bun:test";
import {
  isOmeXml,
  parseOmeXml,
  getIfdIndex,
  normalizeUnit,
  type OmePixels,
} from "../src/ome-xml.js";
import { createOmeTiffXml } from "./fixtures.js";

describe("isOmeXml", () => {
  it("detects XML processing instruction", () => {
    expect(isOmeXml('<?xml version="1.0"?><OME/>')).toBe(true);
  });

  it("detects OME root element", () => {
    expect(isOmeXml("<OME>...</OME>")).toBe(true);
  });

  it("detects namespaced OME element", () => {
    expect(isOmeXml("<ome:OME>...</ome:OME>")).toBe(true);
  });

  it("rejects non-OME XML", () => {
    expect(isOmeXml("<html><body/></html>")).toBe(false);
    expect(isOmeXml("not xml at all")).toBe(false);
    expect(isOmeXml("")).toBe(false);
  });

  it("handles leading whitespace", () => {
    expect(isOmeXml("  \n  <OME/>")).toBe(true);
  });
});

describe("parseOmeXml", () => {
  it("parses a simple single-channel OME-XML", () => {
    const xml = createOmeTiffXml(256, 256, 1, 1, 1);
    const images = parseOmeXml(xml);

    expect(images).toHaveLength(1);
    expect(images[0].id).toBe("Image:0");
    expect(images[0].name).toBe("test");
    expect(images[0].pixels.sizeX).toBe(256);
    expect(images[0].pixels.sizeY).toBe(256);
    expect(images[0].pixels.sizeC).toBe(1);
    expect(images[0].pixels.sizeZ).toBe(1);
    expect(images[0].pixels.sizeT).toBe(1);
    expect(images[0].pixels.dimensionOrder).toBe("XYZCT");
    expect(images[0].pixels.type).toBe("uint16");
    expect(images[0].pixels.channels).toHaveLength(1);
  });

  it("parses multi-channel OME-XML", () => {
    const xml = createOmeTiffXml(128, 128, 3, 1, 1);
    const images = parseOmeXml(xml);

    expect(images[0].pixels.sizeC).toBe(3);
    expect(images[0].pixels.channels).toHaveLength(3);
    expect(images[0].pixels.channels[0].name).toBe("Ch0");
    expect(images[0].pixels.channels[1].name).toBe("Ch1");
    expect(images[0].pixels.channels[2].name).toBe("Ch2");
  });

  it("parses multi-dimensional OME-XML", () => {
    const xml = createOmeTiffXml(64, 64, 2, 5, 3);
    const images = parseOmeXml(xml);

    expect(images[0].pixels.sizeC).toBe(2);
    expect(images[0].pixels.sizeZ).toBe(5);
    expect(images[0].pixels.sizeT).toBe(3);
  });

  it("parses physical pixel sizes", () => {
    const xml = createOmeTiffXml(64, 64, 1, 5, 1, "uint16", 0.325, 0.325, 1.5);
    const images = parseOmeXml(xml);

    expect(images[0].pixels.physicalSizeX).toBeCloseTo(0.325);
    expect(images[0].pixels.physicalSizeY).toBeCloseTo(0.325);
    expect(images[0].pixels.physicalSizeZ).toBeCloseTo(1.5);
  });

  it("parses channel colors", () => {
    const xml = createOmeTiffXml(64, 64, 2, 1, 1);
    const images = parseOmeXml(xml);

    // Colors are specified in the fixture as RGBA integers
    expect(images[0].pixels.channels[0].color).toBeDefined();
    expect(images[0].pixels.channels[1].color).toBeDefined();
  });

  it("parses custom image name", () => {
    const xml = createOmeTiffXml(64, 64, 1, 1, 1, "uint16", undefined, undefined, undefined, "MyImage");
    const images = parseOmeXml(xml);
    expect(images[0].name).toBe("MyImage");
  });

  it("handles different pixel types", () => {
    for (const type of ["uint8", "uint16", "uint32", "int16", "float", "double"]) {
      const xml = createOmeTiffXml(32, 32, 1, 1, 1, type);
      const images = parseOmeXml(xml);
      expect(images[0].pixels.type).toBe(type);
    }
  });
});

describe("getIfdIndex", () => {
  it("computes XYZCT ordering correctly", () => {
    const pixels = {
      sizeZ: 5,
      sizeC: 3,
      sizeT: 2,
      dimensionOrder: "XYZCT" as const,
    } as OmePixels;

    // Z varies fastest
    expect(getIfdIndex(0, 0, 0, pixels)).toBe(0);
    expect(getIfdIndex(0, 1, 0, pixels)).toBe(1);
    expect(getIfdIndex(0, 4, 0, pixels)).toBe(4);
    // Then C
    expect(getIfdIndex(1, 0, 0, pixels)).toBe(5);
    expect(getIfdIndex(2, 0, 0, pixels)).toBe(10);
    // Then T
    expect(getIfdIndex(0, 0, 1, pixels)).toBe(15);
    // Complex index
    expect(getIfdIndex(1, 2, 1, pixels)).toBe(1 * 5 + 2 + 1 * 5 * 3);
  });

  it("computes XYCZT ordering correctly", () => {
    const pixels = {
      sizeZ: 3,
      sizeC: 2,
      sizeT: 4,
      dimensionOrder: "XYCZT" as const,
    } as OmePixels;

    // C varies fastest
    expect(getIfdIndex(0, 0, 0, pixels)).toBe(0);
    expect(getIfdIndex(1, 0, 0, pixels)).toBe(1);
    // Then Z
    expect(getIfdIndex(0, 1, 0, pixels)).toBe(2);
    expect(getIfdIndex(1, 2, 0, pixels)).toBe(1 + 2 * 2);
    // Then T
    expect(getIfdIndex(0, 0, 1, pixels)).toBe(6);
  });

  it("computes XYCTZ ordering correctly", () => {
    const pixels = {
      sizeZ: 2,
      sizeC: 3,
      sizeT: 2,
      dimensionOrder: "XYCTZ" as const,
    } as OmePixels;

    expect(getIfdIndex(0, 0, 0, pixels)).toBe(0);
    expect(getIfdIndex(1, 0, 0, pixels)).toBe(1);
    expect(getIfdIndex(0, 0, 1, pixels)).toBe(3);
    expect(getIfdIndex(0, 1, 0, pixels)).toBe(6);
  });

  it("computes XYZTC ordering correctly", () => {
    const pixels = {
      sizeZ: 3,
      sizeC: 2,
      sizeT: 2,
      dimensionOrder: "XYZTC" as const,
    } as OmePixels;

    // Z varies fastest, then T, then C
    expect(getIfdIndex(0, 0, 0, pixels)).toBe(0);
    expect(getIfdIndex(0, 2, 0, pixels)).toBe(2);
    expect(getIfdIndex(0, 0, 1, pixels)).toBe(3);
    expect(getIfdIndex(1, 0, 0, pixels)).toBe(6);
  });

  it("computes XYTCZ ordering correctly", () => {
    const pixels = {
      sizeZ: 2,
      sizeC: 2,
      sizeT: 3,
      dimensionOrder: "XYTCZ" as const,
    } as OmePixels;

    // T varies fastest, then C, then Z
    expect(getIfdIndex(0, 0, 0, pixels)).toBe(0);
    expect(getIfdIndex(0, 0, 1, pixels)).toBe(1);
    expect(getIfdIndex(1, 0, 0, pixels)).toBe(3);
    expect(getIfdIndex(0, 1, 0, pixels)).toBe(6);
  });

  it("computes XYTZC ordering correctly", () => {
    const pixels = {
      sizeZ: 2,
      sizeC: 3,
      sizeT: 2,
      dimensionOrder: "XYTZC" as const,
    } as OmePixels;

    // T varies fastest, then Z, then C
    expect(getIfdIndex(0, 0, 0, pixels)).toBe(0);
    expect(getIfdIndex(0, 0, 1, pixels)).toBe(1);
    expect(getIfdIndex(0, 1, 0, pixels)).toBe(2);
    expect(getIfdIndex(1, 0, 0, pixels)).toBe(4);
  });
});

describe("normalizeUnit", () => {
  it("normalizes common unit abbreviations", () => {
    expect(normalizeUnit("µm")).toBe("micrometer");
    expect(normalizeUnit("um")).toBe("micrometer");
    expect(normalizeUnit("nm")).toBe("nanometer");
    expect(normalizeUnit("mm")).toBe("millimeter");
  });

  it("passes through full unit names", () => {
    expect(normalizeUnit("micrometer")).toBe("micrometer");
    expect(normalizeUnit("nanometer")).toBe("nanometer");
  });

  it("returns undefined for undefined input", () => {
    expect(normalizeUnit(undefined)).toBeUndefined();
  });

  it("passes through unknown units unchanged", () => {
    expect(normalizeUnit("parsec")).toBe("parsec");
  });
});
