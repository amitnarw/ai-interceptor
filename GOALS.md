# Proxy Telegram Agent — Project Goals

## Progress Tracker
Each goal is **self-contained and working**. After completing a goal, everything runs without errors.

**Tech Stack:** TypeScript + Node.js + Express | Production-grade standards

---

## Goal 1: Project Scaffold + TypeScript Setup
**Target: TypeScript project with Express server running on :4000**

- [ ] Initialize Node.js project
- [ ] `tsconfig.json` with strict mode
- [ ] `package.json` with minimal dependencies
- [ ] `.env.example` with all required variables
- [ ] `src/server.ts` — Express app entry point
- [ ] `src/config/index.ts` — Environment variable loader
- [ ] Basic health check: `GET /health`
- [ ] Simple request logging middleware
- [ ] Basic error handler middleware
- [ ] Graceful shutdown (SIGTERM/SIGINT)
- [ ] `nodemon.json` for development auto-reload

**Dependencies:**
```json
{
  "dependencies": {
    "express": "^4.18.x",
    "dotenv": "^16.x",
    "axios": "^1.x",
    "cors": "^2.x"
  },
  "devDependencies": {
    "typescript": "^5.x",
    "@types/express": "^4.x",
    "@types/node": "^20.x",
    "@types/cors": "^2.x",
    "tsx": "^4.x",
    "nodemon": "^3.x"
  }
}
```

**Success criteria:** `npm run dev` starts server → `curl http://localhost:4000/health` returns 200

---

## Goal 2: OpenAI-Compatible Endpoint (Passthrough)
**Target: Kilo-code and Cline work in transparent mode**

- [ ] `src/routes/openai.ts`
- [ ] `POST /v1/chat/completions` — OpenAI-compatible endpoint
- [ ] Forward request to MiniMax API
- [ ] Stream support (`stream: true` passthrough)
- [ ] Preserve all request headers
- [ ] Type definitions for request/response

**Success criteria:** Kilo-code/Cline configured with `http://localhost:4000/v1` sends/receives streaming responses

---

## Goal 3: Anthropic-Compatible Endpoint (Passthrough)
**Target: Claude Code works in transparent mode**

- [ ] `src/routes/anthropic.ts`
- [ ] `POST /v1/messages` — Anthropic-compatible endpoint
- [ ] Forward request to MiniMax Anthropic endpoint
- [ ] Stream support (`stream: true` passthrough)
- [ ] Preserve all request headers
- [ ] Handle `202` (streaming) and `200` (non-streaming) status codes

**Success criteria:** Claude Code configured with `ANTHROPIC_BASE_URL=http://localhost:4000` sends/receives streaming responses

---

## Goal 4: Tool Call Detection
**Target: Detect tool calls in AI responses**

- [ ] `src/utils/toolDetection.ts`
- [ ] `detectOpenAIToolCalls(response)` — OpenAI format
- [ ] `detectAnthropicToolCalls(response)` — Anthropic format
- [ ] Support for streaming chunks (SSE)
- [ ] Type definitions for tool calls

**Types:**
```typescript
interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface AnthropicToolUse {
  id: string;
  type: 'tool_use';
  name: string;
  input: Record<string, unknown>;
}
```

**Success criteria:** Tool calls detected correctly in both OpenAI and Anthropic formats

---

## Goal 5: Tool Filtering
**Target: Classify tools as INTERCEPT or PASSTHROUGH**

- [ ] `src/filters/toolFilter.ts`
- [ ] `INTERCEPT_TOOLS` Set: write_to_file, create_file, delete_file, apply_diff, str_replace, insert_content, execute_command, run_terminal_cmd, computer_use
- [ ] `PASSTHROUGH_TOOLS` Set: read_file, list_directory, search_files, grep_search, web_search, get_file_info
- [ ] `classifyTool(toolName: string): 'intercept' | 'passthrough'`
- [ ] Unknown tools → INTERCEPT (safe fallback)

**Success criteria:** classifyTool returns correct classification for all known tools

---

## Goal 6: Mode Toggle (Desk/Away)
**Target: System switches between transparent and approval modes**

- [ ] `src/config/mode.ts`
- [ ] Types: `Mode = 'desk' | 'away'`
- [ ] Persist to `data/mode.json`
- [ ] `getMode(): Mode`
- [ ] `setMode(mode: Mode): void`
- [ ] `isAwayMode(): boolean`
- [ ] Auto-create `data/` directory on startup

**Success criteria:** Mode persists across restarts

---

## Goal 7: Telegram Bot — Polling + Commands
**Target: Telegram bot responds to commands**

- [ ] `src/telegram/bot.ts` — Bot polling class
- [ ] `src/telegram/commands.ts` — Command handlers
- [ ] `/start` — Welcome message
- [ ] `/away` — Set mode to AWAY
- [ ] `/desk` — Set mode to DESK
- [ ] `/status` — Show current mode
- [ ] Rate limiting: 1 message/second
- [ ] Graceful polling stop on shutdown
- [ ] Error handling for bot token validation

**Success criteria:** Bot responds to all commands from your Telegram account

---

## Goal 8: Telegram Inline Buttons
**Target: Send tool approval requests with Accept/Reject/Custom buttons**

- [ ] `src/telegram/keyboards.ts` — Keyboard builders
- [ ] Inline keyboard: [✅ Accept] [❌ Reject] [✏️ Custom]
- [ ] Format approval message with tool name, file path, preview
- [ ] Handle `callback_query` events
- [ ] `answerCallbackQuery` for immediate UI feedback

**Message Format:**
```
⚡ Tool Call Requested

🔧 Tool: write_to_file
📄 File: src/components/Login.jsx
📝 Preview: import React, { useState }...

[✅ Accept] [❌ Reject] [✏️ Custom]
```

**Success criteria:** Telegram receives formatted approval message, buttons trigger callbacks

---

## Goal 9: BullMQ Approval Queue
**Target: Jobs persist and survive server restarts**

- [ ] `src/config/redis.ts` — Redis connection
- [ ] `src/approvals/queue.ts` — Queue class
- [ ] `src/approvals/worker.ts` — Job processor
- [ ] Job data: requestId, toolName, filePath, preview, timestamp, chatId
- [ ] Job options: timeout (AUTO_REJECT_TIMEOUT_MS)
- [ ] Auto-reject on timeout
- [ ] SQLite fallback via `fakeyou.ts` if Redis unavailable (see Note)

**ApprovalJobData Type:**
```typescript
interface ApprovalJobData {
  id: string;
  toolName: string;
  filePath?: string;
  preview: string;
  timestamp: number;
  chatId: number;
  status: 'pending' | 'approved' | 'rejected' | 'timeout';
  customContext?: string;
}
```

**Success criteria:** Jobs survive server restart, timeout triggers auto-reject

---

## Goal 10: Streaming with Approval Flow
**Target: Full intercept → approve/reject → forward/deny loop**

- [ ] `src/services/approvalService.ts` — Approval orchestration
- [ ] Non-streaming peek call to detect tool_calls
- [ ] If INTERCEPT tool + AWAY mode → hold request
- [ ] Create job → send Telegram buttons → wait for resolution
- [ ] On approval → stream response to client
- [ ] On rejection → return deny message
- [ ] On timeout → auto-reject
- [ ] PASSTHROUGH tools or DESK mode → stream normally

**Rejection Response:**
```json
{
  "error": "Tool call rejected by user",
  "tool": "write_to_file"
}
```

**Success criteria:** Full workflow end-to-end works correctly

---

## Goal 11: Custom Response Injection
**Target: ✏️ Custom button lets user modify the AI's action**

- [ ] Custom button → ask user for modification text
- [ ] Store user's text with approval job
- [ ] Inject text as additional context on re-run
- [ ] Stream new response to client
- [ ] Timeout for custom input (60 seconds)

**Success criteria:** User types "use async/await instead" and AI modifies the code

---

## Goal 12: Error Handling
**Target: Graceful handling of all failure scenarios**

- [ ] Global error handler middleware
- [ ] Handle MiniMax API errors (invalid key, rate limits)
- [ ] Handle Telegram API errors (bot blocked, rate limits)
- [ ] Handle malformed AI responses
- [ ] Request timeout (60s default)
- [ ] Graceful shutdown: complete in-flight approvals before exit

**Success criteria:** No unhandled promise rejections, all errors logged

---

## Goal 13: Testing + Documentation
**Target: Test coverage + documentation**

- [ ] Unit tests for tool detection and filtering
- [ ] Integration tests for API endpoints
- [ ] README.md with setup instructions
- [ ] Environment variables documentation

**Success criteria:** Core functions tested, documentation complete

---

## Current Goal: Goal 1 — Project Scaffold + TypeScript Setup

---

## Project Structure
```
proxy-telegram-agent/
├── src/
│   ├── server.ts
│   ├── config/
│   │   ├── index.ts       # Env loader
│   │   └── mode.ts        # Mode state
│   ├── routes/
│   │   ├── openai.ts      # OpenAI endpoint
│   │   └── anthropic.ts   # Anthropic endpoint
│   ├── filters/
│   │   └── toolFilter.ts  # INTERCEPT/PASSTHROUGH
│   ├── telegram/
│   │   ├── bot.ts         # Bot polling
│   │   ├── commands.ts    # Command handlers
│   │   └── keyboards.ts   # Inline keyboards
│   ├── approvals/
│   │   ├── queue.ts       # BullMQ queue
│   │   └── worker.ts      # Job processor
│   ├── services/
│   │   └── approvalService.ts
│   ├── utils/
│   │   └── toolDetection.ts
│   ├── middleware/
│   │   ├── errorHandler.ts
│   │   └── requestLogger.ts
│   └── types/
│       └── index.ts
├── data/                   # Persisted state
├── tests/
├── .env.example
├── tsconfig.json
├── package.json
└── GOALS.md
```

---

## Notes
- Goals are sequential — complete one before moving to next
- All code must pass `tsc --noEmit`
- After each goal, test before proceeding
- If something breaks, fix before adding more code
- BullMQ requires Redis — use ioredis-mock for local dev without Redis
