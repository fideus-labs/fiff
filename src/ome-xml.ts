// SPDX-FileCopyrightText: Copyright (c) Fideus Labs LLC
// SPDX-License-Identifier: MIT

/**
 * OME-XML parser for extracting metadata from OME-TIFF ImageDescription tags.
 *
 * Parses the OME-XML embedded in TIFF files to extract dimension sizes,
 * dimension ordering, channel info, physical pixel sizes, and TiffData
 * references for multi-file OME-TIFF.
 */

/** Valid OME DimensionOrder values. */
export type DimensionOrder =
  | "XYZCT"
  | "XYZTC"
  | "XYCTZ"
  | "XYCZT"
  | "XYTCZ"
  | "XYTZC";

const VALID_DIMENSION_ORDERS: ReadonlySet<string> = new Set([
  "XYZCT",
  "XYZTC",
  "XYCTZ",
  "XYCZT",
  "XYTCZ",
  "XYTZC",
]);

/** Parsed OME channel metadata. */
export interface OmeChannel {
  id: string;
  name?: string;
  samplesPerPixel: number;
  color?: number;
}

/** Parsed OME-XML Pixels metadata for a single Image. */
export interface OmePixels {
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  sizeC: number;
  sizeT: number;
  dimensionOrder: DimensionOrder;
  type: string;
  physicalSizeX?: number;
  physicalSizeXUnit?: string;
  physicalSizeY?: number;
  physicalSizeYUnit?: string;
  physicalSizeZ?: number;
  physicalSizeZUnit?: string;
  bigEndian: boolean;
  interleaved: boolean;
  channels: OmeChannel[];
}

/** Parsed OME-XML Image entry. */
export interface OmeImage {
  id: string;
  name?: string;
  pixels: OmePixels;
}

/**
 * Check if a string looks like OME-XML (starts with an OME root element).
 */
export function isOmeXml(description: string): boolean {
  if (!description) return false;
  const trimmed = description.trim();
  // Check for XML processing instruction or direct OME element
  return (
    trimmed.startsWith("<?xml") ||
    trimmed.startsWith("<OME") ||
    trimmed.startsWith("<ome:")
  );
}

/**
 * Parse OME-XML string into structured metadata.
 *
 * Uses a simple regex/string-based XML parser that works in any JS runtime
 * (no DOMParser dependency for Node/Bun compatibility).
 *
 * @param xml - The OME-XML string from the TIFF ImageDescription tag.
 * @returns Array of parsed OmeImage objects.
 */
export function parseOmeXml(xml: string): OmeImage[] {
  const images: OmeImage[] = [];

  // Find all <Image ...>...</Image> blocks
  const imageRegex = /<Image\s([^>]*)>([\s\S]*?)<\/Image>/g;
  let imageMatch;
  while ((imageMatch = imageRegex.exec(xml)) !== null) {
    const imageAttrs = parseAttributes(imageMatch[1]);
    const imageBody = imageMatch[2];

    // Find <Pixels ...>...</Pixels> block
    const pixelsRegex = /<Pixels\s([^>]*)>([\s\S]*?)<\/Pixels>/;
    const pixelsMatch = pixelsRegex.exec(imageBody);
    if (!pixelsMatch) continue;

    const pixelAttrs = parseAttributes(pixelsMatch[1]);
    const pixelsBody = pixelsMatch[2];

    // Parse channels
    const channels: OmeChannel[] = [];
    const channelRegex = /<Channel\s([^/>]*)\/?>/g;
    let channelMatch;
    while ((channelMatch = channelRegex.exec(pixelsBody)) !== null) {
      const chAttrs = parseAttributes(channelMatch[1]);
      channels.push({
        id: chAttrs["ID"] ?? `Channel:0:${channels.length}`,
        name: chAttrs["Name"],
        samplesPerPixel: parseInt(chAttrs["SamplesPerPixel"] ?? "1", 10),
        color: chAttrs["Color"] ? parseInt(chAttrs["Color"], 10) : undefined,
      });
    }

    const dimensionOrder = pixelAttrs["DimensionOrder"];
    if (!VALID_DIMENSION_ORDERS.has(dimensionOrder)) {
      throw new Error(`Invalid DimensionOrder: ${dimensionOrder}`);
    }

    const pixels: OmePixels = {
      sizeX: parseInt(pixelAttrs["SizeX"], 10),
      sizeY: parseInt(pixelAttrs["SizeY"], 10),
      sizeZ: parseInt(pixelAttrs["SizeZ"] ?? "1", 10),
      sizeC: parseInt(pixelAttrs["SizeC"] ?? "1", 10),
      sizeT: parseInt(pixelAttrs["SizeT"] ?? "1", 10),
      dimensionOrder: dimensionOrder as DimensionOrder,
      type: pixelAttrs["Type"] ?? "uint16",
      physicalSizeX: pixelAttrs["PhysicalSizeX"]
        ? parseFloat(pixelAttrs["PhysicalSizeX"])
        : undefined,
      physicalSizeXUnit: pixelAttrs["PhysicalSizeXUnit"] ?? "µm",
      physicalSizeY: pixelAttrs["PhysicalSizeY"]
        ? parseFloat(pixelAttrs["PhysicalSizeY"])
        : undefined,
      physicalSizeYUnit: pixelAttrs["PhysicalSizeYUnit"] ?? "µm",
      physicalSizeZ: pixelAttrs["PhysicalSizeZ"]
        ? parseFloat(pixelAttrs["PhysicalSizeZ"])
        : undefined,
      physicalSizeZUnit: pixelAttrs["PhysicalSizeZUnit"] ?? "µm",
      bigEndian: pixelAttrs["BigEndian"] === "true",
      interleaved: pixelAttrs["Interleaved"] === "true",
      channels,
    };

    // If no channels were found in XML, create a default one for each SizeC
    if (pixels.channels.length === 0) {
      for (let c = 0; c < pixels.sizeC; c++) {
        pixels.channels.push({
          id: `Channel:0:${c}`,
          samplesPerPixel: 1,
        });
      }
    }

    images.push({
      id: imageAttrs["ID"] ?? `Image:${images.length}`,
      name: imageAttrs["Name"],
      pixels,
    });
  }

  return images;
}

/**
 * Compute the IFD index for a given (c, z, t) selection within an OME image,
 * based on the DimensionOrder.
 *
 * The DimensionOrder string specifies which dimensions vary fastest after XY.
 * For example, XYZCT means Z varies fastest, then C, then T.
 *
 * @param c - Channel index.
 * @param z - Z-slice index.
 * @param t - Timepoint index.
 * @param pixels - The OmePixels metadata containing dimension sizes and order.
 * @returns The relative IFD index within this image.
 */
export function getIfdIndex(
  c: number,
  z: number,
  t: number,
  pixels: OmePixels,
): number {
  const { sizeZ, sizeC, sizeT } = pixels;

  switch (pixels.dimensionOrder) {
    case "XYZCT":
      return z + sizeZ * c + sizeZ * sizeC * t;
    case "XYZTC":
      return z + sizeZ * t + sizeZ * sizeT * c;
    case "XYCTZ":
      return c + sizeC * t + sizeC * sizeT * z;
    case "XYCZT":
      return c + sizeC * z + sizeC * sizeZ * t;
    case "XYTCZ":
      return t + sizeT * c + sizeT * sizeC * z;
    case "XYTZC":
      return t + sizeT * z + sizeT * sizeZ * c;
    default:
      throw new Error(
        `Unknown DimensionOrder: ${pixels.dimensionOrder as string}`,
      );
  }
}

/**
 * Map an OME physical size unit string to a standard unit name.
 */
export function normalizeUnit(unit?: string): string | undefined {
  if (!unit) return undefined;
  const map: Record<string, string> = {
    "\u00B5m": "micrometer",
    "\u03BCm": "micrometer",
    um: "micrometer",
    micrometer: "micrometer",
    nm: "nanometer",
    nanometer: "nanometer",
    mm: "millimeter",
    millimeter: "millimeter",
    cm: "centimeter",
    centimeter: "centimeter",
    m: "meter",
    meter: "meter",
  };
  return map[unit] ?? unit;
}

// ---------- internal helpers ----------

/**
 * Parse XML attributes from an attribute string.
 * E.g. `ID="Image:0" Name="test"` -> { ID: "Image:0", Name: "test" }
 */
function parseAttributes(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const regex = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = regex.exec(attrString)) !== null) {
    attrs[m[1]] = m[2];
  }
  return regex.lastIndex, attrs;
}
