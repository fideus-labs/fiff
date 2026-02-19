// SPDX-FileCopyrightText: Copyright (c) Fideus Labs LLC
// SPDX-License-Identifier: MIT

import {
  filterPixelsForFile,
  getIfdIndex,
  isOmeXml,
  normalizeUnit,
  type OmePixels,
  parseOmeXml,
  parseRootUuid,
} from "../src/ome-xml.js"
import { createOmeTiffXml } from "./fixtures.js"
import { describe, expect, it } from "bun:test"

describe("isOmeXml", () => {
  it("detects XML processing instruction", () => {
    expect(isOmeXml('<?xml version="1.0"?><OME/>')).toBe(true)
  })

  it("detects OME root element", () => {
    expect(isOmeXml("<OME>...</OME>")).toBe(true)
  })

  it("detects namespaced OME element", () => {
    expect(isOmeXml("<ome:OME>...</ome:OME>")).toBe(true)
  })

  it("rejects non-OME XML", () => {
    expect(isOmeXml("<html><body/></html>")).toBe(false)
    expect(isOmeXml("not xml at all")).toBe(false)
    expect(isOmeXml("")).toBe(false)
  })

  it("handles leading whitespace", () => {
    expect(isOmeXml("  \n  <OME/>")).toBe(true)
  })
})

describe("parseOmeXml", () => {
  it("parses a simple single-channel OME-XML", () => {
    const xml = createOmeTiffXml(256, 256, 1, 1, 1)
    const images = parseOmeXml(xml)

    expect(images).toHaveLength(1)
    expect(images[0].id).toBe("Image:0")
    expect(images[0].name).toBe("test")
    expect(images[0].pixels.sizeX).toBe(256)
    expect(images[0].pixels.sizeY).toBe(256)
    expect(images[0].pixels.sizeC).toBe(1)
    expect(images[0].pixels.sizeZ).toBe(1)
    expect(images[0].pixels.sizeT).toBe(1)
    expect(images[0].pixels.dimensionOrder).toBe("XYZCT")
    expect(images[0].pixels.type).toBe("uint16")
    expect(images[0].pixels.channels).toHaveLength(1)
  })

  it("parses multi-channel OME-XML", () => {
    const xml = createOmeTiffXml(128, 128, 3, 1, 1)
    const images = parseOmeXml(xml)

    expect(images[0].pixels.sizeC).toBe(3)
    expect(images[0].pixels.channels).toHaveLength(3)
    expect(images[0].pixels.channels[0].name).toBe("Ch0")
    expect(images[0].pixels.channels[1].name).toBe("Ch1")
    expect(images[0].pixels.channels[2].name).toBe("Ch2")
  })

  it("parses multi-dimensional OME-XML", () => {
    const xml = createOmeTiffXml(64, 64, 2, 5, 3)
    const images = parseOmeXml(xml)

    expect(images[0].pixels.sizeC).toBe(2)
    expect(images[0].pixels.sizeZ).toBe(5)
    expect(images[0].pixels.sizeT).toBe(3)
  })

  it("parses physical pixel sizes", () => {
    const xml = createOmeTiffXml(64, 64, 1, 5, 1, "uint16", 0.325, 0.325, 1.5)
    const images = parseOmeXml(xml)

    expect(images[0].pixels.physicalSizeX).toBeCloseTo(0.325)
    expect(images[0].pixels.physicalSizeY).toBeCloseTo(0.325)
    expect(images[0].pixels.physicalSizeZ).toBeCloseTo(1.5)
  })

  it("parses channel colors", () => {
    const xml = createOmeTiffXml(64, 64, 2, 1, 1)
    const images = parseOmeXml(xml)

    // Colors are specified in the fixture as RGBA integers
    expect(images[0].pixels.channels[0].color).toBeDefined()
    expect(images[0].pixels.channels[1].color).toBeDefined()
  })

  it("parses custom image name", () => {
    const xml = createOmeTiffXml(
      64,
      64,
      1,
      1,
      1,
      "uint16",
      undefined,
      undefined,
      undefined,
      "MyImage",
    )
    const images = parseOmeXml(xml)
    expect(images[0].name).toBe("MyImage")
  })

  it("handles different pixel types", () => {
    for (const type of [
      "uint8",
      "uint16",
      "uint32",
      "int16",
      "float",
      "double",
    ]) {
      const xml = createOmeTiffXml(32, 32, 1, 1, 1, type)
      const images = parseOmeXml(xml)
      expect(images[0].pixels.type).toBe(type)
    }
  })
})

describe("getIfdIndex", () => {
  it("computes XYZCT ordering correctly", () => {
    const pixels = {
      sizeZ: 5,
      sizeC: 3,
      sizeT: 2,
      dimensionOrder: "XYZCT" as const,
    } as OmePixels

    // Z varies fastest
    expect(getIfdIndex(0, 0, 0, pixels)).toBe(0)
    expect(getIfdIndex(0, 1, 0, pixels)).toBe(1)
    expect(getIfdIndex(0, 4, 0, pixels)).toBe(4)
    // Then C
    expect(getIfdIndex(1, 0, 0, pixels)).toBe(5)
    expect(getIfdIndex(2, 0, 0, pixels)).toBe(10)
    // Then T
    expect(getIfdIndex(0, 0, 1, pixels)).toBe(15)
    // Complex index
    expect(getIfdIndex(1, 2, 1, pixels)).toBe(1 * 5 + 2 + 1 * 5 * 3)
  })

  it("computes XYCZT ordering correctly", () => {
    const pixels = {
      sizeZ: 3,
      sizeC: 2,
      sizeT: 4,
      dimensionOrder: "XYCZT" as const,
    } as OmePixels

    // C varies fastest
    expect(getIfdIndex(0, 0, 0, pixels)).toBe(0)
    expect(getIfdIndex(1, 0, 0, pixels)).toBe(1)
    // Then Z
    expect(getIfdIndex(0, 1, 0, pixels)).toBe(2)
    expect(getIfdIndex(1, 2, 0, pixels)).toBe(1 + 2 * 2)
    // Then T
    expect(getIfdIndex(0, 0, 1, pixels)).toBe(6)
  })

  it("computes XYCTZ ordering correctly", () => {
    const pixels = {
      sizeZ: 2,
      sizeC: 3,
      sizeT: 2,
      dimensionOrder: "XYCTZ" as const,
    } as OmePixels

    expect(getIfdIndex(0, 0, 0, pixels)).toBe(0)
    expect(getIfdIndex(1, 0, 0, pixels)).toBe(1)
    expect(getIfdIndex(0, 0, 1, pixels)).toBe(3)
    expect(getIfdIndex(0, 1, 0, pixels)).toBe(6)
  })

  it("computes XYZTC ordering correctly", () => {
    const pixels = {
      sizeZ: 3,
      sizeC: 2,
      sizeT: 2,
      dimensionOrder: "XYZTC" as const,
    } as OmePixels

    // Z varies fastest, then T, then C
    expect(getIfdIndex(0, 0, 0, pixels)).toBe(0)
    expect(getIfdIndex(0, 2, 0, pixels)).toBe(2)
    expect(getIfdIndex(0, 0, 1, pixels)).toBe(3)
    expect(getIfdIndex(1, 0, 0, pixels)).toBe(6)
  })

  it("computes XYTCZ ordering correctly", () => {
    const pixels = {
      sizeZ: 2,
      sizeC: 2,
      sizeT: 3,
      dimensionOrder: "XYTCZ" as const,
    } as OmePixels

    // T varies fastest, then C, then Z
    expect(getIfdIndex(0, 0, 0, pixels)).toBe(0)
    expect(getIfdIndex(0, 0, 1, pixels)).toBe(1)
    expect(getIfdIndex(1, 0, 0, pixels)).toBe(3)
    expect(getIfdIndex(0, 1, 0, pixels)).toBe(6)
  })

  it("computes XYTZC ordering correctly", () => {
    const pixels = {
      sizeZ: 2,
      sizeC: 3,
      sizeT: 2,
      dimensionOrder: "XYTZC" as const,
    } as OmePixels

    // T varies fastest, then Z, then C
    expect(getIfdIndex(0, 0, 0, pixels)).toBe(0)
    expect(getIfdIndex(0, 0, 1, pixels)).toBe(1)
    expect(getIfdIndex(0, 1, 0, pixels)).toBe(2)
    expect(getIfdIndex(1, 0, 0, pixels)).toBe(4)
  })
})

describe("parseOmeXml TiffData parsing", () => {
  it("parses TiffData entries with UUIDs", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06"
     UUID="urn:uuid:aaaa-bbbb">
  <Image ID="Image:0" Name="multi">
    <Pixels ID="Pixels:0" DimensionOrder="XYZTC" Type="uint8"
            SizeX="512" SizeY="512" SizeZ="1" SizeC="2" SizeT="20"
            BigEndian="false">
      <Channel ID="Channel:0:0" SamplesPerPixel="1"/>
      <Channel ID="Channel:0:1" SamplesPerPixel="1"/>
      <TiffData FirstC="0" FirstZ="0" FirstT="0" IFD="0" PlaneCount="1">
        <UUID FileName="file_C0.ome.tif">urn:uuid:aaaa-bbbb</UUID>
      </TiffData>
      <TiffData FirstC="0" FirstZ="0" FirstT="1" IFD="1" PlaneCount="1">
        <UUID FileName="file_C0.ome.tif">urn:uuid:aaaa-bbbb</UUID>
      </TiffData>
      <TiffData FirstC="1" FirstZ="0" FirstT="0" IFD="0" PlaneCount="1">
        <UUID FileName="file_C1.ome.tif">urn:uuid:cccc-dddd</UUID>
      </TiffData>
      <TiffData FirstC="1" FirstZ="0" FirstT="1" IFD="1" PlaneCount="1">
        <UUID FileName="file_C1.ome.tif">urn:uuid:cccc-dddd</UUID>
      </TiffData>
    </Pixels>
  </Image>
</OME>`

    const images = parseOmeXml(xml)
    expect(images).toHaveLength(1)

    const td = images[0].pixels.tiffData
    expect(td).toHaveLength(4)

    expect(td[0]).toEqual({
      firstC: 0,
      firstZ: 0,
      firstT: 0,
      ifd: 0,
      planeCount: 1,
      uuid: "urn:uuid:aaaa-bbbb",
      fileName: "file_C0.ome.tif",
    })
    expect(td[2]).toEqual({
      firstC: 1,
      firstZ: 0,
      firstT: 0,
      ifd: 0,
      planeCount: 1,
      uuid: "urn:uuid:cccc-dddd",
      fileName: "file_C1.ome.tif",
    })
  })

  it("parses bare self-closing TiffData with defaults", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06">
  <Image ID="Image:0" Name="simple">
    <Pixels ID="Pixels:0" DimensionOrder="XYZCT" Type="uint16"
            SizeX="64" SizeY="64" SizeZ="1" SizeC="1" SizeT="1"
            BigEndian="false">
      <Channel ID="Channel:0:0" SamplesPerPixel="1"/>
      <TiffData FirstC="0" FirstZ="0" FirstT="0" IFD="0" PlaneCount="1"/>
    </Pixels>
  </Image>
</OME>`

    const images = parseOmeXml(xml)
    const td = images[0].pixels.tiffData
    expect(td).toHaveLength(1)
    expect(td[0]).toEqual({
      firstC: 0,
      firstZ: 0,
      firstT: 0,
      ifd: 0,
      planeCount: 1,
      uuid: undefined,
      fileName: undefined,
    })
  })

  it("returns empty tiffData when no TiffData elements present", () => {
    const xml = createOmeTiffXml(64, 64, 1, 1, 1)
    const images = parseOmeXml(xml)
    expect(images[0].pixels.tiffData).toEqual([])
  })
})

describe("parseRootUuid", () => {
  it("extracts UUID from OME root element", () => {
    const xml = `<?xml version="1.0"?>
<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06"
     UUID="urn:uuid:5ddaf51f-c9d7-43e7-ab5d-08ec25e74ba0">
  <Image ID="Image:0" Name="test">
    <Pixels ID="Pixels:0" DimensionOrder="XYZCT" Type="uint8"
            SizeX="64" SizeY="64" SizeZ="1" SizeC="1" SizeT="1"
            BigEndian="false"/>
  </Image>
</OME>`

    expect(parseRootUuid(xml)).toBe(
      "urn:uuid:5ddaf51f-c9d7-43e7-ab5d-08ec25e74ba0",
    )
  })

  it("returns undefined when no UUID on OME element", () => {
    const xml = `<?xml version="1.0"?>
<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06">
  <Image ID="Image:0"/>
</OME>`
    expect(parseRootUuid(xml)).toBeUndefined()
  })

  it("returns undefined for non-OME XML", () => {
    expect(parseRootUuid("<html/>")).toBeUndefined()
  })
})

describe("filterPixelsForFile", () => {
  /**
   * Helper: builds an OmePixels resembling `tubhiswt_C0.ome.tif`:
   * 512x512, SizeC=2, SizeT=20, SizeZ=1, DimensionOrder=XYZTC
   * 20 TiffData entries for C0 (local UUID), 20 for C1 (remote UUID).
   */
  function makeMultiFilePixels(): OmePixels {
    const localUuid = "urn:uuid:local-file"
    const remoteUuid = "urn:uuid:remote-file"
    const tiffData = []

    // Channel 0: 20 timepoints, IFDs 0-19, local UUID
    for (let t = 0; t < 20; t++) {
      tiffData.push({
        firstC: 0,
        firstZ: 0,
        firstT: t,
        ifd: t,
        planeCount: 1,
        uuid: localUuid,
        fileName: "file_C0.ome.tif",
      })
    }
    // Channel 1: 20 timepoints, IFDs 0-19, remote UUID
    for (let t = 0; t < 20; t++) {
      tiffData.push({
        firstC: 1,
        firstZ: 0,
        firstT: t,
        ifd: t,
        planeCount: 1,
        uuid: remoteUuid,
        fileName: "file_C1.ome.tif",
      })
    }

    return {
      sizeX: 512,
      sizeY: 512,
      sizeZ: 1,
      sizeC: 2,
      sizeT: 20,
      dimensionOrder: "XYZTC",
      type: "uint8",
      bigEndian: false,
      interleaved: false,
      channels: [
        { id: "Channel:0:0", samplesPerPixel: 1 },
        { id: "Channel:0:1", samplesPerPixel: 1 },
      ],
      tiffData,
    }
  }

  it("reduces dimensions to local planes only", () => {
    const pixels = makeMultiFilePixels()
    const result = filterPixelsForFile(pixels, "urn:uuid:local-file")

    expect(result).toBeDefined()
    expect(result!.pixels.sizeC).toBe(1)
    expect(result!.pixels.sizeZ).toBe(1)
    expect(result!.pixels.sizeT).toBe(20)
    expect(result!.pixels.channels).toHaveLength(1)
    expect(result!.pixels.channels[0].id).toBe("Channel:0:0")
  })

  it("builds correct IFD lookup map", () => {
    const pixels = makeMultiFilePixels()
    const result = filterPixelsForFile(pixels, "urn:uuid:local-file")

    expect(result).toBeDefined()
    const { ifdMap } = result!

    // Local C index is 0, Z is 0, T goes from 0 to 19
    expect(ifdMap.size).toBe(20)
    for (let t = 0; t < 20; t++) {
      expect(ifdMap.get(`0,0,${t}`)).toBe(t)
    }
  })

  it("returns undefined when all entries are local (no filtering needed)", () => {
    const pixels: OmePixels = {
      sizeX: 64,
      sizeY: 64,
      sizeZ: 1,
      sizeC: 1,
      sizeT: 1,
      dimensionOrder: "XYZCT",
      type: "uint16",
      bigEndian: false,
      interleaved: false,
      channels: [{ id: "Channel:0:0", samplesPerPixel: 1 }],
      tiffData: [
        {
          firstC: 0,
          firstZ: 0,
          firstT: 0,
          ifd: 0,
          planeCount: 1,
          uuid: "urn:uuid:same",
          fileName: "file.ome.tif",
        },
      ],
    }

    expect(filterPixelsForFile(pixels, "urn:uuid:same")).toBeUndefined()
  })

  it("returns undefined when tiffData is empty", () => {
    const pixels: OmePixels = {
      sizeX: 64,
      sizeY: 64,
      sizeZ: 1,
      sizeC: 1,
      sizeT: 1,
      dimensionOrder: "XYZCT",
      type: "uint16",
      bigEndian: false,
      interleaved: false,
      channels: [{ id: "Channel:0:0", samplesPerPixel: 1 }],
      tiffData: [],
    }

    expect(filterPixelsForFile(pixels)).toBeUndefined()
  })

  it("treats entries without UUID as local", () => {
    const pixels: OmePixels = {
      sizeX: 64,
      sizeY: 64,
      sizeZ: 1,
      sizeC: 2,
      sizeT: 1,
      dimensionOrder: "XYZCT",
      type: "uint16",
      bigEndian: false,
      interleaved: false,
      channels: [
        { id: "Channel:0:0", samplesPerPixel: 1 },
        { id: "Channel:0:1", samplesPerPixel: 1 },
      ],
      tiffData: [
        // No UUID — should be treated as local
        { firstC: 0, firstZ: 0, firstT: 0, ifd: 0, planeCount: 1 },
        // Remote UUID
        {
          firstC: 1,
          firstZ: 0,
          firstT: 0,
          ifd: 0,
          planeCount: 1,
          uuid: "urn:uuid:remote",
          fileName: "other.ome.tif",
        },
      ],
    }

    const result = filterPixelsForFile(pixels, "urn:uuid:local")
    expect(result).toBeDefined()
    expect(result!.pixels.sizeC).toBe(1)
    expect(result!.ifdMap.size).toBe(1)
    expect(result!.ifdMap.get("0,0,0")).toBe(0)
  })

  it("handles filtering for the remote file perspective", () => {
    const pixels = makeMultiFilePixels()
    // From C1's perspective, rootUuid matches the remote UUID
    const result = filterPixelsForFile(pixels, "urn:uuid:remote-file")

    expect(result).toBeDefined()
    expect(result!.pixels.sizeC).toBe(1)
    expect(result!.pixels.sizeT).toBe(20)
    // The channel should be Channel:0:1 (global C=1 → local C=0)
    expect(result!.pixels.channels[0].id).toBe("Channel:0:1")
  })
})

describe("normalizeUnit", () => {
  it("normalizes common unit abbreviations", () => {
    expect(normalizeUnit("µm")).toBe("micrometer")
    expect(normalizeUnit("um")).toBe("micrometer")
    expect(normalizeUnit("nm")).toBe("nanometer")
    expect(normalizeUnit("mm")).toBe("millimeter")
  })

  it("passes through full unit names", () => {
    expect(normalizeUnit("micrometer")).toBe("micrometer")
    expect(normalizeUnit("nanometer")).toBe("nanometer")
  })

  it("returns undefined for undefined input", () => {
    expect(normalizeUnit(undefined)).toBeUndefined()
  })

  it("passes through unknown units unchanged", () => {
    expect(normalizeUnit("parsec")).toBe("parsec")
  })
})
