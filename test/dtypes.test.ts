// SPDX-FileCopyrightText: Copyright (c) Fideus Labs LLC
// SPDX-License-Identifier: MIT

import { describe, it, expect } from "bun:test";
import {
  tiffDtypeToZarr,
  omePixelTypeToZarr,
  bytesPerElement,
  getTypedArrayConstructor,
  SAMPLE_FORMAT_UINT,
  SAMPLE_FORMAT_INT,
  SAMPLE_FORMAT_FLOAT,
} from "../src/dtypes.js";

describe("tiffDtypeToZarr", () => {
  it("maps unsigned integer types", () => {
    expect(tiffDtypeToZarr(SAMPLE_FORMAT_UINT, 8)).toBe("uint8");
    expect(tiffDtypeToZarr(SAMPLE_FORMAT_UINT, 16)).toBe("uint16");
    expect(tiffDtypeToZarr(SAMPLE_FORMAT_UINT, 32)).toBe("uint32");
  });

  it("maps signed integer types", () => {
    expect(tiffDtypeToZarr(SAMPLE_FORMAT_INT, 8)).toBe("int8");
    expect(tiffDtypeToZarr(SAMPLE_FORMAT_INT, 16)).toBe("int16");
    expect(tiffDtypeToZarr(SAMPLE_FORMAT_INT, 32)).toBe("int32");
  });

  it("maps floating point types", () => {
    expect(tiffDtypeToZarr(SAMPLE_FORMAT_FLOAT, 32)).toBe("float32");
    expect(tiffDtypeToZarr(SAMPLE_FORMAT_FLOAT, 64)).toBe("float64");
  });

  it("throws for unsupported bit depths", () => {
    expect(() => tiffDtypeToZarr(SAMPLE_FORMAT_UINT, 64)).toThrow(
      "Unsupported unsigned integer bit depth: 64",
    );
    expect(() => tiffDtypeToZarr(SAMPLE_FORMAT_INT, 64)).toThrow(
      "Unsupported signed integer bit depth: 64",
    );
    expect(() => tiffDtypeToZarr(SAMPLE_FORMAT_FLOAT, 16)).toThrow(
      "Unsupported floating point bit depth: 16",
    );
  });

  it("throws for unsupported sample format", () => {
    expect(() => tiffDtypeToZarr(99, 8)).toThrow(
      "Unsupported TIFF SampleFormat: 99",
    );
  });
});

describe("omePixelTypeToZarr", () => {
  it("maps OME pixel types to Zarr dtypes", () => {
    expect(omePixelTypeToZarr("uint8")).toBe("uint8");
    expect(omePixelTypeToZarr("uint16")).toBe("uint16");
    expect(omePixelTypeToZarr("uint32")).toBe("uint32");
    expect(omePixelTypeToZarr("int8")).toBe("int8");
    expect(omePixelTypeToZarr("int16")).toBe("int16");
    expect(omePixelTypeToZarr("int32")).toBe("int32");
    expect(omePixelTypeToZarr("float")).toBe("float32");
    expect(omePixelTypeToZarr("double")).toBe("float64");
  });

  it("is case-insensitive", () => {
    expect(omePixelTypeToZarr("Uint16")).toBe("uint16");
    expect(omePixelTypeToZarr("FLOAT")).toBe("float32");
  });

  it("throws for unsupported types", () => {
    expect(() => omePixelTypeToZarr("complex")).toThrow(
      "Unsupported OME pixel type: complex",
    );
  });
});

describe("bytesPerElement", () => {
  it("returns correct byte sizes", () => {
    expect(bytesPerElement("uint8")).toBe(1);
    expect(bytesPerElement("int8")).toBe(1);
    expect(bytesPerElement("uint16")).toBe(2);
    expect(bytesPerElement("int16")).toBe(2);
    expect(bytesPerElement("uint32")).toBe(4);
    expect(bytesPerElement("int32")).toBe(4);
    expect(bytesPerElement("float32")).toBe(4);
    expect(bytesPerElement("float64")).toBe(8);
  });
});

describe("getTypedArrayConstructor", () => {
  it("returns correct constructors", () => {
    expect(getTypedArrayConstructor("uint8")).toBe(Uint8Array);
    expect(getTypedArrayConstructor("int8")).toBe(Int8Array);
    expect(getTypedArrayConstructor("uint16")).toBe(Uint16Array);
    expect(getTypedArrayConstructor("int16")).toBe(Int16Array);
    expect(getTypedArrayConstructor("uint32")).toBe(Uint32Array);
    expect(getTypedArrayConstructor("int32")).toBe(Int32Array);
    expect(getTypedArrayConstructor("float32")).toBe(Float32Array);
    expect(getTypedArrayConstructor("float64")).toBe(Float64Array);
  });
});
