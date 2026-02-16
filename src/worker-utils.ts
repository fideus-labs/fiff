// SPDX-FileCopyrightText: Copyright (c) Fideus Labs LLC
// SPDX-License-Identifier: MIT

/**
 * Worker pool utilities for offloading deflate compression/decompression
 * to Web Workers via `@fideus-labs/worker-pool`.
 *
 * The worker uses the standard CompressionStream / DecompressionStream
 * APIs — no pako or other dependencies in the worker itself.
 */

import { DEFLATE_WORKER_SOURCE } from "./deflate-worker.js";

// ── Types ───────────────────────────────────────────────────────────

/**
 * Minimal subset of `@fideus-labs/worker-pool`'s WorkerPool interface.
 *
 * Accepting this interface (rather than importing the concrete class)
 * keeps worker-pool as an optional peer dependency — consumers bring
 * their own pool instance.
 */
export interface DeflatePool {
  runTasks<T>(
    taskFns: Array<(worker: Worker | null) => Promise<{ worker: Worker; result: T }>>,
    progressCallback?: ((completed: number, total: number) => void) | null,
  ): { promise: Promise<T[]>; runId: number };
}

/** Message sent from main thread to the deflate worker. */
interface WorkerRequest {
  id: number;
  type: "compress" | "decompress";
  buffer: ArrayBuffer;
}

/** Message received from the deflate worker. */
interface WorkerResponse {
  id: number;
  type: "compressed" | "decompressed" | "error";
  buffer?: ArrayBuffer;
  message?: string;
}

// ── Blob URL ────────────────────────────────────────────────────────

let cachedUrl: string | undefined;

/**
 * Get a blob URL for the inline deflate worker.
 * The URL is created once and reused for all subsequent calls.
 */
export function getDeflateWorkerUrl(): string {
  if (cachedUrl === undefined) {
    const blob = new Blob([DEFLATE_WORKER_SOURCE], { type: "application/javascript" });
    cachedUrl = URL.createObjectURL(blob);
  }
  return cachedUrl;
}

// ── Task factories ──────────────────────────────────────────────────

/** Auto-incrementing message ID for request/response correlation. */
let nextId = 1;

/**
 * Create a compression task suitable for `WorkerPool.runTasks()`.
 *
 * The returned function follows the pool's task contract:
 *   (worker | null) => Promise<{ worker, result }>
 *
 * @param data - Uncompressed tile data. The underlying ArrayBuffer is
 *               transferred to the worker (zero-copy).
 * @param workerUrl - Optional custom worker URL. Defaults to the
 *                    built-in blob URL.
 */
export function createCompressTask(
  data: Uint8Array,
  workerUrl?: string,
): (worker: Worker | null) => Promise<{ worker: Worker; result: Uint8Array }> {
  return (worker: Worker | null) => {
    const w = worker ?? new Worker(workerUrl ?? getDeflateWorkerUrl(), { type: "module" });
    const id = nextId++;

    return new Promise<{ worker: Worker; result: Uint8Array }>((resolve, reject) => {
      const handler = (e: MessageEvent<WorkerResponse>) => {
        if (e.data.id !== id) return;
        w.removeEventListener("message", handler);
        w.removeEventListener("error", errHandler);

        if (e.data.type === "error") {
          reject(new Error(e.data.message ?? "Worker compression failed"));
        } else {
          resolve({ worker: w, result: new Uint8Array(e.data.buffer!) });
        }
      };
      const errHandler = (e: ErrorEvent) => {
        w.removeEventListener("message", handler);
        w.removeEventListener("error", errHandler);
        reject(new Error(e.message ?? "Worker error"));
      };

      w.addEventListener("message", handler);
      w.addEventListener("error", errHandler);

      // Prepare a transferable buffer.
      // If the data's buffer is shared or has a non-zero byteOffset, copy
      // it into an owned ArrayBuffer to enable transfer.
      let transferBuffer: ArrayBuffer;
      if (
        data.byteOffset === 0 &&
        data.byteLength === data.buffer.byteLength &&
        !(data.buffer instanceof SharedArrayBuffer)
      ) {
        transferBuffer = data.buffer as ArrayBuffer;
      } else {
        transferBuffer = data.slice().buffer as ArrayBuffer;
      }

      const msg: WorkerRequest = { id, type: "compress", buffer: transferBuffer };
      w.postMessage(msg, [transferBuffer]);
    });
  };
}

/**
 * Create a decompression task suitable for `WorkerPool.runTasks()`.
 *
 * @param compressed - Compressed (deflate/zlib) data. The underlying
 *                     ArrayBuffer is transferred to the worker.
 * @param workerUrl - Optional custom worker URL.
 */
export function createDecompressTask(
  compressed: ArrayBuffer,
  workerUrl?: string,
): (worker: Worker | null) => Promise<{ worker: Worker; result: ArrayBuffer }> {
  return (worker: Worker | null) => {
    const w = worker ?? new Worker(workerUrl ?? getDeflateWorkerUrl(), { type: "module" });
    const id = nextId++;

    return new Promise<{ worker: Worker; result: ArrayBuffer }>((resolve, reject) => {
      const handler = (e: MessageEvent<WorkerResponse>) => {
        if (e.data.id !== id) return;
        w.removeEventListener("message", handler);
        w.removeEventListener("error", errHandler);

        if (e.data.type === "error") {
          reject(new Error(e.data.message ?? "Worker decompression failed"));
        } else {
          resolve({ worker: w, result: e.data.buffer! });
        }
      };
      const errHandler = (e: ErrorEvent) => {
        w.removeEventListener("message", handler);
        w.removeEventListener("error", errHandler);
        reject(new Error(e.message ?? "Worker error"));
      };

      w.addEventListener("message", handler);
      w.addEventListener("error", errHandler);

      const msg: WorkerRequest = { id, type: "decompress", buffer: compressed };
      w.postMessage(msg, [compressed]);
    });
  };
}

/**
 * Compress an array of tiles in parallel using a worker pool.
 *
 * Returns compressed tiles in the same order as the input.
 */
export async function compressTilesOnPool(
  tiles: Uint8Array[],
  pool: DeflatePool,
  workerUrl?: string,
): Promise<Uint8Array[]> {
  if (tiles.length === 0) return [];

  const tasks = tiles.map((tile) => createCompressTask(tile, workerUrl));
  const { promise } = pool.runTasks(tasks);
  return promise;
}

/**
 * Decompress a single buffer using a worker pool.
 *
 * Wraps the buffer in a single-element runTasks call.
 * For batch decompression, callers should build task arrays directly.
 */
export async function decompressOnPool(
  compressed: ArrayBuffer,
  pool: DeflatePool,
  workerUrl?: string,
): Promise<ArrayBuffer> {
  const tasks = [createDecompressTask(compressed, workerUrl)];
  const { promise } = pool.runTasks(tasks);
  const [result] = await promise;
  return result;
}
