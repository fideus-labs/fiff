import { describe, it, expect } from "bun:test";
import { TiffStore } from "../src/tiff-store.js";
import {
  createSimpleTiff,
  createUint16Tiff,
  createFloat32Tiff,
  createSinglePlaneOmeTiff,
} from "./fixtures.js";

describe("TiffStore", () => {
  describe("fromArrayBuffer with simple TIFF", () => {
    it("opens a simple uint8 TIFF", async () => {
      const buffer = createSimpleTiff();
      const store = await TiffStore.fromArrayBuffer(buffer);

      expect(store.levels).toBe(1);
      expect(store.dataType).toBe("uint8");
      expect(store.dimensionNames).toEqual(["y", "x"]);
    });

    it("returns root group zarr.json", async () => {
      const buffer = createSimpleTiff();
      const store = await TiffStore.fromArrayBuffer(buffer);

      const data = await store.get("zarr.json");
      expect(data).toBeDefined();

      const json = JSON.parse(new TextDecoder().decode(data));
      expect(json.zarr_format).toBe(3);
      expect(json.node_type).toBe("group");
      expect(json.attributes.ome).toBeDefined();
      expect(json.attributes.ome.version).toBe("0.5");
      expect(json.attributes.ome.multiscales).toHaveLength(1);
    });

    it("returns array zarr.json for level 0", async () => {
      const buffer = createSimpleTiff();
      const store = await TiffStore.fromArrayBuffer(buffer);

      const data = await store.get("0/zarr.json");
      expect(data).toBeDefined();

      const json = JSON.parse(new TextDecoder().decode(data));
      expect(json.zarr_format).toBe(3);
      expect(json.node_type).toBe("array");
      expect(json.shape).toEqual([64, 64]);
      expect(json.data_type).toBe("uint8");
      expect(json.dimension_names).toEqual(["y", "x"]);
    });

    it("returns undefined for non-existent level", async () => {
      const buffer = createSimpleTiff();
      const store = await TiffStore.fromArrayBuffer(buffer);

      const data = await store.get("5/zarr.json");
      expect(data).toBeUndefined();
    });

    it("returns undefined for unknown keys", async () => {
      const buffer = createSimpleTiff();
      const store = await TiffStore.fromArrayBuffer(buffer);

      const data = await store.get("foo/bar");
      expect(data).toBeUndefined();
    });

    it("reads chunk data at (0,0)", async () => {
      const buffer = createSimpleTiff();
      const store = await TiffStore.fromArrayBuffer(buffer);

      const data = await store.get("0/c/0/0");
      expect(data).toBeDefined();
      expect(data!.length).toBeGreaterThan(0);

      // The fixture has a gradient pattern: value = (x + y) % 256
      // Verify first pixel
      expect(data![0]).toBe(0); // x=0, y=0 -> 0
    });
  });

  describe("fromArrayBuffer with uint16 TIFF", () => {
    it("detects uint16 data type", async () => {
      const buffer = createUint16Tiff();
      const store = await TiffStore.fromArrayBuffer(buffer);

      expect(store.dataType).toBe("uint16");
      expect(store.getShape(0)).toEqual([128, 128]);
    });

    it("reads chunk data correctly", async () => {
      const buffer = createUint16Tiff();
      const store = await TiffStore.fromArrayBuffer(buffer);

      const data = await store.get("0/c/0/0");
      expect(data).toBeDefined();
      expect(data!.length).toBeGreaterThan(0);
    });

    it("returns correct array metadata", async () => {
      const buffer = createUint16Tiff();
      const store = await TiffStore.fromArrayBuffer(buffer);

      const data = await store.get("0/zarr.json");
      const json = JSON.parse(new TextDecoder().decode(data));
      expect(json.data_type).toBe("uint16");
      expect(json.shape).toEqual([128, 128]);
    });
  });

  describe("fromArrayBuffer with float32 TIFF", () => {
    it("handles float32 data type", async () => {
      const buffer = createFloat32Tiff();
      const store = await TiffStore.fromArrayBuffer(buffer);

      expect(store.dataType).toBe("float32");
    });

    it("returns correct array metadata", async () => {
      const buffer = createFloat32Tiff();
      const store = await TiffStore.fromArrayBuffer(buffer);

      const data = await store.get("0/zarr.json");
      const json = JSON.parse(new TextDecoder().decode(data));
      expect(json.data_type).toBe("float32");
      expect(json.shape).toEqual([32, 32]);
    });

    it("reads float32 chunk data", async () => {
      const buffer = createFloat32Tiff();
      const store = await TiffStore.fromArrayBuffer(buffer);

      const data = await store.get("0/c/0/0");
      expect(data).toBeDefined();
      // 32x32 pixels * 4 bytes = 4096 bytes
      expect(data!.length).toBe(32 * 32 * 4);
    });
  });

  describe("fromArrayBuffer with OME-TIFF", () => {
    it("parses OME-XML metadata", async () => {
      const buffer = createSinglePlaneOmeTiff();
      const store = await TiffStore.fromArrayBuffer(buffer);

      expect(store.ome).toHaveLength(1);
      expect(store.ome[0].name).toBe("test");
      expect(store.dataType).toBe("uint16");
    });

    it("builds correct OME-Zarr metadata", async () => {
      const buffer = createSinglePlaneOmeTiff();
      const store = await TiffStore.fromArrayBuffer(buffer);

      const data = await store.get("zarr.json");
      const json = JSON.parse(new TextDecoder().decode(data));

      const ome = json.attributes.ome;
      expect(ome.version).toBe("0.5");
      expect(ome.multiscales).toHaveLength(1);

      const ms = ome.multiscales[0];
      expect(ms.axes).toBeDefined();
      // Should have y, x axes
      const axisNames = ms.axes.map((a: { name: string }) => a.name);
      expect(axisNames).toContain("y");
      expect(axisNames).toContain("x");
    });

    it("includes physical pixel sizes in coordinate transformations", async () => {
      const buffer = createSinglePlaneOmeTiff();
      const store = await TiffStore.fromArrayBuffer(buffer);

      const data = await store.get("zarr.json");
      const json = JSON.parse(new TextDecoder().decode(data));
      const ms = json.attributes.ome.multiscales[0];

      // Each dataset should have coordinateTransformations
      expect(ms.datasets[0].coordinateTransformations).toBeDefined();
      expect(ms.datasets[0].coordinateTransformations[0].type).toBe("scale");
    });

    it("reads OME-TIFF pixel data", async () => {
      const buffer = createSinglePlaneOmeTiff(64, 48);
      const store = await TiffStore.fromArrayBuffer(buffer);

      // Get array shape
      const arrData = await store.get("0/zarr.json");
      const arrJson = JSON.parse(new TextDecoder().decode(arrData));
      const shape = arrJson.shape;

      // Should be [48, 64] (y, x)
      expect(shape[shape.length - 1]).toBe(64);
      expect(shape[shape.length - 2]).toBe(48);

      // Read first chunk
      const chunkData = await store.get("0/c/0/0");
      expect(chunkData).toBeDefined();
      expect(chunkData!.length).toBeGreaterThan(0);
    });
  });

  describe("leading slash handling", () => {
    it("handles keys with leading slash", async () => {
      const buffer = createSimpleTiff();
      const store = await TiffStore.fromArrayBuffer(buffer);

      const data1 = await store.get("zarr.json");
      const data2 = await store.get("/zarr.json");
      expect(data1).toEqual(data2);
    });
  });

  describe("metadata caching", () => {
    it("returns same bytes for repeated root metadata requests", async () => {
      const buffer = createSimpleTiff();
      const store = await TiffStore.fromArrayBuffer(buffer);

      const data1 = await store.get("zarr.json");
      const data2 = await store.get("zarr.json");
      // Should be the exact same Uint8Array instance (cached)
      expect(data1).toBe(data2);
    });

    it("returns same bytes for repeated array metadata requests", async () => {
      const buffer = createSimpleTiff();
      const store = await TiffStore.fromArrayBuffer(buffer);

      const data1 = await store.get("0/zarr.json");
      const data2 = await store.get("0/zarr.json");
      expect(data1).toBe(data2);
    });
  });
});
