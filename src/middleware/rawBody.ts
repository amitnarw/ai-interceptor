/**
 * rawBody — Request body capture middleware
 *
 * Ported from Go middleware/logging.go pattern:
 * - Read the raw request body BEFORE any handler reads it
 * - Store raw bytes so they can be read multiple times
 * - Restore req.body by re-parsing the raw JSON
 *
 * This pattern mirrors the Go code:
 *   bodyBytes, _ := io.ReadAll(r.Body)
 *   r.Body = io.NopCloser(bytes.NewReader(bodyBytes))
 *   ctx := context.WithValue(r.Context(), model.BodyBytesKey, bodyBytes)
 *
 * NOTE: This middleware is kept for documentation. The actual body capture
 * is done via express.json({ verify: ... }) in server.ts, which intercepts
 * the raw buffer before JSON parsing.
 */

import { Request, Response, NextFunction } from 'express';

// Extend Express Request to include rawBody
declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

// Unused but kept for future use if direct middleware approach is preferred
export function rawBody(_req: Request, _res: Response, next: NextFunction): void {
  next();
}

/**
 * JSON body parser verify callback with raw body capture.
 * Use in server.ts:
 *   express.json({ limit: '10mb', verify: captureRawBody })
 */
export function captureRawBody(req: Request, _res: Response, buf: Buffer): void {
  req.rawBody = buf;
}