// SPDX-FileCopyrightText: Copyright (c) Fideus Labs LLC
// SPDX-License-Identifier: MIT

/**
 * Worker-backed deflate decoder for geotiff.js.
 *
 * Replaces geotiff's built-in pako-based DeflateDecoder with one that
 * offloads decompression to Web Workers via a `DeflatePool`.
 *
 * Uses the standard DecompressionStream API in workers — no pako needed.
 *
 * Register with:
 *   import { addDecoder } from "geotiff";
 *   registerWorkerDecoder(pool);
 */

import { BaseDecoder, addDecoder } from "geotiff";
import { decompressOnPool, type DeflatePool } from "./worker-utils.js";

/**
 * Module-level flag to avoid redundant registrations.
 * The geotiff decoder registry is global — registering once is sufficient.
 */
let registered = false;

/**
 * The pool instance used by the decoder. Set by `registerWorkerDecoder()`.
 */
let activePool: DeflatePool | undefined;

/**
 * Optional custom worker URL. Set by `registerWorkerDecoder()`.
 */
let activeWorkerUrl: string | undefined;

/**
 * A geotiff BaseDecoder subclass that decompresses deflate data on a
 * worker pool using the standard DecompressionStream API.
 *
 * Not intended to be instantiated directly — use `registerWorkerDecoder()`.
 */
export class WorkerDeflateDecoder extends BaseDecoder {
  async decodeBlock(buffer: ArrayBuffer): Promise<ArrayBuffer> {
    if (!activePool) {
      throw new Error(
        "WorkerDeflateDecoder: no pool registered. Call registerWorkerDecoder() first.",
      );
    }
    return decompressOnPool(buffer, activePool, activeWorkerUrl);
  }
}

/**
 * Register the worker-backed deflate decoder with geotiff.
 *
 * This replaces the default pako-based decoder for TIFF compression
 * codes 8 (Deflate) and 32946 (old Deflate). The registration is
 * **global** — it affects all geotiff instances in the current context.
 *
 * Calling this multiple times updates the pool reference but only
 * registers with geotiff once.
 *
 * @param pool - The worker pool to use for decompression.
 * @param workerUrl - Optional custom worker script URL.
 */
export function registerWorkerDecoder(
  pool: DeflatePool,
  workerUrl?: string,
): void {
  activePool = pool;
  activeWorkerUrl = workerUrl;

  if (!registered) {
    // Compression code 8 = Deflate, 32946 = old Deflate alias
    addDecoder(
      [8, 32946],
      () => Promise.resolve(WorkerDeflateDecoder),
    );
    registered = true;
  }
}

/**
 * Unregister the worker decoder by clearing the active pool.
 * Subsequent decode attempts will throw until a new pool is registered.
 *
 * Note: this does NOT restore geotiff's original pako decoder.
 * To fully restore the default, reload the module.
 */
export function unregisterWorkerDecoder(): void {
  activePool = undefined;
  activeWorkerUrl = undefined;
}
