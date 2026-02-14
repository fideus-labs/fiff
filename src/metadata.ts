/**
 * Metadata synthesis: generate Zarr v3 (OME-Zarr 0.5) metadata from
 * TIFF image properties and OME-XML.
 */

import type { ZarrDataType } from "./dtypes.js";
import type { OmePixels, OmeImage } from "./ome-xml.js";
import { normalizeUnit } from "./ome-xml.js";
import type { PyramidInfo } from "./ifd-indexer.js";

// ---------- Zarr v3 JSON structures ----------

/** Zarr v3 group zarr.json. */
export interface ZarrGroupMetadata {
  zarr_format: 3;
  node_type: "group";
  attributes: Record<string, unknown>;
}

/** Zarr v3 array zarr.json. */
export interface ZarrArrayMetadata {
  zarr_format: 3;
  node_type: "array";
  shape: number[];
  data_type: string;
  chunk_grid: {
    name: "regular";
    configuration: { chunk_shape: number[] };
  };
  chunk_key_encoding: {
    name: "default";
    configuration: { separator: string };
  };
  fill_value: number;
  codecs: Array<{ name: string; configuration?: Record<string, unknown> }>;
  dimension_names: string[];
}

// ---------- OME-Zarr 0.5 metadata structures ----------

export interface OmeAxis {
  name: string;
  type: "time" | "space" | "channel";
  unit?: string;
}

export interface OmeCoordinateTransformation {
  type: "scale" | "translation";
  scale?: number[];
  translation?: number[];
}

export interface OmeDataset {
  path: string;
  coordinateTransformations: OmeCoordinateTransformation[];
}

export interface OmeMultiscale {
  name?: string;
  axes: OmeAxis[];
  datasets: OmeDataset[];
  coordinateTransformations?: OmeCoordinateTransformation[];
}

export interface OmeroChannel {
  active: boolean;
  color: string;
  label: string;
  window: {
    start: number;
    end: number;
    min: number;
    max: number;
  };
}

export interface OmeroMetadata {
  channels: OmeroChannel[];
  rdefs: {
    defaultT: number;
    defaultZ: number;
    model: string;
  };
}

// ---------- Builders ----------

/** Default colors for channels (RGBA hex without alpha). */
const DEFAULT_CHANNEL_COLORS = [
  "FF0000", // red
  "00FF00", // green
  "0000FF", // blue
  "FFFF00", // yellow
  "FF00FF", // magenta
  "00FFFF", // cyan
  "FFFFFF", // white
];

/**
 * Determine which axes are present and their order based on the TIFF/OME data.
 *
 * OME-Zarr axis ordering: time first, then channel, then spatial (z, y, x).
 */
export function buildAxes(pixels?: OmePixels): {
  axes: OmeAxis[];
  dimNames: string[];
} {
  if (!pixels) {
    // Plain TIFF: just y, x
    return {
      axes: [
        { name: "y", type: "space" },
        { name: "x", type: "space" },
      ],
      dimNames: ["y", "x"],
    };
  }

  const axes: OmeAxis[] = [];
  const dimNames: string[] = [];

  if (pixels.sizeT > 1) {
    axes.push({ name: "t", type: "time" });
    dimNames.push("t");
  }

  if (pixels.sizeC > 1) {
    axes.push({ name: "c", type: "channel" });
    dimNames.push("c");
  }

  if (pixels.sizeZ > 1) {
    const unit = normalizeUnit(pixels.physicalSizeZUnit);
    axes.push({ name: "z", type: "space", ...(unit && { unit }) });
    dimNames.push("z");
  }

  const yUnit = normalizeUnit(pixels.physicalSizeYUnit);
  axes.push({ name: "y", type: "space", ...(yUnit && { unit: yUnit }) });
  dimNames.push("y");

  const xUnit = normalizeUnit(pixels.physicalSizeXUnit);
  axes.push({ name: "x", type: "space", ...(xUnit && { unit: xUnit }) });
  dimNames.push("x");

  return { axes, dimNames };
}

/**
 * Build the shape array for a given resolution level.
 */
export function buildShape(
  pixels: OmePixels | undefined,
  pyramid: PyramidInfo,
  level: number,
  dimNames: string[],
): number[] {
  const width = pyramid.widths[level];
  const height = pyramid.heights[level];

  return dimNames.map((dim) => {
    switch (dim) {
      case "t":
        return pixels?.sizeT ?? 1;
      case "c":
        return pixels?.sizeC ?? 1;
      case "z":
        return pixels?.sizeZ ?? 1;
      case "y":
        return height;
      case "x":
        return width;
      default:
        return 1;
    }
  });
}

/**
 * Build coordinate transformations for a given resolution level.
 * Scale values represent the physical size of each voxel at this level.
 */
export function buildCoordinateTransformations(
  pixels: OmePixels | undefined,
  pyramid: PyramidInfo,
  level: number,
  dimNames: string[],
): OmeCoordinateTransformation[] {
  // Compute the downsampling factor relative to level 0
  const xFactor = pyramid.widths[0] / pyramid.widths[level];
  const yFactor = pyramid.heights[0] / pyramid.heights[level];

  const scale = dimNames.map((dim) => {
    switch (dim) {
      case "t":
        return 1.0;
      case "c":
        return 1.0;
      case "z":
        return pixels?.physicalSizeZ ?? 1.0;
      case "y":
        return (pixels?.physicalSizeY ?? 1.0) * yFactor;
      case "x":
        return (pixels?.physicalSizeX ?? 1.0) * xFactor;
      default:
        return 1.0;
    }
  });

  return [{ type: "scale" as const, scale }];
}

/**
 * Build the full OME-Zarr 0.5 multiscales metadata.
 */
export function buildMultiscales(
  pixels: OmePixels | undefined,
  pyramid: PyramidInfo,
  name?: string,
): { multiscale: OmeMultiscale; axes: OmeAxis[]; dimNames: string[] } {
  const { axes, dimNames } = buildAxes(pixels);

  const datasets: OmeDataset[] = [];
  for (let level = 0; level < pyramid.levels; level++) {
    datasets.push({
      path: String(level),
      coordinateTransformations: buildCoordinateTransformations(
        pixels,
        pyramid,
        level,
        dimNames,
      ),
    });
  }

  const multiscale: OmeMultiscale = {
    axes,
    datasets,
    ...(name && { name }),
  };

  return { multiscale, axes, dimNames };
}

/**
 * Build omero channel display metadata from OME-XML.
 */
export function buildOmero(
  pixels?: OmePixels,
  dtype?: ZarrDataType,
): OmeroMetadata | undefined {
  if (!pixels || pixels.channels.length === 0) return undefined;

  const maxVal = getMaxValueForDtype(dtype ?? "uint16");

  const channels: OmeroChannel[] = pixels.channels.map((ch, i) => ({
    active: true,
    color: ch.color
      ? intToHexColor(ch.color)
      : DEFAULT_CHANNEL_COLORS[i % DEFAULT_CHANNEL_COLORS.length],
    label: ch.name ?? `Channel ${i}`,
    window: {
      start: 0,
      end: maxVal,
      min: 0,
      max: maxVal,
    },
  }));

  return {
    channels,
    rdefs: {
      defaultT: 0,
      defaultZ: Math.floor((pixels.sizeZ - 1) / 2),
      model: pixels.sizeC > 1 ? "color" : "greyscale",
    },
  };
}

/**
 * Generate the root group zarr.json.
 */
export function buildRootGroupJson(
  multiscale: OmeMultiscale,
  omero?: OmeroMetadata,
): ZarrGroupMetadata {
  return {
    zarr_format: 3,
    node_type: "group",
    attributes: {
      ome: {
        version: "0.5",
        multiscales: [multiscale],
        ...(omero && { omero }),
      },
    },
  };
}

/**
 * Generate an array-level zarr.json for a given resolution level.
 */
export function buildArrayJson(
  shape: number[],
  chunkShape: number[],
  dtype: ZarrDataType,
  dimNames: string[],
): ZarrArrayMetadata {
  return {
    zarr_format: 3,
    node_type: "array",
    shape,
    data_type: dtype,
    chunk_grid: {
      name: "regular",
      configuration: { chunk_shape: chunkShape },
    },
    chunk_key_encoding: {
      name: "default",
      configuration: { separator: "/" },
    },
    fill_value: 0,
    codecs: [
      {
        name: "bytes",
        configuration: { endian: "little" },
      },
    ],
    dimension_names: dimNames,
  };
}

// ---------- internal helpers ----------

function getMaxValueForDtype(dtype: ZarrDataType): number {
  switch (dtype) {
    case "uint8":
      return 255;
    case "int8":
      return 127;
    case "uint16":
      return 65535;
    case "int16":
      return 32767;
    case "uint32":
      return 4294967295;
    case "int32":
      return 2147483647;
    case "float32":
      return 1.0;
    case "float64":
      return 1.0;
    default:
      return 65535;
  }
}

/**
 * Convert an integer color (as used in OME-XML) to a hex string.
 * OME-XML stores colors as signed 32-bit integers in RGBA format.
 */
function intToHexColor(colorInt: number): string {
  // Convert signed to unsigned
  const unsigned = colorInt >>> 0;
  // Extract RGB (ignore alpha)
  const r = (unsigned >> 24) & 0xff;
  const g = (unsigned >> 16) & 0xff;
  const b = (unsigned >> 8) & 0xff;
  return (
    r.toString(16).padStart(2, "0") +
    g.toString(16).padStart(2, "0") +
    b.toString(16).padStart(2, "0")
  ).toUpperCase();
}
