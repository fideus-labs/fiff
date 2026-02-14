<!-- SPDX-FileCopyrightText: Copyright (c) Fideus Labs LLC -->
<!-- SPDX-License-Identifier: MIT -->
# 🤝 Contributing to fiff

Welcome! 👋 We're glad you're interested in contributing to fiff. Whether
you're fixing bugs, adding features, improving documentation, or helping with
testing, your contributions are greatly appreciated. 🎉

## 🚀 Getting Started

### Prerequisites

- [Bun](https://bun.sh/) >= 1.0

### ⚙️ Setup

1. Fork and clone the repository
2. Install dependencies:
   ```bash
   bun install
   ```

## 🔄 Contributing Workflow

We use the standard GitHub pull request workflow:

1. 💬 **Open an Issue First** - For significant changes, open a GitHub Issue to
   discuss your proposal before starting work
2. 🍴 **Fork the Repository** - Create your own fork
3. 🌿 **Create a Branch** - Create a feature branch from `main`
4. ✏️ **Make Changes** - Implement your changes with tests
5. 💾 **Commit** - Use Conventional Commit messages
6. 📤 **Push** - Push to your fork
7. 📬 **Open a Pull Request** - Submit a PR against `main`

### 📋 Pull Request Guidelines

- ✅ **CI must pass** - All checks must be green before merge
- 💬 **Be responsive** - Please respond to review comments in a timely manner
- ⏳ **Be patient** - Reviews may take time; we appreciate your patience

## 📝 Commit Messages

We follow the [Conventional Commits](https://www.conventionalcommits.org/)
standard.

### 📐 Format

```
<type>: <description>

[optional body]

[optional footer]
```

### 🏷️ Types

- ✨ `feat` - New feature
- 🐛 `fix` - Bug fix
- 📖 `docs` - Documentation changes
- 🎨 `style` - Code style changes (formatting, etc.)
- ♻️ `refactor` - Code refactoring
- ⚡ `perf` - Performance improvements
- 🧪 `test` - Adding or updating tests
- 🏗️ `build` - Build system changes
- 🔧 `ci` - CI/CD changes
- 🧹 `chore` - Maintenance tasks

### 💡 Examples

```bash
feat: add support for BigTIFF files
fix: correct edge-chunk padding for non-square tiles
docs: update quick start example
chore: update geotiff.js dependency
```

## 🗂️ Project Structure

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

## 🛠️ Development Commands

| Command              | Description                              |
| -------------------- | ---------------------------------------- |
| `bun run build`      | Build to `dist/` (ESM + declarations)    |
| `bun test`           | Run all tests                            |
| `bun run typecheck`  | Type-check the full project              |

## 🎨 Code Style

TypeScript strict mode is enforced. The codebase uses ESM with explicit `.js`
extensions on all relative imports.

### 📦 Imports

Separate `import type` from value imports, even when importing from the same
module:

```typescript
import { fromUrl } from "geotiff"
import type GeoTIFF from "geotiff"
```

Group imports in order, separated by blank lines:
1. External / third-party packages
2. Internal relative imports

Relative imports must use explicit `.js` extensions (required for ESM):

```typescript
import { tiffDtypeToZarr } from "./dtypes.js"
import type { ZarrDataType } from "./dtypes.js"
```

### 📤 Exports

Use **named exports only** -- no default exports anywhere. The barrel file
`index.ts` re-exports from all modules. Use `export type` for type-only
re-exports:

```typescript
export { TiffStore } from "./tiff-store.js"
export type { PyramidInfo, PlaneSelection } from "./ifd-indexer.js"
```

### 🏷️ Naming Conventions

| Kind                  | Style              | Example                      |
|-----------------------|--------------------|------------------------------|
| Variables, parameters | camelCase          | `chunkWidth`, `levelIndex`   |
| Functions             | camelCase          | `parseStoreKey`              |
| Classes               | PascalCase         | `TiffStore`                  |
| Interfaces, types     | PascalCase         | `PyramidInfo`, `ZarrDataType`|
| Module-level constants| SCREAMING_SNAKE    | `ZARR_FORMAT`                |
| Private members       | camelCase          | `rootJsonBytes`, `arrayJsonCache` |

**File names**: lowercase with hyphens (`tiff-store.ts`, `ome-xml.ts`,
`chunk-reader.ts`).

### 📖 Documentation

All exported functions, classes, and interfaces should have JSDoc with
`@param`, `@returns`, and `@throws` tags as applicable.

## 🧪 Testing

Tests use Bun's built-in test runner. The test suite covers dtype mapping,
OME-XML parsing, key parsing, metadata synthesis, IFD indexing, chunk reading,
TiffStore lifecycle, and zarrita.js + ngff-zarr integration.

```bash
bun test                              # All tests
bun test test/dtypes.test.ts          # Single test file
bun test --grep "parses OME-XML"      # Single test by name
```

Run tests before submitting PRs to ensure nothing is broken. ✅

## ❓ Questions?

If you have questions, please open a
[GitHub Issue](https://github.com/fideus-labs/fiff/issues).

Thank you for contributing! 💖
