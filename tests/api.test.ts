import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import cors from 'cors';

// Mock the config and services before importing routes
import { config } from '../src/config/index.js';
import { modeManager } from '../src/config/mode.js';
import openaiRouter from '../src/routes/openai.js';
import anthropicRouter from '../src/routes/anthropic.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

// Create test app
const app = express();
app.use(cors());
app.use(express.json());
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    mode: config.mode,
  });
});
app.use(openaiRouter);
app.use(anthropicRouter);
app.use(errorHandler);

const PORT = 4001;
let server: ReturnType<typeof app.listen> | null = null;

beforeAll(() => {
  server = app.listen(PORT);
});

afterAll(() => {
  if (server) {
    server.close();
  }
});

describe('Health Endpoint', () => {
  it('should return health status', async () => {
    const response = await fetch(`http://localhost:${PORT}/health`);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.status).toBe('ok');
    expect(data.timestamp).toBeDefined();
  });
});

describe('Mode Manager', () => {
  it('should get current mode', () => {
    const mode = modeManager.getMode();
    expect(['desk', 'away']).toContain(mode);
  });

  it('should set and get mode', () => {
    const originalMode = modeManager.getMode();

    modeManager.setMode('away');
    expect(modeManager.getMode()).toBe('away');
    expect(modeManager.isAwayMode()).toBe(true);
    expect(modeManager.isDeskMode()).toBe(false);

    modeManager.setMode('desk');
    expect(modeManager.getMode()).toBe('desk');
    expect(modeManager.isDeskMode()).toBe(true);
    expect(modeManager.isAwayMode()).toBe(false);

    // Restore original mode
    modeManager.setMode(originalMode);
  });
});

describe('Error Handler', () => {
  it('should handle malformed JSON gracefully', async () => {
    const response = await fetch(`http://localhost:${PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not valid json',
    });

    // Should return 400 or 500, not hang
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});