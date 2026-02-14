// SPDX-FileCopyrightText: Copyright (c) Fideus Labs LLC
// SPDX-License-Identifier: MIT

import { describe, it, expect } from "bun:test";
import {
  buildAxes,
  buildShape,
  buildCoordinateTransformations,
  buildMultiscales,
  buildOmero,
  buildRootGroupJson,
  buildArrayJson,
} from "../src/metadata.js";
import type { OmePixels } from "../src/ome-xml.js";
import type { PyramidInfo } from "../src/ifd-indexer.js";

function makePixels(overrides?: Partial<OmePixels>): OmePixels {
  return {
    sizeX: 512,
    sizeY: 512,
    sizeZ: 1,
    sizeC: 1,
    sizeT: 1,
    dimensionOrder: "XYZCT",
    type: "uint16",
    bigEndian: false,
    interleaved: false,
    channels: [{ id: "Channel:0:0", samplesPerPixel: 1 }],
    ...overrides,
  };
}

function makePyramid(overrides?: Partial<PyramidInfo>): PyramidInfo {
  return {
    levels: 1,
    usesSubIfds: false,
    widths: [512],
    heights: [512],
    ...overrides,
  };
}

describe("buildAxes", () => {
  it("builds 2D axes for plain TIFF (no pixels)", () => {
    const { axes, dimNames } = buildAxes();
    expect(dimNames).toEqual(["y", "x"]);
    expect(axes).toEqual([
      { name: "y", type: "space" },
      { name: "x", type: "space" },
    ]);
  });

  it("builds axes for single-channel 2D OME image", () => {
    const { axes, dimNames } = buildAxes(makePixels());
    expect(dimNames).toEqual(["y", "x"]);
    expect(axes).toHaveLength(2);
  });

  it("includes channel axis when sizeC > 1", () => {
    const { axes, dimNames } = buildAxes(makePixels({ sizeC: 3 }));
    expect(dimNames).toContain("c");
    const cAxis = axes.find((a) => a.name === "c");
    expect(cAxis?.type).toBe("channel");
  });

  it("includes z axis when sizeZ > 1", () => {
    const { axes, dimNames } = buildAxes(makePixels({ sizeZ: 10 }));
    expect(dimNames).toContain("z");
    const zAxis = axes.find((a) => a.name === "z");
    expect(zAxis?.type).toBe("space");
  });

  it("includes t axis when sizeT > 1", () => {
    const { axes, dimNames } = buildAxes(makePixels({ sizeT: 5 }));
    expect(dimNames).toContain("t");
    const tAxis = axes.find((a) => a.name === "t");
    expect(tAxis?.type).toBe("time");
  });

  it("orders axes as t, c, z, y, x", () => {
    const { dimNames } = buildAxes(
      makePixels({ sizeT: 2, sizeC: 3, sizeZ: 4 }),
    );
    expect(dimNames).toEqual(["t", "c", "z", "y", "x"]);
  });

  it("includes physical units from OME metadata", () => {
    const { axes } = buildAxes(
      makePixels({
        physicalSizeX: 0.5,
        physicalSizeXUnit: "µm",
        physicalSizeY: 0.5,
        physicalSizeYUnit: "µm",
      }),
    );
    const xAxis = axes.find((a) => a.name === "x");
    expect(xAxis?.unit).toBe("micrometer");
  });
});

describe("buildShape", () => {
  it("builds 2D shape", () => {
    const pyramid = makePyramid();
    const shape = buildShape(makePixels(), pyramid, 0, ["y", "x"]);
    expect(shape).toEqual([512, 512]);
  });

  it("builds 5D shape", () => {
    const pixels = makePixels({ sizeT: 2, sizeC: 3, sizeZ: 4 });
    const pyramid = makePyramid();
    const shape = buildShape(pixels, pyramid, 0, ["t", "c", "z", "y", "x"]);
    expect(shape).toEqual([2, 3, 4, 512, 512]);
  });

  it("uses pyramid dimensions for spatial axes at level > 0", () => {
    const pyramid = makePyramid({
      levels: 2,
      widths: [512, 256],
      heights: [512, 256],
    });
    const shape = buildShape(makePixels(), pyramid, 1, ["y", "x"]);
    expect(shape).toEqual([256, 256]);
  });
});

describe("buildCoordinateTransformations", () => {
  it("builds identity scale for level 0", () => {
    const pyramid = makePyramid();
    const transforms = buildCoordinateTransformations(
      makePixels(),
      pyramid,
      0,
      ["y", "x"],
    );
    expect(transforms).toHaveLength(1);
    expect(transforms[0].type).toBe("scale");
    // Level 0: factor is 1.0 * physicalSize
  });

  it("builds 2x scale for level 1", () => {
    const pixels = makePixels({ physicalSizeX: 1.0, physicalSizeY: 1.0 });
    const pyramid = makePyramid({
      levels: 2,
      widths: [512, 256],
      heights: [512, 256],
    });
    const transforms = buildCoordinateTransformations(
      pixels,
      pyramid,
      1,
      ["y", "x"],
    );
    // At level 1, factor = 512/256 = 2, so scale = 1.0 * 2 = 2.0
    expect(transforms[0].scale).toEqual([2.0, 2.0]);
  });

  it("preserves physical sizes in scale", () => {
    const pixels = makePixels({ physicalSizeX: 0.325, physicalSizeY: 0.325 });
    const pyramid = makePyramid();
    const transforms = buildCoordinateTransformations(
      pixels,
      pyramid,
      0,
      ["y", "x"],
    );
    expect(transforms[0].scale).toEqual([0.325, 0.325]);
  });

  it("uses 1.0 for non-spatial dimensions", () => {
    const pixels = makePixels({ sizeT: 2, sizeC: 3 });
    const pyramid = makePyramid();
    const transforms = buildCoordinateTransformations(
      pixels,
      pyramid,
      0,
      ["t", "c", "y", "x"],
    );
    expect(transforms[0].scale![0]).toBe(1.0); // t
    expect(transforms[0].scale![1]).toBe(1.0); // c
  });
});

describe("buildMultiscales", () => {
  it("builds single-level multiscale", () => {
    const { multiscale } = buildMultiscales(makePixels(), makePyramid());
    expect(multiscale.datasets).toHaveLength(1);
    expect(multiscale.datasets[0].path).toBe("0");
  });

  it("builds multi-level multiscale", () => {
    const pyramid = makePyramid({
      levels: 3,
      widths: [512, 256, 128],
      heights: [512, 256, 128],
    });
    const { multiscale } = buildMultiscales(makePixels(), pyramid);
    expect(multiscale.datasets).toHaveLength(3);
    expect(multiscale.datasets[0].path).toBe("0");
    expect(multiscale.datasets[1].path).toBe("1");
    expect(multiscale.datasets[2].path).toBe("2");
  });

  it("includes name when provided", () => {
    const { multiscale } = buildMultiscales(
      makePixels(),
      makePyramid(),
      "test-image",
    );
    expect(multiscale.name).toBe("test-image");
  });
});

describe("buildOmero", () => {
  it("returns undefined when no pixels", () => {
    expect(buildOmero()).toBeUndefined();
  });

  it("builds omero metadata with channels", () => {
    const pixels = makePixels({
      sizeC: 2,
      channels: [
        { id: "Channel:0:0", name: "DAPI", samplesPerPixel: 1, color: -16776961 },
        { id: "Channel:0:1", name: "GFP", samplesPerPixel: 1, color: 16711935 },
      ],
    });
    const omero = buildOmero(pixels, "uint16");
    expect(omero).toBeDefined();
    expect(omero!.channels).toHaveLength(2);
    expect(omero!.channels[0].label).toBe("DAPI");
    expect(omero!.channels[1].label).toBe("GFP");
    expect(omero!.channels[0].active).toBe(true);
    expect(omero!.channels[0].window.min).toBe(0);
    expect(omero!.channels[0].window.max).toBe(65535);
    expect(omero!.rdefs.model).toBe("color");
  });

  it("defaults to greyscale for single channel", () => {
    const pixels = makePixels({ sizeC: 1 });
    const omero = buildOmero(pixels, "uint8");
    expect(omero!.rdefs.model).toBe("greyscale");
    expect(omero!.channels[0].window.max).toBe(255);
  });
});

describe("buildRootGroupJson", () => {
  it("produces valid Zarr v3 group metadata", () => {
    const { multiscale } = buildMultiscales(makePixels(), makePyramid());
    const json = buildRootGroupJson(multiscale);

    expect(json.zarr_format).toBe(3);
    expect(json.node_type).toBe("group");
    const ome = json.attributes.ome as Record<string, unknown>;
    expect(ome.version).toBe("0.5");
    expect(ome.multiscales).toBeDefined();
  });

  it("includes omero when provided", () => {
    const { multiscale } = buildMultiscales(makePixels(), makePyramid());
    const omero = buildOmero(makePixels(), "uint16");
    const json = buildRootGroupJson(multiscale, omero);
    const ome = json.attributes.ome as Record<string, unknown>;
    expect(ome.omero).toBeDefined();
  });
});

describe("buildArrayJson", () => {
  it("produces valid Zarr v3 array metadata", () => {
    const json = buildArrayJson(
      [3, 512, 512],
      [1, 256, 256],
      "uint16",
      ["c", "y", "x"],
    );

    expect(json.zarr_format).toBe(3);
    expect(json.node_type).toBe("array");
    expect(json.shape).toEqual([3, 512, 512]);
    expect(json.data_type).toBe("uint16");
    expect(json.chunk_grid.name).toBe("regular");
    expect(json.chunk_grid.configuration.chunk_shape).toEqual([1, 256, 256]);
    expect(json.chunk_key_encoding.name).toBe("default");
    expect(json.chunk_key_encoding.configuration.separator).toBe("/");
    expect(json.fill_value).toBe(0);
    expect(json.codecs).toHaveLength(1);
    expect(json.codecs[0].name).toBe("bytes");
    expect(json.dimension_names).toEqual(["c", "y", "x"]);
  });
});
