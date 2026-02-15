// SPDX-FileCopyrightText: Copyright (c) Fideus Labs LLC
// SPDX-License-Identifier: MIT

/**
 * Test fixture helpers: create small TIFF files in memory for testing.
 *
 * Uses geotiff.js writeArrayBuffer to create minimal TIFF files,
 * and also provides OME-XML generation for OME-TIFF test files.
 */

import { writeArrayBuffer, fromArrayBuffer } from "geotiff";

/**
 * Create a simple single-band uint8 TIFF with known pixel values.
 * 64x64 pixels, uncompressed, with a linear gradient pattern.
 */
export function createSimpleTiff(): ArrayBuffer {
  const width = 64;
  const height = 64;
  const values = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      values[y * width + x] = (x + y) % 256;
    }
  }

  return writeArrayBuffer(values as any, {
    width,
    height,
    BitsPerSample: [8],
    SampleFormat: [1], // unsigned int
    PhotometricInterpretation: 1, // MinIsBlack
    SamplesPerPixel: 1,
  });
}

/**
 * Create a uint16 strip-based TIFF with known pixel values.
 * 128x128 pixels, strip-based, with a gradient pattern.
 *
 * Note: geotiff.js writeArrayBuffer only supports strip-based TIFFs,
 * not tiled TIFFs. The strip layout still exercises multi-chunk reading
 * since our store presents the data with a configurable chunk size.
 */
export function createUint16Tiff(): ArrayBuffer {
  const width = 128;
  const height = 128;
  const values = new Uint16Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      values[y * width + x] = (x * 100 + y) % 65536;
    }
  }

  return writeArrayBuffer(values as any, {
    width,
    height,
    BitsPerSample: [16],
    SampleFormat: [1], // unsigned int
    PhotometricInterpretation: 1,
    SamplesPerPixel: 1,
  });
}

/**
 * Create an OME-TIFF with known pixel data and embedded OME-XML.
 *
 * 64x48 pixels, 2 channels, uint16.
 * Channel 0: pixel value = x
 * Channel 1: pixel value = y
 *
 * We can't embed OME-XML via writeArrayBuffer directly (it only writes
 * simple TIFFs), so we manually build a TIFF with OME-XML in the
 * ImageDescription tag.
 */
export function createOmeTiffXml(
  width: number,
  height: number,
  sizeC: number,
  sizeZ: number,
  sizeT: number,
  pixelType: string = "uint16",
  physicalSizeX?: number,
  physicalSizeY?: number,
  physicalSizeZ?: number,
  imageName?: string,
): string {
  const channels = Array.from({ length: sizeC }, (_, i) => {
    const colors = [-16776961, 16711935, 65535, -256]; // RGBA ints
    return `<Channel ID="Channel:0:${i}" Name="Ch${i}" SamplesPerPixel="1" Color="${colors[i % colors.length]}"/>`;
  }).join("\n        ");

  const physX = physicalSizeX
    ? ` PhysicalSizeX="${physicalSizeX}" PhysicalSizeXUnit="µm"`
    : "";
  const physY = physicalSizeY
    ? ` PhysicalSizeY="${physicalSizeY}" PhysicalSizeYUnit="µm"`
    : "";
  const physZ = physicalSizeZ
    ? ` PhysicalSizeZ="${physicalSizeZ}" PhysicalSizeZUnit="µm"`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06">
  <Image ID="Image:0" Name="${imageName ?? "test"}">
    <Pixels ID="Pixels:0" DimensionOrder="XYZCT" Type="${pixelType}"
            SizeX="${width}" SizeY="${height}" SizeZ="${sizeZ}" SizeC="${sizeC}" SizeT="${sizeT}"
            BigEndian="false"${physX}${physY}${physZ}>
        ${channels}
    </Pixels>
  </Image>
</OME>`;
}

/**
 * Create a multi-IFD TIFF where each IFD is one channel of an OME-TIFF.
 * The OME-XML is embedded in the first IFD's ImageDescription.
 *
 * Since geotiff.js writeArrayBuffer only creates single-IFD TIFFs,
 * we create the TIFF by concatenating multiple single-IFD TIFFs'
 * IFD data -- but this is complex. Instead, we use a simpler approach:
 * create one TIFF and set the OME-XML, then test with single-plane.
 */
export function createSinglePlaneOmeTiff(
  width: number = 64,
  height: number = 48,
): ArrayBuffer {
  const values = new Uint16Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      values[y * width + x] = x + y * width;
    }
  }

  const omeXml = createOmeTiffXml(width, height, 1, 1, 1, "uint16", 0.5, 0.5);

  return writeArrayBuffer(values as any, {
    width,
    height,
    BitsPerSample: [16],
    SampleFormat: [1],
    PhotometricInterpretation: 1,
    SamplesPerPixel: 1,
    ImageDescription: omeXml,
  } as any);
}

/**
 * Create a float32 TIFF for testing floating-point data types.
 * 32x32 pixels with values between 0.0 and 1.0.
 */
export function createFloat32Tiff(): ArrayBuffer {
  const width = 32;
  const height = 32;
  const values = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      values[y * width + x] = (x + y) / (width + height - 2);
    }
  }

  return writeArrayBuffer(values as any, {
    width,
    height,
    BitsPerSample: [32],
    SampleFormat: [3], // float
    PhotometricInterpretation: 1,
    SamplesPerPixel: 1,
  });
}

/**
 * Verify a TIFF can be opened with geotiff.js (sanity check).
 */
export async function verifyTiff(
  buffer: ArrayBuffer,
): Promise<{ width: number; height: number; bitsPerSample: number }> {
  const tiff = await fromArrayBuffer(buffer);
  const image = await tiff.getImage(0);
  return {
    width: image.getWidth(),
    height: image.getHeight(),
    bitsPerSample: image.getBitsPerSample(),
  };
}
