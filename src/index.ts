// SPDX-FileCopyrightText: Copyright (c) Fideus Labs LLC
// SPDX-License-Identifier: MIT

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

export { DEFLATE_WORKER_SOURCE } from "./deflate-worker.js"
// Re-export types that consumers may need
export type { ZarrDataType } from "./dtypes.js"
export {
  bytesPerElement,
  omePixelTypeToZarr,
  type TiffDtypeInfo,
  tiffDtypeToZarr,
  zarrToOmePixelType,
  zarrToTiffDtype,
} from "./dtypes.js"
export type { PlaneSelection, PyramidInfo } from "./ifd-indexer.js"
export type {
  OmeAxis,
  OmeCoordinateTransformation,
  OmeDataset,
  OmeMultiscale,
  OmeroChannel,
  OmeroMetadata,
  ZarrArrayMetadata,
  ZarrGroupMetadata,
} from "./metadata.js"
export type {
  DimensionOrder,
  FilteredPixels,
  OmeChannel,
  OmeImage,
  OmePixels,
  TiffDataEntry,
} from "./ome-xml.js"
// Export utilities that may be useful
export {
  filterPixelsForFile,
  getIfdIndex,
  isOmeXml,
  parseOmeXml,
  parseRootUuid,
} from "./ome-xml.js"
export {
  buildOmeXml,
  type DimensionInfo,
  type OmeXmlWriterOptions,
} from "./ome-xml-writer.js"
export { TiffStore, type TiffStoreOptions } from "./tiff-store.js"
export {
  type BuildTiffOptions,
  buildTiff,
  compressDeflate,
  compressDeflateAsync,
  DEFAULT_TILE_SIZE,
  makeImageTags,
  sliceTiles,
  type TiffTag,
  type WritableIfd,
} from "./tiff-writer.js"
export { computePixelWindow, parseStoreKey } from "./utils.js"
export {
  registerWorkerDecoder,
  unregisterWorkerDecoder,
  WorkerDeflateDecoder,
} from "./worker-decoder.js"
// Worker pool integration
export {
  type DeflatePool,
  getDeflateWorkerUrl,
} from "./worker-utils.js"
// Writer
export { type GetPlane, toOmeTiff, type WriteOptions } from "./write.js"
