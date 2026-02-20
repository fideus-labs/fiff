<!-- SPDX-FileCopyrightText: Copyright (c) Fideus Labs LLC -->
<!-- SPDX-License-Identifier: MIT -->
# AGENTS.md

This document provides coding guidelines and commands for AI coding agents working in the `fiff` repository.

## Project Overview

`fiff` is a TypeScript library that presents TIFF files as zarrita.js Zarr stores following the OME-Zarr (NGFF v0.5) data model. It's designed for bioimaging and geospatial applications, providing efficient access to multi-dimensional image data.

## Commands

### Build & Lint
```bash
bun run build          # Build to dist/ (ESM + declarations)
bun run typecheck      # Type-check the entire project (strict mode)
```

### Testing
```bash
bun test                                    # Run all tests
bun test test/dtypes.test.ts                # Run a single test file
bun test -t "parses OME-XML"                # Run tests matching pattern
bun test --only                             # Run only tests marked test.only()
bun test --bail                             # Stop after first failure
bun test --coverage                         # Generate coverage report
```

**Note:** The test suite includes 120+ tests across 8 test files covering dtype mapping, OME-XML parsing, key parsing, metadata synthesis, IFD indexing, chunk reading, TiffStore lifecycle, and zarrita.js integration.

## Code Style Guidelines

### TypeScript Configuration
- **Strict mode enabled**: All TypeScript strict checks are enforced
- **Target**: ES2022 with ES2022 module system
- **Module resolution**: bundler
- Use explicit `.js` extensions on all relative imports (ESM requirement)

### Imports

**Separate type imports from value imports:**
```typescript
import { fromUrl } from "geotiff"
import type GeoTIFF from "geotiff"
import type { GeoTIFFImage } from "geotiff"
```

**Import ordering (separated by blank lines):**
1. External/third-party packages (value imports first, then type imports)
2. Internal relative imports (value imports first, then type imports)

**Always use explicit `.js` extensions for relative imports:**
```typescript
import { tiffDtypeToZarr } from "./dtypes.js"
import type { ZarrDataType } from "./dtypes.js"
import { readChunk } from "./chunk-reader.js"
```

### Exports

**Use named exports only** — no default exports anywhere in the codebase.

The barrel file `src/index.ts` re-exports from all modules. Use `export type` for type-only re-exports:

```typescript
export { TiffStore, type TiffStoreOptions } from "./tiff-store.js"
export type { PyramidInfo, PlaneSelection } from "./ifd-indexer.js"
export { parseStoreKey, computePixelWindow } from "./utils.js"
```

### Naming Conventions

| Kind                   | Style           | Example                          |
|------------------------|-----------------|----------------------------------|
| Variables, parameters  | camelCase       | `chunkWidth`, `levelIndex`       |
| Functions              | camelCase       | `parseStoreKey`, `readChunk`     |
| Classes                | PascalCase      | `TiffStore`, `WorkerDecoder`     |
| Interfaces, types      | PascalCase      | `PyramidInfo`, `ZarrDataType`    |
| Module-level constants | SCREAMING_SNAKE | `ZARR_FORMAT`, `DEFAULT_TILE_SIZE` |
| Private class members  | camelCase       | `rootJsonBytes`, `arrayJsonCache` |
| File names             | kebab-case      | `tiff-store.ts`, `ome-xml.ts`    |

### Types & Interfaces

**Prefer interfaces for object shapes:**
```typescript
export interface TiffStoreOptions {
  offsets?: number[]
  headers?: Record<string, string>
  pool?: DeflatePool
}
```

**Use type aliases for unions and primitives:**
```typescript
export type ZarrDataType = "int8" | "int16" | "int32" | "uint8" | "uint16" | "uint32" | "float32" | "float64"
export type DimensionOrder = "XYZCT" | "XYZTC" | "XYCTZ" | "XYCZT" | "XYTCZ" | "XYTZC"
```

### Documentation

**All exported functions, classes, and interfaces must have JSDoc comments:**

```typescript
/**
 * Parse a zarr store key into its components.
 *
 * Expected key patterns (Zarr v3 with "/" separator):
 *   "zarr.json"                -> root group metadata
 *   "0/zarr.json"              -> level 0 array metadata
 *   "0/c/0/0/3/5"             -> level 0, chunk at indices [0, 0, 3, 5]
 *
 * @param key - The store key (may or may not have a leading "/").
 * @returns Parsed key information.
 */
export function parseStoreKey(key: string): ParsedKey {
  // implementation
}
```

Include `@param`, `@returns`, and `@throws` tags as applicable.

### Error Handling

**Throw descriptive errors with context:**
```typescript
if (sampleFormat === SAMPLE_FORMAT_UINT) {
  switch (bitsPerSample) {
    case 8: return "uint8"
    case 16: return "uint16"
    default:
      throw new Error(`Unsupported unsigned integer bit depth: ${bitsPerSample}`)
  }
}
```

**Use early returns for validation:**
```typescript
export function isOmeXml(description: string): boolean {
  if (!description) return false
  const trimmed = description.trim()
  return trimmed.startsWith("<?xml") || trimmed.startsWith("<OME")
}
```

### Code Formatting

- Use 2 spaces for indentation (no tabs)
- Use semicolons for statement terminators
- Use double quotes for strings
- Prefer `const` over `let`; avoid `var`
- Use arrow functions for callbacks and short functions
- Use template literals for string interpolation

### Testing Style

**Use Bun's built-in test framework:**
```typescript
import { describe, it, expect } from "bun:test"

describe("TiffStore", () => {
  it("opens a simple uint8 TIFF", async () => {
    const buffer = createSimpleTiff()
    const store = await TiffStore.fromArrayBuffer(buffer)
    
    expect(store.levels).toBe(1)
    expect(store.dataType).toBe("uint8")
    expect(store.dimensionNames).toEqual(["y", "x"])
  })
})
```

**Test fixtures:** Use `test/fixtures.ts` for shared test data generation helpers.

## File Headers

All source files must include SPDX license headers:
```typescript
// SPDX-FileCopyrightText: Copyright (c) Fideus Labs LLC
// SPDX-License-Identifier: MIT
```

## Project Structure

```
src/
  index.ts          # Public API barrel exports
  tiff-store.ts     # TiffStore class (AsyncReadable implementation)
  metadata.ts       # Zarr v3 / OME-Zarr 0.5 metadata synthesis
  ome-xml.ts        # OME-XML parser (dimensions, channels, DimensionOrder)
  ome-xml-writer.ts # OME-XML generation for TIFF writing
  ifd-indexer.ts    # IFD-to-pyramid-level mapping (SubIFD/legacy/COG)
  chunk-reader.ts   # Pixel data reading via geotiff.js
  dtypes.ts         # TIFF SampleFormat -> Zarr data_type mapping
  utils.ts          # Key parsing, pixel window computation
  tiff-writer.ts    # TIFF file writing utilities
  write.ts          # High-level OME-TIFF writing API
  worker-*.ts       # Web Worker integration for deflate decompression

test/
  fixtures.ts       # Test TIFF generation helpers
  *.test.ts         # Test files (mirror src/ structure)
```

## Commit Message Format

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <description>

[optional body]
```

**Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`

**Examples:**
- `feat: add support for BigTIFF files`
- `fix: correct edge-chunk padding for non-square tiles`
- `docs: update quick start example in README`
- `test: add integration tests for zarrita.js compatibility`

## Additional Notes

- This is an ESM-only package (no CommonJS support)
- Runtime: Bun >= 1.0 (for development/testing); outputs standard ES2022 JavaScript
- Peer dependencies (@fideus-labs/ngff-zarr, @fideus-labs/worker-pool) are optional
- The package uses geotiff.js for low-level TIFF reading and zarrita.js for Zarr compatibility
