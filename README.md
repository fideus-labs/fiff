<!-- SPDX-FileCopyrightText: Copyright (c) Fideus Labs LLC -->
<!-- SPDX-License-Identifier: MIT -->
<p align="center">
  <strong>fiff</strong>
</p>

<p align="center">
  <a href="https://github.com/fideus-labs/fiff/actions/workflows/ci.yml"><img src="https://github.com/fideus-labs/fiff/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/@fideus-labs/fiff"><img src="https://img.shields.io/npm/v/@fideus-labs/fiff" alt="npm version" /></a>
  <a href="https://github.com/fideus-labs/fiff/blob/main/LICENSE.txt"><img src="https://img.shields.io/npm/l/@fideus-labs/fiff" alt="license" /></a>
</p>

<p align="center">
  Read and write <a href="https://docs.openmicroscopy.org/ome-model/latest/ome-tiff/">OME-TIFF</a> files through a <a href="https://github.com/manzt/zarrita.js">zarrita.js</a> Zarr store following the <a href="https://ngff.openmicroscopy.org/0.5/">OME-Zarr v0.5</a> data model.
</p>

## ✨ Features

### Reading

- 🚀 **Lazy HTTP range requests** -- Chunk data is fetched on demand via
  geotiff.js `readRasters()`, no full file download needed
- 📐 **OME-XML support** -- Parses OME-XML metadata for dimensions, channels,
  physical units, and all 6 DimensionOrder permutations
- 🔍 **Pyramid detection** -- Automatically discovers multi-resolution levels
  via SubIFDs (modern), flat IFDs (legacy), or COG overviews
- 🧩 **Edge-chunk zero-padding** -- Boundary chunks are automatically padded to
  full tile size for correct Zarr consumption
- 🔗 **zarrita.js compatible** -- Implements the `AsyncReadable` interface;
  use directly with `zarr.open()` from zarrita.js
- 📋 **OME-Zarr v0.5 output** -- Generates Zarr v3 metadata with
  `ome.multiscales` and `ome.omero` attributes

### Writing

- 📝 **OME-TIFF generation** -- Convert ngff-zarr `Multiscales` objects to
  valid OME-TIFF files with embedded OME-XML metadata
- 🔻 **Full pyramid support** -- Multi-resolution levels are written as SubIFDs,
  matching the modern OME-TIFF pyramid convention
- 🗜️ **Deflate compression** -- Async zlib/deflate via native `CompressionStream`
  (non-blocking) with synchronous pako fallback
- 🧵 **Worker pool support** -- Optional `@fideus-labs/worker-pool` integration
  offloads compression and decompression to Web Workers, fully releasing the
  main thread
- 🧱 **Tiled output** -- Large images are automatically written as 256x256 tiles
  (configurable), the OME-TIFF recommended format for efficient random access
- ⚡ **Parallel plane reading** -- Planes are read with bounded concurrency
  (configurable) for faster writes from async data sources
- 💾 **BigTIFF support** -- Automatic 64-bit offset format when files exceed
  4 GB, with manual override via `format` option
- 📐 **5D support** -- Handles all dimension orders (XYZCT, XYZTC, etc.) and
  arbitrary combinations of T, C, Z, Y, X axes

## 📦 Installation

```bash
npm install @fideus-labs/fiff
```

For write support, also install the optional peer dependency:

```bash
npm install @fideus-labs/ngff-zarr
```

For worker pool support (offloading compression/decompression to Web Workers):

```bash
npm install @fideus-labs/worker-pool
```

## ⚡ Usage

### Reading: Open an OME-TIFF as a Zarr store

#### From a remote URL

```typescript
import { TiffStore } from "@fideus-labs/fiff";
import * as zarr from "zarrita";

const store = await TiffStore.fromUrl("https://example.com/image.ome.tif");
const group = await zarr.open(store as unknown as zarr.Readable, { kind: "group" });

// Open the full-resolution array (level 0)
const arr = await zarr.open(group.resolve("0"), { kind: "array" });
const chunk = await zarr.get(arr);

console.log(chunk.shape); // e.g. [1, 3, 1, 512, 512]
console.log(chunk.data);  // Float32Array, Uint16Array, etc.
```

#### From an ArrayBuffer

```typescript
const response = await fetch("https://example.com/image.tif");
const buffer = await response.arrayBuffer();
const store = await TiffStore.fromArrayBuffer(buffer);
```

#### From a File / Blob

```typescript
const file = document.querySelector("input[type=file]").files[0];
const store = await TiffStore.fromBlob(file);
```

#### From an existing GeoTIFF instance

```typescript
import { fromUrl } from "geotiff";

const tiff = await fromUrl("https://example.com/image.tif");
const store = await TiffStore.fromGeoTIFF(tiff);
```

#### Accessing store metadata

```typescript
const store = await TiffStore.fromUrl("https://example.com/image.ome.tif");

store.levels;         // number of resolution levels
store.dataType;       // "uint16", "float32", etc.
store.dimensionNames; // ["t", "c", "z", "y", "x"]
store.getShape(0);    // full-res shape, e.g. [1, 3, 1, 2048, 2048]
store.getShape(1);    // level 1 shape, e.g. [1, 3, 1, 1024, 1024]
store.ome;            // parsed OME-XML image metadata (if present)
store.pyramidInfo;    // pyramid structure details
```

### Reading: Load a Multiscales from a TiffStore

`TiffStore` implements the zarrita `Readable` interface, so it can be passed
directly to ngff-zarr's `fromNgffZarr` to obtain a `Multiscales` object:

```typescript
import { TiffStore } from "@fideus-labs/fiff";
import { fromNgffZarr } from "@fideus-labs/ngff-zarr";

const store = await TiffStore.fromUrl("https://example.com/image.ome.tif");
const multiscales = await fromNgffZarr(store, { version: "0.5" });

const image = multiscales.images[0];
console.log(image.dims);        // e.g. ["t", "c", "z", "y", "x"]
console.log(image.data.shape);  // e.g. [1, 3, 1, 512, 512]
console.log(image.data.dtype);  // e.g. "uint16"
console.log(image.scale);       // e.g. { t: 1, c: 1, z: 1, y: 0.5, x: 0.5 }

console.log(multiscales.metadata.axes);     // axis definitions
console.log(multiscales.metadata.datasets); // dataset paths and transforms
```

### Writing: Convert ngff-zarr Multiscales to OME-TIFF

`toOmeTiff()` takes an ngff-zarr `Multiscales` object and returns a complete
OME-TIFF file as an `ArrayBuffer`.

#### Basic write

```typescript
import { toOmeTiff } from "@fideus-labs/fiff";
import {
  createNgffImage,
  createAxis,
  createDataset,
  createMetadata,
  createMultiscales,
} from "@fideus-labs/ngff-zarr";
import * as zarr from "zarrita";

// 1. Create an ngff-zarr image
const image = await createNgffImage(
  [],              // no parent images
  [512, 512],      // shape: [y, x]
  "uint16",        // data type
  ["y", "x"],      // dimension names
  { y: 0.5, x: 0.5 },    // pixel spacing (micrometers)
  { y: 0.0, x: 0.0 },    // origin offsets
  "my-image",
);

// 2. Populate pixel data
const data = new Uint16Array(512 * 512);
for (let i = 0; i < data.length; i++) data[i] = i % 65536;
await zarr.set(image.data, null, {
  data,
  shape: [512, 512],
  stride: [512, 1],
});

// 3. Build the Multiscales object
const axes = [
  createAxis("y", "space", "micrometer"),
  createAxis("x", "space", "micrometer"),
];
const datasets = [createDataset("0", [0.5, 0.5], [0.0, 0.0])];
const metadata = createMetadata(axes, datasets, "my-image");
const multiscales = createMultiscales([image], metadata);

// 4. Write to OME-TIFF
const buffer = await toOmeTiff(multiscales);

// Save to disk (Node.js / Bun)
await Bun.write("output.ome.tif", buffer);
```

#### Write options

```typescript
const buffer = await toOmeTiff(multiscales, {
  compression: "deflate",  // "deflate" (default) or "none"
  compressionLevel: 6,     // 1-9, default 6 (only for deflate)
  dimensionOrder: "XYZCT", // IFD layout order, default "XYZCT"
  imageName: "my-image",   // name in OME-XML metadata
  creator: "my-app",       // creator string in OME-XML
  tileSize: 256,           // tile size in px (0 = strip-based), default 256
  concurrency: 4,          // parallel plane reads, default 4
  format: "auto",          // "auto" | "classic" | "bigtiff", default "auto"
});
```

### Worker Pool: Offloading Compression to Web Workers

By passing a `@fideus-labs/worker-pool` instance, deflate compression (writes)
and decompression (reads) run on Web Workers using the standard
`CompressionStream` / `DecompressionStream` APIs — fully releasing the main
thread.

#### Writing with a worker pool

```typescript
import { toOmeTiff } from "@fideus-labs/fiff";
import WorkerPool from "@fideus-labs/worker-pool";

const pool = new WorkerPool(navigator.hardwareConcurrency ?? 4);

const buffer = await toOmeTiff(multiscales, {
  pool,              // tiles are compressed on workers
  compression: "deflate",
});

pool.terminateWorkers();
```

#### Reading with a worker pool

```typescript
import { TiffStore } from "@fideus-labs/fiff";
import WorkerPool from "@fideus-labs/worker-pool";

const pool = new WorkerPool(4);

// Registers a worker-backed deflate decoder with geotiff.js.
// This is a global registration — it affects all geotiff instances.
const store = await TiffStore.fromUrl(
  "https://example.com/image.ome.tif",
  { pool },
);

// All subsequent chunk reads decompress on workers
const group = await zarr.open(store as unknown as zarr.Readable, { kind: "group" });
const arr = await zarr.open(group.resolve("0"), { kind: "array" });
const chunk = await zarr.get(arr);

pool.terminateWorkers();
```

#### Low-level: buildTiff with a pool

```typescript
import { buildTiff, type WritableIfd } from "@fideus-labs/fiff";
import WorkerPool from "@fideus-labs/worker-pool";

const pool = new WorkerPool(4);
const ifds: WritableIfd[] = [/* ... */];

const buffer = await buildTiff(ifds, {
  compression: "deflate",
  pool,
});

pool.terminateWorkers();
```

#### How it works

- Workers use `CompressionStream("deflate")` / `DecompressionStream("deflate")`
  -- no pako or other dependencies inside the worker
- The worker script is inlined as a blob URL at runtime (no separate file to serve)
- ArrayBuffers are transferred (zero-copy) between the main thread and workers
- When the compression level is not the default (6), or no pool is provided,
  fiff falls back to the existing main-thread path (CompressionStream -> pako)
- The pool's bounded concurrency replaces unbounded `Promise.all` over tiles

#### Multi-resolution pyramids

When the `Multiscales` object contains multiple images (resolution levels),
all sub-resolution levels are written as SubIFDs:

```typescript
const fullRes = await createNgffImage([], [1024, 1024], "uint16", ["y", "x"], ...);
const halfRes = await createNgffImage([], [512, 512], "uint16", ["y", "x"], ...);
// ... populate both images with zarr.set() ...

const datasets = [
  createDataset("0", [0.5, 0.5], [0.0, 0.0]),
  createDataset("1", [1.0, 1.0], [0.0, 0.0]),
];
const metadata = createMetadata(axes, datasets, "pyramid");
const multiscales = createMultiscales([fullRes, halfRes], metadata);

const buffer = await toOmeTiff(multiscales);
// Result: OME-TIFF with full-res IFDs + half-res SubIFDs
```

#### Round-trip: write then read back

```typescript
import { toOmeTiff, TiffStore } from "@fideus-labs/fiff";
import * as zarr from "zarrita";

const buffer = await toOmeTiff(multiscales);
const store = await TiffStore.fromArrayBuffer(buffer);
const group = await zarr.open(store as unknown as zarr.Readable, { kind: "group" });
const arr = await zarr.open(group.resolve("0"), { kind: "array" });
const result = await zarr.get(arr);
// result.data contains the original pixel values
```

## 🏭 Read API

### Factory Methods

| Method                            | Description                                    |
| --------------------------------- | ---------------------------------------------- |
| `TiffStore.fromUrl(url, opts?)`   | Open from a remote URL (HTTP range requests)   |
| `TiffStore.fromArrayBuffer(buf)`  | Open from an in-memory ArrayBuffer             |
| `TiffStore.fromBlob(blob)`        | Open from a Blob or File                       |
| `TiffStore.fromGeoTIFF(tiff)`     | Open from an already-opened GeoTIFF instance   |

### Options

All factory methods accept an optional `TiffStoreOptions` object:

| Option      | Type                     | Default     | Description                                                                  |
| ----------- | ------------------------ | ----------- | ---------------------------------------------------------------------------- |
| `offsets`   | `number[]`               | `undefined` | Pre-computed IFD byte offsets for O(1) access                                |
| `headers`   | `Record<string, string>` | `undefined` | Additional HTTP headers for remote TIFF requests                             |
| `pool`      | `DeflatePool`            | `undefined` | Worker pool for offloading decompression (global geotiff decoder override)   |
| `workerUrl` | `string`                 | `undefined` | Custom worker script URL (only used when `pool` is provided)                 |

### Public Accessors

| Accessor              | Type           | Description                        |
| --------------------- | -------------- | ---------------------------------- |
| `store.levels`        | `number`       | Number of resolution levels        |
| `store.dataType`      | `ZarrDataType` | Zarr data type string              |
| `store.ome`           | `OmeImage[]`   | Parsed OME-XML images (if present) |
| `store.pyramidInfo`   | `PyramidInfo`  | Pyramid structure details          |
| `store.dimensionNames`| `string[]`     | Dimension names (e.g. `["t", "c", "z", "y", "x"]`) |
| `store.getShape(l)`   | `number[]`     | Shape for resolution level `l`     |
| `store.getChunkShape(l)` | `number[]`  | Chunk shape for resolution level `l` |

## 📝 Write API

### `toOmeTiff(multiscales, options?)`

| Parameter     | Type          | Description                                            |
| ------------- | ------------- | ------------------------------------------------------ |
| `multiscales` | `Multiscales` | ngff-zarr Multiscales object with populated pixel data |
| `options`     | `WriteOptions`| Optional writer configuration                          |

**Returns:** `Promise<ArrayBuffer>` -- a complete OME-TIFF file.

### WriteOptions

| Option             | Type                                   | Default     | Description                                                                     |
| ------------------ | -------------------------------------- | ----------- | ------------------------------------------------------------------------------- |
| `compression`      | `"none" \| "deflate"`                  | `"deflate"` | Pixel data compression                                                          |
| `compressionLevel` | `number`                               | `6`         | Deflate level 1-9 (higher = smaller)                                            |
| `dimensionOrder`   | `string`                               | `"XYZCT"`   | IFD plane layout order                                                          |
| `imageName`        | `string`                               | `"image"`   | Image name in OME-XML                                                           |
| `creator`          | `string`                               | `"fiff"`    | Creator string in OME-XML                                                       |
| `tileSize`         | `number`                               | `256`       | Tile size (0 = strip-based, must be x16)                                        |
| `concurrency`      | `number`                               | `4`         | Max parallel plane reads                                                        |
| `format`           | `"auto" \| "classic" \| "bigtiff"`     | `"auto"`    | TIFF format (auto-detects BigTIFF > 4 GB)                                       |
| `pool`             | `DeflatePool`                          | `undefined` | Worker pool for offloading deflate compression to Web Workers                   |
| `workerUrl`        | `string`                               | `undefined` | Custom worker script URL (only used when `pool` is provided)                    |

## 🛠️ Development

### 📋 Prerequisites

- [Bun](https://bun.sh/) >= 1.0

### 🔧 Setup

```bash
git clone https://github.com/fideus-labs/fiff.git
cd fiff
bun install
```

### 🗂️ Project Structure

```
src/
  index.ts           # Public API exports
  tiff-store.ts      # TiffStore class (AsyncReadable implementation)
  metadata.ts        # Zarr v3 / OME-Zarr 0.5 metadata synthesis
  ome-xml.ts         # OME-XML parser (dimensions, channels, DimensionOrder)
  ifd-indexer.ts     # IFD-to-pyramid-level mapping (SubIFD/legacy/COG)
  chunk-reader.ts    # Pixel data reading via geotiff.js readRasters
  dtypes.ts          # TIFF ↔ Zarr data_type mapping
  utils.ts           # Key parsing, pixel window computation, encoding
  write.ts           # High-level toOmeTiff() writer
  tiff-writer.ts     # Low-level TIFF binary builder (IFDs, SubIFDs, deflate)
  ome-xml-writer.ts  # OME-XML generation from Multiscales metadata
  deflate-worker.ts  # Inline Web Worker source for compress/decompress
  worker-utils.ts    # Worker pool task factories and blob URL helper
  worker-decoder.ts  # Worker-backed geotiff deflate decoder
test/
  fixtures.ts        # Test TIFF generation helpers
  *.test.ts          # 201 tests across 11 files
```

### 📝 Commands

| Command              | Description                              |
| -------------------- | ---------------------------------------- |
| `bun run build`      | Build to `dist/` (ESM + declarations)    |
| `bun test`           | Run all tests                            |
| `bun run typecheck`  | Type-check the full project              |

## 🤝 Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for
setup instructions, code style guidelines, and the pull request workflow.

## 📄 License

[MIT](LICENSE.txt) -- Copyright (c) Fideus Labs LLC
