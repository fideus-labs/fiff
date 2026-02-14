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
  Present <a href="https://docs.openmicroscopy.org/ome-model/latest/ome-tiff/">TIFF</a> and <a href="https://docs.openmicroscopy.org/ome-model/latest/ome-tiff/">OME-TIFF</a> files as a <a href="https://github.com/manzt/zarrita.js">zarrita.js</a> Zarr store following the <a href="https://ngff.openmicroscopy.org/0.5/">OME-Zarr v0.5</a> data model.
</p>

## ✨ Features

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

## 📦 Installation

```bash
npm install @fideus-labs/fiff
```

## ⚡ Quick Start

### From a remote URL

```typescript
import { TiffStore } from "@fideus-labs/fiff"
import * as zarr from "zarrita"

const store = await TiffStore.fromUrl("https://example.com/image.ome.tif")
const group = await zarr.open(store as unknown as zarr.Readable, { kind: "group" })
const arr = await zarr.open(group.resolve("0"), { kind: "array" })
const chunk = await zarr.get(arr)
```

### From an ArrayBuffer

```typescript
const response = await fetch("https://example.com/image.tif")
const buffer = await response.arrayBuffer()
const store = await TiffStore.fromArrayBuffer(buffer)
```

### From a File / Blob

```typescript
const file = document.querySelector("input[type=file]").files[0]
const store = await TiffStore.fromBlob(file)
```

### From an existing GeoTIFF instance

```typescript
import { fromUrl } from "geotiff"

const tiff = await fromUrl("https://example.com/image.tif")
const store = await TiffStore.fromGeoTIFF(tiff)
```

## 🏭 Factory Methods

| Method                            | Description                                    |
| --------------------------------- | ---------------------------------------------- |
| `TiffStore.fromUrl(url, opts?)`   | Open from a remote URL (HTTP range requests)   |
| `TiffStore.fromArrayBuffer(buf)`  | Open from an in-memory ArrayBuffer             |
| `TiffStore.fromBlob(blob)`        | Open from a Blob or File                       |
| `TiffStore.fromGeoTIFF(tiff)`     | Open from an already-opened GeoTIFF instance   |

## ⚙️ Options

All factory methods accept an optional `TiffStoreOptions` object:

| Option    | Type                     | Default     | Description                                     |
| --------- | ------------------------ | ----------- | ----------------------------------------------- |
| `offsets` | `number[]`               | `undefined` | Pre-computed IFD byte offsets for O(1) access   |
| `headers` | `Record<string, string>` | `undefined` | Additional HTTP headers for remote TIFF requests |

## 📖 Public Accessors

| Accessor              | Type           | Description                        |
| --------------------- | -------------- | ---------------------------------- |
| `store.levels`        | `number`       | Number of resolution levels        |
| `store.dataType`      | `ZarrDataType` | Zarr data type string              |
| `store.ome`           | `OmeImage[]`   | Parsed OME-XML images (if present) |
| `store.pyramidInfo`   | `PyramidInfo`  | Pyramid structure details          |
| `store.dimensionNames`| `string[]`     | Dimension names (e.g. `["t", "c", "z", "y", "x"]`) |
| `store.getShape(l)`   | `number[]`     | Shape for resolution level `l`     |
| `store.getChunkShape(l)` | `number[]`  | Chunk shape for resolution level `l` |

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
  index.ts          # Public API exports
  tiff-store.ts     # TiffStore class (AsyncReadable implementation)
  metadata.ts       # Zarr v3 / OME-Zarr 0.5 metadata synthesis
  ome-xml.ts        # OME-XML parser (dimensions, channels, DimensionOrder)
  ifd-indexer.ts    # IFD-to-pyramid-level mapping (SubIFD/legacy/COG)
  chunk-reader.ts   # Pixel data reading via geotiff.js readRasters
  dtypes.ts         # TIFF SampleFormat -> Zarr data_type mapping
  utils.ts          # Key parsing, pixel window computation, encoding
test/
  fixtures.ts       # Test TIFF generation helpers
  *.test.ts         # 120 tests across 8 files
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
