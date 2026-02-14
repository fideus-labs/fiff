/**
 * @fideus-labs/fiff
 *
 * Present TIFF files as a zarrita.js Zarr store following the OME-Zarr
 * (NGFF v0.5) data model.
 *
 * @example
 * ```ts
 * import { TiffStore } from "@fideus-labs/fiff";
 * import * as zarr from "zarrita";
 *
 * const store = await TiffStore.fromUrl("https://example.com/image.ome.tif");
 * const group = await zarr.open(store, { kind: "group" });
 * const arr = await zarr.open(group.resolve("0"), { kind: "array" });
 * const chunk = await arr.getChunk([0, 0, 0]);
 * ```
 */

export { TiffStore, type TiffStoreOptions } from "./tiff-store.js";

// Re-export types that consumers may need
export type { ZarrDataType } from "./dtypes.js";
export type { OmeImage, OmePixels, OmeChannel, DimensionOrder } from "./ome-xml.js";
export type { PyramidInfo, PlaneSelection } from "./ifd-indexer.js";
export type {
  OmeAxis,
  OmeMultiscale,
  OmeDataset,
  OmeCoordinateTransformation,
  OmeroMetadata,
  OmeroChannel,
  ZarrGroupMetadata,
  ZarrArrayMetadata,
} from "./metadata.js";

// Export utilities that may be useful
export { parseOmeXml, isOmeXml, getIfdIndex } from "./ome-xml.js";
export { tiffDtypeToZarr, omePixelTypeToZarr, bytesPerElement } from "./dtypes.js";
export { parseStoreKey, computePixelWindow } from "./utils.js";
