/**
 * Stream decompressors for HTTP responses.
 *
 * Ported from Go codebase (seifghazi/claude-code-proxy) in proxy/internal/service/anthropic.go:
 * - Check Content-Encoding header for "gzip"
 * - Decompress BEFORE SSE parsing to avoid garbled bytes
 *
 * Uses Node.js built-in zlib (no external dependencies needed).
 */

import { createGunzip } from 'zlib';
import { Readable } from 'stream';

/**
 * If the response stream is gzip-encoded, wrap it with a gunzip decompressor.
 * Otherwise return the original stream unchanged.
 *
 * Ported from Go's decompressGzipResponse():
 *   if strings.Contains(resp.Header.Get("Content-Encoding"), "gzip") {
 *       decompressedResp, err := s.decompressGzipResponse(resp)
 *   }
 */
export function maybeDecompress(
  stream: Readable,
  contentEncoding: string | undefined
): Readable {
  if (!contentEncoding || !contentEncoding.includes('gzip')) {
    return stream;
  }

  // Create a gzip decompressor — feeds go through the gunzip Transform stream
  const gunzip = createGunzip();

  // When the gunzip stream ends, the original stream is fully consumed
  stream.on('error', (err) => {
    gunzip.destroy(err);
  });

  gunzip.on('error', (err) => {
    stream.destroy(err);
  });

  // Pipe: response → gunzip → consumer
  stream.pipe(gunzip);

  return gunzip as unknown as Readable;
}