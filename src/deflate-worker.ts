// SPDX-FileCopyrightText: Copyright (c) Fideus Labs LLC
// SPDX-License-Identifier: MIT

/**
 * Inline Web Worker source for deflate compression and decompression.
 *
 * Uses the standard CompressionStream / DecompressionStream APIs
 * (available in modern browsers and Web Workers). Zero runtime
 * dependencies — only platform APIs.
 *
 * Message protocol:
 *   compress:   { id, type: 'compress',   buffer: ArrayBuffer }
 *            -> { id, type: 'compressed', buffer: ArrayBuffer }
 *
 *   decompress: { id, type: 'decompress', buffer: ArrayBuffer }
 *            -> { id, type: 'decompressed', buffer: ArrayBuffer }
 *
 *   error:   -> { id, type: 'error', message: string }
 *
 * All ArrayBuffers are transferred (zero-copy).
 */

/**
 * The worker source code as a string. This is inlined into a Blob URL
 * at runtime so consumers don't need to serve a separate worker file.
 */
export const DEFLATE_WORKER_SOURCE = /* js */ `
'use strict';

async function streamTransform(input, transform) {
  const writer = transform.writable.getWriter();
  const reader = transform.readable.getReader();

  writer.write(input);
  writer.close();

  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(new Uint8Array(chunk.buffer || chunk), offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}

self.addEventListener('message', async (e) => {
  const { id, type, buffer } = e.data;
  try {
    if (type === 'compress') {
      const result = await streamTransform(
        new Uint8Array(buffer),
        new CompressionStream('deflate'),
      );
      self.postMessage({ id, type: 'compressed', buffer: result }, [result]);
    } else if (type === 'decompress') {
      const result = await streamTransform(
        new Uint8Array(buffer),
        new DecompressionStream('deflate'),
      );
      self.postMessage({ id, type: 'decompressed', buffer: result }, [result]);
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err.message || String(err) });
  }
});
`;
