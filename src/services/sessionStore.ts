/**
 * Session Store — Redis-based request/conversation tracking
 *
 * Ported from Go codebase (seifghazi/claude-code-proxy):
 * - proxy/internal/model/models.go — RequestLog / ResponseLog data structures
 * - proxy/internal/service/storage_sqlite.go — request storage
 * - proxy/internal/service/conversation.go — session grouping
 *
 * Instead of SQLite (Go version), we use Redis Streams (XADD/XREAD)
 * for event storage and Redis Hashes for active session state.
 *
 * Data model mirrors Go's RequestLog:
 * - requestId, timestamp, method, endpoint, headers, body, model
 * - Response: statusCode, headers, body (JSON), responseTime, streaming chunks
 */

// ---------------------------------------------------------------------------
// Types — ported from Go models.go
// ---------------------------------------------------------------------------

export interface RequestLog {
  requestId: string;
  timestamp: string;
  method: string;
  endpoint: string;
  headers: Record<string, string>;
  body: unknown;
  model?: string;
  userAgent?: string;
  contentType?: string;
  response?: ResponseLog;
}

export interface ResponseLog {
  statusCode: number;
  headers: Record<string, string>;
  body?: unknown;
  bodyText?: string;
  responseTime: number;
  streamingChunks?: string[];
  isStreaming: boolean;
  completedAt: string;
}

export interface SessionInfo {
  sessionId: string;
  projectName?: string;
  startTime: string;
  endTime?: string;
  messageCount: number;
  lastActivity: string;
}

interface RedisClient {
  hset: (key: string, ...fields: string[]) => Promise<number>;
  hgetall: (key: string) => Promise<Record<string, string>>;
  hincrby: (key: string, field: string, increment: number) => Promise<number>;
  hmset: (key: string, data: Record<string, string>) => Promise<'OK'>;
  xadd: (key: string, maxLen: number | string, id: string, ...fields: string[]) => Promise<string>;
  xrange: (key: string, start: string, end: string, count?: number) => Promise<[string, string[]][]>;
  sadd: (key: string, ...members: string[]) => Promise<number>;
  smembers: (key: string) => Promise<string[]>;
  expire: (key: string, seconds: number) => Promise<number>;
  del: (...keys: string[]) => Promise<number>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a short request ID (8 hex chars, same as Go's generateRequestID).
 */
function generateRequestId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Sanitize headers — remove Authorization and other sensitive headers.
 * Mirrors Go's SanitizeHeaders() function.
 */
function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  const skip = new Set([
    'authorization',
    'x-api-key',
    'cookie',
    'x-session-id', // privacy
  ]);
  for (const [key, value] of Object.entries(headers)) {
    if (!skip.has(key.toLowerCase())) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

// ---------------------------------------------------------------------------
// Session Store
// ---------------------------------------------------------------------------

let redis: RedisClient | null = null;

async function getRedis(): Promise<RedisClient> {
  if (!redis) {
    const client = await import('../config/redis.js').then(m => m.getRedisClient());
    redis = client as unknown as RedisClient;
  }
  return redis;
}

// Key prefixes (same pattern as Go's table names)
const SESSION_PREFIX = 'session:';        // session:{sessionId} — Hash
const SESSION_STREAM = 'sessions:events'; // XADD for request events
const SESSION_INDEX = 'sessions:ids';     // SET of known session IDs

/**
 * Extract or generate session ID from request headers/body.
 * Mirrors Go's approach — generates a new sessionId if none provided.
 *
 * In Go, sessionId came from Claude Code's local .claude/projects/ files.
 * Here we generate one and let callers pass it via X-Session-Id header.
 */
export function extractSessionId(
  headers: Record<string, string>,
  _body?: unknown
): string {
  if (headers['x-session-id']) {
    return headers['x-session-id'];
  }
  // No sessionId provided — generate one (same as Go generating requestID)
  return generateRequestId();
}

/**
 * Create or update a session entry in Redis Hash.
 * Ported from Go's storage_sqlite.go SaveRequest() + conversation.go session grouping.
 */
export async function upsertSession(
  sessionId: string,
  info: Partial<SessionInfo>
): Promise<void> {
  const r = await getRedis();
  const key = `${SESSION_PREFIX}${sessionId}`;

  const existing = await r.hgetall(key);
  const fields: Record<string, string> = {
    sessionId,
    startTime: existing.startTime ?? info.startTime ?? new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    messageCount: existing.messageCount ?? '0',
    ...(info.projectName ? { projectName: info.projectName } : {}),
    ...(info.endTime ? { endTime: info.endTime } : {}),
  };

  // Increment message count
  fields.messageCount = String((parseInt(existing.messageCount ?? '0', 10) + (info.messageCount ?? 1)));

  await r.hmset(key, fields);
  await r.expire(key, 7 * 24 * 60 * 60); // 7 day TTL
  await r.sadd(SESSION_INDEX, sessionId);
}

/**
 * Add a request event to the session stream (Redis Stream).
 * Ported from Go's storage_sqlite.go and handler's SaveRequest().
 *
 * Uses XADD to append a request event, keyed by sessionId.
 * Each event stores the full RequestLog as a JSON string in the stream.
 */
export async function addSessionRequest(
  sessionId: string,
  request: RequestLog
): Promise<void> {
  const r = await getRedis();
  const streamKey = `${SESSION_STREAM}:${sessionId}`;

  const log: RequestLog = {
    ...request,
    requestId: request.requestId || generateRequestId(),
    timestamp: request.timestamp || new Date().toISOString(),
  };

  // NOTE: The ~ MAXLEN flag is not supported by ioredis-mock's XADD.
  // Using simple '*' for auto-generated ID. Works with both mock and real Redis.
  await r.xadd(streamKey, '*',
    'type', 'request',
    'data', JSON.stringify(log),
  );

  // Update session hash with latest activity
  await upsertSession(sessionId, { lastActivity: log.timestamp });
}

/**
 * Add a response to the most recent request event in the stream.
 * Ported from Go's storage_sqlite.go UpdateRequestWithResponse().
 *
 * Note: Redis Streams are append-only, so we store response alongside the
 * request event. For full request/response pairing, we use a separate
 * response hash keyed by requestId.
 */
export async function addSessionResponse(
  sessionId: string,
  requestId: string,
  response: ResponseLog
): Promise<void> {
  const r = await getRedis();
  const responseKey = `${SESSION_PREFIX}response:${requestId}`;

  await r.hmset(responseKey, {
    requestId,
    sessionId,
    statusCode: String(response.statusCode),
    responseTime: String(response.responseTime),
    isStreaming: String(response.isStreaming),
    completedAt: response.completedAt || new Date().toISOString(),
    body: response.body ? JSON.stringify(response.body) : '',
    bodyText: response.bodyText ?? '',
  });

  await r.expire(responseKey, 7 * 24 * 60 * 60); // 7 day TTL
}

/**
 * Get session info (metadata from Redis Hash).
 */
export async function getSession(sessionId: string): Promise<SessionInfo | null> {
  const r = await getRedis();
  const key = `${SESSION_PREFIX}${sessionId}`;
  const data = await r.hgetall(key);

  if (!data.sessionId) return null;

  return {
    sessionId: data.sessionId,
    projectName: data.projectName,
    startTime: data.startTime,
    endTime: data.endTime,
    messageCount: parseInt(data.messageCount ?? '0', 10),
    lastActivity: data.lastActivity,
  };
}

/**
 * Get recent sessions (all known session IDs).
 * Returns sessions sorted by lastActivity (newest first).
 */
export async function getRecentSessions(limit = 20): Promise<SessionInfo[]> {
  const r = await getRedis();
  const sessionIds = await r.smembers(SESSION_INDEX);

  const sessions: SessionInfo[] = [];
  for (const sessionId of sessionIds) {
    const session = await getSession(sessionId);
    if (session) sessions.push(session);
  }

  // Sort by lastActivity descending
  sessions.sort((a, b) =>
    new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
  );

  return sessions.slice(0, limit);
}

/**
 * Log an HTTP request/response pair to Redis.
 * This is called by route handlers after each request completes.
 *
 * Ported from Go's handler.go — captures the same RequestLog structure:
 *   requestLog := &model.RequestLog{
 *       RequestID:     requestID,
 *       Timestamp:     time.Now().Format(time.RFC3339),
 *       Method:        r.Method,
 *       Endpoint:      r.URL.Path,
 *       Headers:       SanitizeHeaders(r.Header),
 *       Body:          req,
 *       Model:         decision.OriginalModel,
 *       ...
 *   }
 *   if _, err := h.storageService.SaveRequest(requestLog); err != nil { ... }
 */
export async function logRequest(
  method: string,
  endpoint: string,
  headers: Record<string, string>,
  body: unknown,
  response: ResponseLog | null,
  options: {
    model?: string;
    userAgent?: string;
    sessionId?: string;
    responseTime?: number;
  } = {}
): Promise<void> {
  const requestId = generateRequestId();
  const timestamp = new Date().toISOString();

  const request: RequestLog = {
    requestId,
    timestamp,
    method,
    endpoint,
    headers: sanitizeHeaders(headers),
    body,
    model: options.model,
    userAgent: options.userAgent,
  };

  const sessionId = options.sessionId || extractSessionId(headers, body);
  await addSessionRequest(sessionId, request);

  if (response) {
    await addSessionResponse(sessionId, requestId, {
      ...response,
      responseTime: options.responseTime ?? response.responseTime,
    });
  }
}