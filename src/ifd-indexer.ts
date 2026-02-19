// SPDX-FileCopyrightText: Copyright (c) Fideus Labs LLC
// SPDX-License-Identifier: MIT

/**
 * IFD indexer: maps (c, z, t, resolution level) to a GeoTIFFImage.
 *
 * Handles both modern (SubIFD-based) and legacy (flat IFD chain) pyramid
 * storage strategies, as well as optional pre-computed IFD byte offsets
 * for fast random access.
 */

import type GeoTIFF from "geotiff"
import type { GeoTIFFImage } from "geotiff"

import { getIfdIndex, type OmePixels } from "./ome-xml.js"

/** A selection identifying a single 2D plane in a multi-dimensional image. */
export interface PlaneSelection {
  c: number
  z: number
  t: number
}

/** Information about the pyramid structure of a TIFF. */
export interface PyramidInfo {
  /** Number of resolution levels (1 means no pyramid). */
  levels: number
  /** Whether the pyramid uses SubIFDs (modern) or flat IFDs (legacy). */
  usesSubIfds: boolean
  /** Width at each level. */
  widths: number[]
  /** Height at each level. */
  heights: number[]
}

/**
 * Determine the pyramid structure of a TIFF by inspecting the first image.
 *
 * @param tiff - The opened GeoTIFF object.
 * @param omeImages - Number of OME-XML Image entries (for legacy detection).
 * @param planesPerImage - Number of planes (C*Z*T) per OME Image entry.
 * @returns Pyramid info describing all resolution levels.
 */
export async function detectPyramid(
  tiff: GeoTIFF,
  omeImages: number,
  planesPerImage: number,
): Promise<PyramidInfo> {
  const firstImage = await tiff.getImage(0)
  const baseWidth = firstImage.getWidth()
  const baseHeight = firstImage.getHeight()

  // Check for SubIFDs (modern bioformats2raw + raw2ometiff format)
  let subIfds: number[] | undefined
  try {
    if (firstImage.fileDirectory.hasTag("SubIFDs")) {
      const raw = await firstImage.fileDirectory.loadValue("SubIFDs")
      subIfds = Array.isArray(raw) ? raw : Array.from(raw as ArrayLike<number>)
    }
  } catch {
    // SubIFDs not available
  }

  if (subIfds && subIfds.length > 0) {
    // Modern format: base + N sub-resolutions
    const levels = subIfds.length + 1
    const widths = [baseWidth]
    const heights = [baseHeight]

    // Parse each SubIFD to get its dimensions
    for (const offset of subIfds) {
      try {
        const ifd = await (tiff as any).parseFileDirectoryAt(offset)
        const subWidth =
          ifd.fileDirectory?.getValue?.("ImageWidth") ??
          ifd.getValue?.("ImageWidth") ??
          Math.ceil(widths[widths.length - 1] / 2)
        const subHeight =
          ifd.fileDirectory?.getValue?.("ImageLength") ??
          ifd.getValue?.("ImageLength") ??
          Math.ceil(heights[heights.length - 1] / 2)
        widths.push(subWidth)
        heights.push(subHeight)
      } catch {
        // Fallback: assume 2x downsampling
        widths.push(Math.ceil(widths[widths.length - 1] / 2))
        heights.push(Math.ceil(heights[heights.length - 1] / 2))
      }
    }

    return { levels, usesSubIfds: true, widths, heights }
  }

  // Legacy: multiple OME Image entries = multiple resolution levels
  if (omeImages > 1) {
    const levels = omeImages
    const widths = [baseWidth]
    const heights = [baseHeight]

    for (let lvl = 1; lvl < levels; lvl++) {
      const ifdIdx = lvl * planesPerImage
      try {
        const img = await tiff.getImage(ifdIdx)
        widths.push(img.getWidth())
        heights.push(img.getHeight())
      } catch {
        widths.push(Math.ceil(widths[widths.length - 1] / 2))
        heights.push(Math.ceil(heights[heights.length - 1] / 2))
      }
    }

    return { levels, usesSubIfds: false, widths, heights }
  }

  // Check for COG-style: multiple IFDs with decreasing resolution
  // (non-OME TIFFs with overview images)
  try {
    const imageCount = await tiff.getImageCount()
    if (imageCount > 1) {
      const widths = [baseWidth]
      const heights = [baseHeight]
      for (let i = 1; i < imageCount; i++) {
        const img = await tiff.getImage(i)
        const w = img.getWidth()
        const h = img.getHeight()
        // Only count as pyramid level if it's smaller
        if (w < widths[widths.length - 1] && h < heights[heights.length - 1]) {
          widths.push(w)
          heights.push(h)
        } else {
          break
        }
      }
      if (widths.length > 1) {
        return {
          levels: widths.length,
          usesSubIfds: false,
          widths,
          heights,
        }
      }
    }
  } catch {
    // Cannot determine image count
  }

  // Single level (no pyramid)
  return {
    levels: 1,
    usesSubIfds: false,
    widths: [baseWidth],
    heights: [baseHeight],
  }
}

/**
 * Create an indexer function for OME-TIFF images.
 *
 * The returned function maps a (selection, level) pair to a GeoTIFFImage.
 *
 * @param tiff - The opened GeoTIFF object.
 * @param pixels - OME-XML Pixels metadata.
 * @param pyramid - Pyramid info from detectPyramid.
 * @param ifdOffset - Offset into the IFD chain for this OME Image entry.
 * @param offsets - Optional pre-computed IFD byte offsets.
 */
export function createOmeIndexer(
  tiff: GeoTIFF,
  pixels: OmePixels,
  pyramid: PyramidInfo,
  ifdOffset: number = 0,
  offsets?: number[],
): (sel: PlaneSelection, level: number) => Promise<GeoTIFFImage> {
  const ifdCache = new Map<number | string, Promise<GeoTIFFImage>>()
  const planesPerImage = pixels.sizeC * pixels.sizeZ * pixels.sizeT

  return async (sel: PlaneSelection, level: number): Promise<GeoTIFFImage> => {
    const relativeIfd = getIfdIndex(sel.c, sel.z, sel.t, pixels)
    const absoluteIfd = relativeIfd + ifdOffset

    if (level === 0) {
      // Base resolution: fetch the IFD directly
      return getImage(tiff, absoluteIfd, offsets)
    }

    if (pyramid.usesSubIfds) {
      // Modern: get base image, then look up SubIFD for the pyramid level
      const cacheKey = `sub_${absoluteIfd}_${level}`
      if (!ifdCache.has(cacheKey)) {
        ifdCache.set(
          cacheKey,
          (async () => {
            const baseImage = await getImage(tiff, absoluteIfd, offsets)
            const rawSubIfds =
              await baseImage.fileDirectory.loadValue("SubIFDs")
            const subIfds: number[] = Array.isArray(rawSubIfds)
              ? rawSubIfds
              : Array.from(rawSubIfds as ArrayLike<number>)
            const subIfdOffset = subIfds[level - 1]
            if (subIfdOffset === undefined) {
              throw new Error(
                `SubIFD index ${level - 1} out of range (${subIfds.length} available)`,
              )
            }
            return getImageAtOffset(tiff, subIfdOffset)
          })(),
        )
      }
      return ifdCache.get(cacheKey)!
    }

    // Legacy: flat IFD chain, each level's IFDs are offset by
    // level * planesPerImage from the base
    const levelIfd = absoluteIfd + level * planesPerImage
    return getImage(tiff, levelIfd, offsets)
  }
}

/**
 * Create an indexer function using a direct IFD lookup table.
 *
 * Used for multi-file OME-TIFFs where the formula-based index from
 * {@link getIfdIndex} cannot be used because only a subset of the
 * declared planes exist in the current file. The lookup table is
 * produced by {@link filterPixelsForFile}.
 *
 * @param tiff - The opened GeoTIFF object.
 * @param ifdMap - Map from `"c,z,t"` (local indices) to IFD index.
 * @param pyramid - Pyramid info from detectPyramid.
 * @param localPlanesPerImage - Number of local planes (for legacy level offsets).
 * @param offsets - Optional pre-computed IFD byte offsets.
 */
export function createTiffDataIndexer(
  tiff: GeoTIFF,
  ifdMap: Map<string, number>,
  pyramid: PyramidInfo,
  localPlanesPerImage: number,
  offsets?: number[],
): (sel: PlaneSelection, level: number) => Promise<GeoTIFFImage> {
  const ifdCache = new Map<string, Promise<GeoTIFFImage>>()

  return async (sel: PlaneSelection, level: number): Promise<GeoTIFFImage> => {
    const key = `${sel.c},${sel.z},${sel.t}`
    const baseIfd = ifdMap.get(key)
    if (baseIfd === undefined) {
      throw new Error(
        `No IFD mapping for plane (c=${sel.c}, z=${sel.z}, t=${sel.t})`,
      )
    }

    if (level === 0) {
      return getImage(tiff, baseIfd, offsets)
    }

    if (pyramid.usesSubIfds) {
      const cacheKey = `sub_${baseIfd}_${level}`
      if (!ifdCache.has(cacheKey)) {
        ifdCache.set(
          cacheKey,
          (async () => {
            const baseImage = await getImage(tiff, baseIfd, offsets)
            const rawSubIfds =
              await baseImage.fileDirectory.loadValue("SubIFDs")
            const subIfds: number[] = Array.isArray(rawSubIfds)
              ? rawSubIfds
              : Array.from(rawSubIfds as ArrayLike<number>)
            const subIfdOffset = subIfds[level - 1]
            if (subIfdOffset === undefined) {
              throw new Error(
                `SubIFD index ${level - 1} out of range (${subIfds.length} available)`,
              )
            }
            return getImageAtOffset(tiff, subIfdOffset)
          })(),
        )
      }
      return ifdCache.get(cacheKey)!
    }

    // Legacy: flat IFD chain — offset by level * local planes
    const levelIfd = baseIfd + level * localPlanesPerImage
    return getImage(tiff, levelIfd, offsets)
  }
}

/**
 * Create an indexer function for plain (non-OME) TIFF images.
 *
 * For plain TIFFs: single channel, each IFD is a different resolution level
 * (COG pattern) or a single image.
 */
export function createPlainIndexer(
  tiff: GeoTIFF,
  offsets?: number[],
): (sel: PlaneSelection, level: number) => Promise<GeoTIFFImage> {
  return async (_sel: PlaneSelection, level: number): Promise<GeoTIFFImage> => {
    return getImage(tiff, level, offsets)
  }
}

// ---------- internal helpers ----------

/**
 * Get a GeoTIFFImage by IFD index, using pre-computed offsets if available.
 */
async function getImage(
  tiff: GeoTIFF,
  index: number,
  offsets?: number[],
): Promise<GeoTIFFImage> {
  if (offsets && index < offsets.length) {
    // Use pre-computed offset for direct access
    return getImageAtOffset(tiff, offsets[index])
  }
  return tiff.getImage(index)
}

/**
 * Parse an IFD at a specific byte offset and return a GeoTIFFImage.
 */
async function getImageAtOffset(
  tiff: GeoTIFF,
  byteOffset: number,
): Promise<GeoTIFFImage> {
  // GeoTIFF.parseFileDirectoryAt is semi-internal but widely used by Viv etc.
  const ifd = await (tiff as any).parseFileDirectoryAt(byteOffset)
  // Construct a GeoTIFFImage from the parsed IFD
  // The exact constructor signature depends on geotiff.js version
  const GeoTIFFImageClass = (await tiff.getImage(0)).constructor as any
  return new GeoTIFFImageClass(
    ifd.fileDirectory ?? ifd,
    (tiff as any).littleEndian,
    (tiff as any).cache,
    (tiff as any).source,
  )
}
