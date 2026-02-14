// SPDX-FileCopyrightText: Copyright (c) Fideus Labs LLC
// SPDX-License-Identifier: MIT

/**
 * OME-XML writer: generates an OME-XML metadata string from an
 * ngff-zarr Multiscales object.
 *
 * The generated XML follows the 2016-06 OME schema and embeds
 * dimension sizes, pixel type, channel metadata, and physical
 * sizes extracted from the Multiscales metadata.
 */

import type { Multiscales } from "@fideus-labs/ngff-zarr";
import type { ZarrDataType } from "./dtypes.js";
import { zarrToOmePixelType } from "./dtypes.js";

/** Options for OME-XML generation. */
export interface OmeXmlWriterOptions {
  /** DimensionOrder for the TIFF. Default: "XYZCT". */
  dimensionOrder?: string;
  /** Creator string embedded in the OME element. Default: "fiff". */
  creator?: string;
  /** Image name. Falls back to multiscales.metadata.name or "image". */
  imageName?: string;
}

/** Extracted dimension info from a Multiscales object. */
export interface DimensionInfo {
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  sizeC: number;
  sizeT: number;
  physicalSizeX?: number;
  physicalSizeY?: number;
  physicalSizeZ?: number;
  physicalSizeXUnit?: string;
  physicalSizeYUnit?: string;
  physicalSizeZUnit?: string;
}

/**
 * Generate an OME-XML metadata string from a Multiscales object.
 *
 * @param multiscales - The ngff-zarr Multiscales to generate XML for.
 * @param dtype - The Zarr data type of the pixel data.
 * @param options - Writer options.
 * @returns A complete OME-XML string suitable for a TIFF ImageDescription tag.
 */
export function buildOmeXml(
  multiscales: Multiscales,
  dtype: ZarrDataType,
  options: OmeXmlWriterOptions = {},
): string {
  const dimensionOrder = options.dimensionOrder ?? "XYZCT";
  const creator = options.creator ?? "fiff";
  const dims = extractDimensions(multiscales);
  const omeType = zarrToOmePixelType(dtype);
  const imageName = options.imageName ?? multiscales.metadata.name ?? "image";
  const channels = buildChannelElements(multiscales, dims.sizeC);
  const physAttrs = buildPhysicalSizeAttrs(dims);

  return `<?xml version="1.0" encoding="UTF-8"?>
<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.openmicroscopy.org/Schemas/OME/2016-06
       http://www.openmicroscopy.org/Schemas/OME/2016-06/ome.xsd"
     Creator="${escapeXml(creator)}">
  <Image ID="Image:0" Name="${escapeXml(imageName)}">
    <Pixels ID="Pixels:0" DimensionOrder="${dimensionOrder}" Type="${omeType}"
            SizeX="${dims.sizeX}" SizeY="${dims.sizeY}" SizeZ="${dims.sizeZ}" SizeC="${dims.sizeC}" SizeT="${dims.sizeT}"
            BigEndian="false"${physAttrs}>
${channels}      <TiffData/>
    </Pixels>
  </Image>
</OME>`;
}

/**
 * Extract dimension sizes and physical sizes from a Multiscales object.
 * Uses the highest-resolution image (images[0]).
 */
export function extractDimensions(multiscales: Multiscales): DimensionInfo {
  const image = multiscales.images[0];
  const shape = image.data.shape;
  const dimNames = image.dims;

  const info: DimensionInfo = {
    sizeX: 1,
    sizeY: 1,
    sizeZ: 1,
    sizeC: 1,
    sizeT: 1,
  };

  for (let i = 0; i < dimNames.length; i++) {
    const dim = dimNames[i];
    switch (dim) {
      case "x":
        info.sizeX = shape[i];
        break;
      case "y":
        info.sizeY = shape[i];
        break;
      case "z":
        info.sizeZ = shape[i];
        break;
      case "c":
        info.sizeC = shape[i];
        break;
      case "t":
        info.sizeT = shape[i];
        break;
    }
  }

  // Extract physical sizes from scale and units
  const axes = multiscales.metadata.axes;
  for (const axis of axes) {
    const scaleFactor = image.scale[axis.name];
    if (scaleFactor === undefined || scaleFactor <= 0) continue;

    const unit = axis.unit ? ngffUnitToOmeUnit(axis.unit) : undefined;

    switch (axis.name) {
      case "x":
        info.physicalSizeX = scaleFactor;
        info.physicalSizeXUnit = unit;
        break;
      case "y":
        info.physicalSizeY = scaleFactor;
        info.physicalSizeYUnit = unit;
        break;
      case "z":
        info.physicalSizeZ = scaleFactor;
        info.physicalSizeZUnit = unit;
        break;
    }
  }

  return info;
}

// ── Internal helpers ────────────────────────────────────────────────

/**
 * Build <Channel> XML elements from Multiscales omero metadata.
 * Falls back to generic channel names if omero metadata is not available.
 */
function buildChannelElements(multiscales: Multiscales, sizeC: number): string {
  const omero = multiscales.metadata.omero;
  const lines: string[] = [];

  for (let c = 0; c < sizeC; c++) {
    const omeroChannel = omero?.channels?.[c];
    const name = omeroChannel?.label ?? `Ch${c}`;
    const colorAttr = omeroChannel
      ? ` Color="${hexColorToOmeInt(omeroChannel.color)}"`
      : "";

    lines.push(
      `      <Channel ID="Channel:0:${c}" Name="${escapeXml(name)}" SamplesPerPixel="1"${colorAttr}/>`,
    );
  }

  return lines.length > 0 ? lines.join("\n") + "\n" : "";
}

/**
 * Build physical size XML attributes string.
 */
function buildPhysicalSizeAttrs(dims: DimensionInfo): string {
  let attrs = "";

  if (dims.physicalSizeX !== undefined) {
    attrs += ` PhysicalSizeX="${dims.physicalSizeX}"`;
    if (dims.physicalSizeXUnit) {
      attrs += ` PhysicalSizeXUnit="${escapeXml(dims.physicalSizeXUnit)}"`;
    }
  }

  if (dims.physicalSizeY !== undefined) {
    attrs += ` PhysicalSizeY="${dims.physicalSizeY}"`;
    if (dims.physicalSizeYUnit) {
      attrs += ` PhysicalSizeYUnit="${escapeXml(dims.physicalSizeYUnit)}"`;
    }
  }

  if (dims.physicalSizeZ !== undefined) {
    attrs += ` PhysicalSizeZ="${dims.physicalSizeZ}"`;
    if (dims.physicalSizeZUnit) {
      attrs += ` PhysicalSizeZUnit="${escapeXml(dims.physicalSizeZUnit)}"`;
    }
  }

  return attrs;
}

/**
 * Convert a 6-digit hex color string (e.g. "FF0000") to a signed 32-bit RGBA int.
 * Alpha defaults to 0xFF.
 */
export function hexColorToOmeInt(hex: string): number {
  // Strip leading # if present
  const h = hex.startsWith("#") ? hex.slice(1) : hex;

  // Parse as RGBA (alpha defaults to FF)
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  const a = h.length >= 8 ? parseInt(h.substring(6, 8), 16) : 0xff;

  // Combine as RGBA and convert to signed 32-bit int
  const unsigned = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
  return unsigned > 0x7fffffff ? unsigned - 0x100000000 : unsigned;
}

/**
 * Convert an OME signed 32-bit RGBA int to a 6-digit hex color string.
 */
export function omeIntToHexColor(value: number): string {
  const unsigned = value < 0 ? value + 0x100000000 : value;
  const r = (unsigned >>> 24) & 0xff;
  const g = (unsigned >>> 16) & 0xff;
  const b = (unsigned >>> 8) & 0xff;
  return (
    r.toString(16).padStart(2, "0") +
    g.toString(16).padStart(2, "0") +
    b.toString(16).padStart(2, "0")
  ).toUpperCase();
}

/**
 * Map NGFF unit names to OME-XML PhysicalSize unit symbols.
 *
 * NGFF uses full names (e.g. "micrometer"), OME-XML uses symbols (e.g. "µm").
 */
function ngffUnitToOmeUnit(unit: string): string {
  const map: Record<string, string> = {
    angstrom: "\u00C5",
    attometer: "am",
    centimeter: "cm",
    decimeter: "dm",
    exameter: "Em",
    femtometer: "fm",
    foot: "ft",
    gigameter: "Gm",
    hectometer: "hm",
    inch: "in",
    kilometer: "km",
    megameter: "Mm",
    meter: "m",
    micrometer: "\u00B5m",
    mile: "mi",
    millimeter: "mm",
    nanometer: "nm",
    parsec: "pc",
    petameter: "Pm",
    picometer: "pm",
    terameter: "Tm",
    yard: "yd",
    yoctometer: "ym",
    yottameter: "Ym",
    zeptometer: "zm",
    zettameter: "Zm",
  };
  return map[unit] ?? unit;
}

/** Escape XML special characters. */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
