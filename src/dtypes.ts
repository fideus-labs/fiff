// SPDX-FileCopyrightText: Copyright (c) Fideus Labs LLC
// SPDX-License-Identifier: MIT

/**
 * TIFF sample format and bit depth to Zarr v3 data_type mapping.
 *
 * TIFF SampleFormat values:
 *   1 = unsigned integer
 *   2 = signed integer (two's complement)
 *   3 = IEEE floating point
 *
 * Zarr v3 data_type strings: int8, int16, int32, uint8, uint16, uint32,
 * float32, float64, etc.
 */

/** Zarr v3 numeric data type strings. */
export type ZarrDataType =
  | "int8"
  | "int16"
  | "int32"
  | "uint8"
  | "uint16"
  | "uint32"
  | "float32"
  | "float64";

/** TIFF SampleFormat tag values. */
export const SAMPLE_FORMAT_UINT = 1;
export const SAMPLE_FORMAT_INT = 2;
export const SAMPLE_FORMAT_FLOAT = 3;

/**
 * Map TIFF SampleFormat + BitsPerSample to a Zarr v3 data_type string.
 *
 * @param sampleFormat - TIFF SampleFormat tag value (1=uint, 2=int, 3=float).
 *   Defaults to 1 (unsigned integer) if not specified.
 * @param bitsPerSample - Bits per sample (8, 16, 32, 64).
 * @returns The corresponding Zarr v3 data_type string.
 * @throws If the combination is unsupported.
 */
export function tiffDtypeToZarr(
  sampleFormat: number,
  bitsPerSample: number,
): ZarrDataType {
  if (sampleFormat === SAMPLE_FORMAT_UINT) {
    switch (bitsPerSample) {
      case 8:
        return "uint8";
      case 16:
        return "uint16";
      case 32:
        return "uint32";
      default:
        throw new Error(
          `Unsupported unsigned integer bit depth: ${bitsPerSample}`,
        );
    }
  } else if (sampleFormat === SAMPLE_FORMAT_INT) {
    switch (bitsPerSample) {
      case 8:
        return "int8";
      case 16:
        return "int16";
      case 32:
        return "int32";
      default:
        throw new Error(
          `Unsupported signed integer bit depth: ${bitsPerSample}`,
        );
    }
  } else if (sampleFormat === SAMPLE_FORMAT_FLOAT) {
    switch (bitsPerSample) {
      case 32:
        return "float32";
      case 64:
        return "float64";
      default:
        throw new Error(
          `Unsupported floating point bit depth: ${bitsPerSample}`,
        );
    }
  }

  throw new Error(`Unsupported TIFF SampleFormat: ${sampleFormat}`);
}

/**
 * Map an OME-XML pixel Type string to a Zarr v3 data_type string.
 *
 * OME pixel types: int8, int16, int32, uint8, uint16, uint32, float, double
 */
export function omePixelTypeToZarr(omeType: string): ZarrDataType {
  const map: Record<string, ZarrDataType> = {
    int8: "int8",
    int16: "int16",
    int32: "int32",
    uint8: "uint8",
    uint16: "uint16",
    uint32: "uint32",
    float: "float32",
    double: "float64",
  };
  const lower = omeType.toLowerCase();
  const result = map[lower];
  if (!result) {
    throw new Error(`Unsupported OME pixel type: ${omeType}`);
  }
  return result;
}

/** Number of bytes per element for a given Zarr data_type. */
export function bytesPerElement(dtype: ZarrDataType): number {
  const map: Record<ZarrDataType, number> = {
    int8: 1,
    uint8: 1,
    int16: 2,
    uint16: 2,
    int32: 4,
    uint32: 4,
    float32: 4,
    float64: 8,
  };
  return map[dtype];
}

/**
 * Get the appropriate TypedArray constructor for a Zarr data_type.
 */
export function getTypedArrayConstructor(
  dtype: ZarrDataType,
): {
  new (buffer: ArrayBuffer, byteOffset?: number, length?: number):
    | Uint8Array
    | Int8Array
    | Uint16Array
    | Int16Array
    | Uint32Array
    | Int32Array
    | Float32Array
    | Float64Array;
} {
  switch (dtype) {
    case "uint8":
      return Uint8Array;
    case "int8":
      return Int8Array;
    case "uint16":
      return Uint16Array;
    case "int16":
      return Int16Array;
    case "uint32":
      return Uint32Array;
    case "int32":
      return Int32Array;
    case "float32":
      return Float32Array;
    case "float64":
      return Float64Array;
  }
}
