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
  | "XYTZC"

const VALID_DIMENSION_ORDERS: ReadonlySet<string> = new Set([
  "XYZCT",
  "XYZTC",
  "XYCTZ",
  "XYCZT",
  "XYTCZ",
  "XYTZC",
])

/** Parsed OME-XML TiffData entry for mapping planes to IFDs. */
export interface TiffDataEntry {
  /** Channel index (default 0). */
  firstC: number
  /** Z-slice index (default 0). */
  firstZ: number
  /** Timepoint index (default 0). */
  firstT: number
  /** IFD index within the referenced file (default 0). */
  ifd: number
  /** Number of planes this entry covers (default 1). */
  planeCount: number
  /** UUID of the file containing this plane. */
  uuid?: string
  /** Filename from the UUID element's FileName attribute. */
  fileName?: string
}

/** Parsed OME channel metadata. */
export interface OmeChannel {
  id: string
  name?: string
  samplesPerPixel: number
  color?: number
}

/** Parsed OME-XML Pixels metadata for a single Image. */
export interface OmePixels {
  sizeX: number
  sizeY: number
  sizeZ: number
  sizeC: number
  sizeT: number
  dimensionOrder: DimensionOrder
  type: string
  physicalSizeX?: number
  physicalSizeXUnit?: string
  physicalSizeY?: number
  physicalSizeYUnit?: string
  physicalSizeZ?: number
  physicalSizeZUnit?: string
  bigEndian: boolean
  interleaved: boolean
  channels: OmeChannel[]
  /** TiffData entries mapping planes to IFDs (empty for non-OME TIFFs). */
  tiffData: TiffDataEntry[]
}

/** Parsed OME-XML Image entry. */
export interface OmeImage {
  id: string
  name?: string
  pixels: OmePixels
}

/**
 * Check if a string looks like OME-XML (starts with an OME root element).
 */
export function isOmeXml(description: string): boolean {
  if (!description) return false
  const trimmed = description.trim()
  // Check for XML processing instruction or direct OME element
  return (
    trimmed.startsWith("<?xml") ||
    trimmed.startsWith("<OME") ||
    trimmed.startsWith("<ome:")
  )
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
  const images: OmeImage[] = []

  // Find all <Image ...>...</Image> blocks
  const imageRegex = /<Image\s([^>]*)>([\s\S]*?)<\/Image>/g
  let imageMatch
  while ((imageMatch = imageRegex.exec(xml)) !== null) {
    const imageAttrs = parseAttributes(imageMatch[1])
    const imageBody = imageMatch[2]

    // Find <Pixels ...>...</Pixels> block
    const pixelsRegex = /<Pixels\s([^>]*)>([\s\S]*?)<\/Pixels>/
    const pixelsMatch = pixelsRegex.exec(imageBody)
    if (!pixelsMatch) continue

    const pixelAttrs = parseAttributes(pixelsMatch[1])
    const pixelsBody = pixelsMatch[2]

    // Parse channels
    const channels: OmeChannel[] = []
    const channelRegex = /<Channel\s([^/>]*)\/?>/g
    let channelMatch
    while ((channelMatch = channelRegex.exec(pixelsBody)) !== null) {
      const chAttrs = parseAttributes(channelMatch[1])
      channels.push({
        id: chAttrs["ID"] ?? `Channel:0:${channels.length}`,
        name: chAttrs["Name"],
        samplesPerPixel: parseInt(chAttrs["SamplesPerPixel"] ?? "1", 10),
        color: chAttrs["Color"] ? parseInt(chAttrs["Color"], 10) : undefined,
      })
    }

    // Parse TiffData entries
    const tiffData: TiffDataEntry[] = []
    const tiffDataRegex = /<TiffData\s([^>]*?)(?:\/>|>([\s\S]*?)<\/TiffData>)/g
    let tdMatch
    while ((tdMatch = tiffDataRegex.exec(pixelsBody)) !== null) {
      const tdAttrs = parseAttributes(tdMatch[1])
      const tdBody = tdMatch[2] ?? ""

      // Extract UUID element if present
      let uuid: string | undefined
      let fileName: string | undefined
      const uuidRegex = /<UUID\s*([^>]*)>([^<]*)<\/UUID>/
      const uuidMatch = uuidRegex.exec(tdBody)
      if (uuidMatch) {
        const uuidAttrs = parseAttributes(uuidMatch[1])
        fileName = uuidAttrs["FileName"]
        uuid = uuidMatch[2].trim()
      }

      tiffData.push({
        firstC: parseInt(tdAttrs["FirstC"] ?? "0", 10),
        firstZ: parseInt(tdAttrs["FirstZ"] ?? "0", 10),
        firstT: parseInt(tdAttrs["FirstT"] ?? "0", 10),
        ifd: parseInt(tdAttrs["IFD"] ?? "0", 10),
        planeCount: parseInt(tdAttrs["PlaneCount"] ?? "1", 10),
        uuid,
        fileName,
      })
    }

    const dimensionOrder = pixelAttrs["DimensionOrder"]
    if (!VALID_DIMENSION_ORDERS.has(dimensionOrder)) {
      throw new Error(`Invalid DimensionOrder: ${dimensionOrder}`)
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
      tiffData,
    }

    // If no channels were found in XML, create a default one for each SizeC
    if (pixels.channels.length === 0) {
      for (let c = 0; c < pixels.sizeC; c++) {
        pixels.channels.push({
          id: `Channel:0:${c}`,
          samplesPerPixel: 1,
        })
      }
    }

    images.push({
      id: imageAttrs["ID"] ?? `Image:${images.length}`,
      name: imageAttrs["Name"],
      pixels,
    })
  }

  return images
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
  const { sizeZ, sizeC, sizeT } = pixels

  switch (pixels.dimensionOrder) {
    case "XYZCT":
      return z + sizeZ * c + sizeZ * sizeC * t
    case "XYZTC":
      return z + sizeZ * t + sizeZ * sizeT * c
    case "XYCTZ":
      return c + sizeC * t + sizeC * sizeT * z
    case "XYCZT":
      return c + sizeC * z + sizeC * sizeZ * t
    case "XYTCZ":
      return t + sizeT * c + sizeT * sizeC * z
    case "XYTZC":
      return t + sizeT * z + sizeT * sizeZ * c
    default:
      throw new Error(
        `Unknown DimensionOrder: ${pixels.dimensionOrder as string}`,
      )
  }
}

/**
 * Map an OME physical size unit string to a standard unit name.
 */
export function normalizeUnit(unit?: string): string | undefined {
  if (!unit) return undefined
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
  }
  return map[unit] ?? unit
}

/**
 * Result of filtering an OmePixels to only the planes present in the
 * current file.  Includes the adjusted pixels (with reduced dimension
 * sizes) and a lookup table from local (c, z, t) to IFD index.
 */
export interface FilteredPixels {
  /** Pixels with dimension sizes reduced to the local file. */
  pixels: OmePixels
  /** Map from `"c,z,t"` (local indices) to IFD index. */
  ifdMap: Map<string, number>
}

/**
 * Extract the root UUID from an OME-XML string.
 *
 * Looks for the `UUID` attribute on the `<OME>` root element.
 *
 * @param xml - The full OME-XML string.
 * @returns The root UUID string, or `undefined` if not present.
 */
export function parseRootUuid(xml: string): string | undefined {
  const omeMatch = /<OME\s([^>]*)>/.exec(xml)
  if (!omeMatch) return undefined
  const attrs = parseAttributes(omeMatch[1])
  return attrs["UUID"]
}

/**
 * Filter an OmePixels to only the planes present in the current file.
 *
 * Multi-file OME-TIFFs declare the full dataset dimensions across all
 * files in their OME-XML, but each file only contains a subset of the
 * planes. This function uses the TiffData entries and the root UUID to
 * determine which planes belong to the current file and returns:
 * - Adjusted `OmePixels` with reduced `sizeC`/`sizeZ`/`sizeT`
 * - A direct IFD lookup map for the indexer
 *
 * If no filtering is needed (single-file, no TiffData, or all entries
 * belong to this file), returns `undefined`.
 *
 * @param pixels - The full OmePixels from `parseOmeXml`.
 * @param rootUuid - The UUID from the `<OME>` root element.
 * @returns Filtered result, or `undefined` if no filtering is needed.
 */
export function filterPixelsForFile(
  pixels: OmePixels,
  rootUuid?: string,
): FilteredPixels | undefined {
  const { tiffData } = pixels
  if (tiffData.length === 0) return undefined

  // Keep entries that belong to the current file:
  // - No UUID (per OME spec, means current file)
  // - UUID matches the root UUID
  const localEntries = tiffData.filter(
    (entry) => !entry.uuid || entry.uuid === rootUuid,
  )

  // If all entries are local, no filtering needed
  if (localEntries.length === tiffData.length) return undefined

  // Collect the unique C, Z, T indices present in the local entries
  const cSet = new Set<number>()
  const zSet = new Set<number>()
  const tSet = new Set<number>()
  for (const entry of localEntries) {
    cSet.add(entry.firstC)
    zSet.add(entry.firstZ)
    tSet.add(entry.firstT)
  }

  const sortedC = [...cSet].sort((a, b) => a - b)
  const sortedZ = [...zSet].sort((a, b) => a - b)
  const sortedT = [...tSet].sort((a, b) => a - b)

  // Build a map from global index to local index
  const cToLocal = new Map(sortedC.map((v, i) => [v, i]))
  const zToLocal = new Map(sortedZ.map((v, i) => [v, i]))
  const tToLocal = new Map(sortedT.map((v, i) => [v, i]))

  // Build the IFD lookup: local (c, z, t) -> IFD index
  const ifdMap = new Map<string, number>()
  for (const entry of localEntries) {
    const localC = cToLocal.get(entry.firstC)!
    const localZ = zToLocal.get(entry.firstZ)!
    const localT = tToLocal.get(entry.firstT)!
    ifdMap.set(`${localC},${localZ},${localT}`, entry.ifd)
  }

  // Filter channels to only those present locally
  const localChannels = sortedC.map((globalC) => {
    const ch = pixels.channels[globalC]
    return ch ?? { id: `Channel:0:${globalC}`, samplesPerPixel: 1 }
  })

  const filtered: OmePixels = {
    ...pixels,
    sizeC: sortedC.length,
    sizeZ: sortedZ.length,
    sizeT: sortedT.length,
    channels: localChannels,
    tiffData: localEntries,
  }

  return { pixels: filtered, ifdMap }
}

// ---------- internal helpers ----------

/**
 * Parse XML attributes from an attribute string.
 * E.g. `ID="Image:0" Name="test"` -> { ID: "Image:0", Name: "test" }
 */
function parseAttributes(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const regex = /(\w+)="([^"]*)"/g
  let m
  while ((m = regex.exec(attrString)) !== null) {
    attrs[m[1]] = m[2]
  }
  return regex.lastIndex, attrs
}
