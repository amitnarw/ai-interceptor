# Proxy Telegram Agent — Project Goals

## Progress Tracker
Each goal is **self-contained and working**. After completing a goal, everything runs without errors.

**Tech Stack:** TypeScript + Node.js + Express | Production-grade standards

---

## Goal 1: Project Scaffold + TypeScript Setup
**Target: TypeScript project with Express server running on :4000**

- [x] Initialize Node.js project
- [x] `tsconfig.json` with strict mode
- [x] `package.json` with minimal dependencies
- [x] `.env.example` with all required variables
- [x] `src/server.ts` — Express app entry point
- [x] `src/config/index.ts` — Environment variable loader
- [x] Basic health check: `GET /health`
- [x] Simple request logging middleware
- [x] Basic error handler middleware
- [x] Graceful shutdown (SIGTERM/SIGINT)
- [x] `nodemon.json` for development auto-reload

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

- [x] `src/routes/openai.ts`
- [x] `POST /v1/chat/completions` — OpenAI-compatible endpoint
- [x] Forward request to MiniMax API
- [x] Stream support (`stream: true` passthrough)
- [x] Preserve all request headers
- [x] Type definitions for request/response

**Success criteria:** Kilo-code/Cline configured with `http://localhost:4000/v1` sends/receives streaming responses

---

## Goal 3: Anthropic-Compatible Endpoint (Passthrough)
**Target: Claude Code works in transparent mode**

- [x] `src/routes/anthropic.ts`
- [x] `POST /v1/messages` — Anthropic-compatible endpoint
- [x] Forward request to MiniMax Anthropic endpoint
- [x] Stream support (`stream: true` passthrough)
- [x] Preserve all request headers
- [x] Handle `202` (streaming) and `200` (non-streaming) status codes

**Success criteria:** Claude Code configured with `ANTHROPIC_BASE_URL=http://localhost:4000` sends/receives streaming responses

---

## Goal 4: Tool Call Detection
**Target: Detect tool calls in AI responses**

- [x] `src/utils/toolDetection.ts`
- [x] `detectOpenAIToolCalls(response)` — OpenAI format
- [x] `detectAnthropicToolCalls(response)` — Anthropic format
- [x] Support for streaming chunks (SSE)
- [x] Type definitions for tool calls

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

- [x] `src/filters/toolFilter.ts`
- [x] `INTERCEPT_TOOLS` Set: write_to_file, create_file, delete_file, apply_diff, str_replace, insert_content, execute_command, run_terminal_cmd, computer_use
- [x] `PASSTHROUGH_TOOLS` Set: read_file, list_directory, search_files, grep_search, web_search, get_file_info
- [x] `classifyTool(toolName: string): 'intercept' | 'passthrough'`
- [x] Unknown tools → INTERCEPT (safe fallback)

**Success criteria:** classifyTool returns correct classification for all known tools

---

## Goal 6: Mode Toggle (Desk/Away)
**Target: System switches between transparent and approval modes**

- [x] `src/config/mode.ts`
- [x] Types: `Mode = 'desk' | 'away'`
- [x] Persist to `data/mode.json`
- [x] `getMode(): Mode`
- [x] `setMode(mode: Mode): void`
- [x] `isAwayMode(): boolean`
- [x] Auto-create `data/` directory on startup

**Success criteria:** Mode persists across restarts

---

## Goal 7: Telegram Bot — Polling + Commands
**Target: Telegram bot responds to commands**

- [x] `src/telegram/bot.ts` — Bot polling class
- [x] `src/telegram/commands.ts` — Command handlers
- [x] `/start` — Welcome message
- [x] `/away` — Set mode to AWAY
- [x] `/desk` — Set mode to DESK
- [x] `/status` — Show current mode
- [x] Rate limiting: 1 message/second
- [x] Graceful polling stop on shutdown
- [x] Error handling for bot token validation

**Success criteria:** Bot responds to all commands from your Telegram account

---

## Goal 8: Telegram Inline Buttons
**Target: Send tool approval requests with Accept/Reject/Custom buttons**

- [x] `src/telegram/keyboards.ts` — Keyboard builders
- [x] Inline keyboard: [✅ Accept] [❌ Reject] [✏️ Custom]
- [x] Format approval message with tool name, file path, preview
- [x] Handle `callback_query` events
- [x] `answerCallbackQuery` for immediate UI feedback

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

- [x] `src/config/redis.ts` — Redis connection
- [x] `src/approvals/queue.ts` — Queue class
- [x] `src/approvals/worker.ts` — Job processor
- [x] Job data: requestId, toolName, filePath, preview, timestamp, chatId
- [x] Job options: timeout (AUTO_REJECT_TIMEOUT_MS)
- [x] Auto-reject on timeout
- [x] ioredis-mock fallback if Redis unavailable

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

- [x] `src/services/approvalService.ts` — Approval orchestration
- [x] Non-streaming peek call to detect tool_calls
- [x] If INTERCEPT tool + AWAY mode → hold request
- [x] Create job → send Telegram buttons → wait for resolution
- [x] On approval → stream response to client
- [x] On rejection → return deny message
- [x] On timeout → auto-reject
- [x] PASSTHROUGH tools or DESK mode → stream normally

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

- [x] Custom button → ask user for modification text
- [x] Store user's text with approval job
- [x] Inject text as additional context on re-run
- [x] Stream new response to client
- [x] Timeout for custom input (60 seconds)

**Success criteria:** User types "use async/await instead" and AI modifies the code

---

## Goal 12: Error Handling
**Target: Graceful handling of all failure scenarios**

- [x] Global error handler middleware
- [x] Handle MiniMax API errors (invalid key, rate limits)
- [x] Handle Telegram API errors (bot blocked, rate limits)
- [x] Handle malformed AI responses
- [x] Request timeout (60s default)
- [x] Graceful shutdown: complete in-flight approvals before exit

**Success criteria:** No unhandled promise rejections, all errors logged

---

## Goal 13: Testing + Documentation
**Target: Test coverage + documentation**

- [x] Unit tests for tool detection and filtering
- [x] Integration tests for API endpoints
- [x] README.md with setup instructions
- [x] Environment variables documentation

**Success criteria:** Core functions tested, documentation complete

---

## All Goals Complete!

---

## Project Structure
```
proxy-telegram-agent/
├── src/
│   ├── server.ts            # Express entry point
│   ├── config/
│   │   ├── index.ts       # Env loader
│   │   ├── mode.ts        # Mode state
│   │   └── redis.ts       # Redis/fake queue connection
│   ├── routes/
│   │   ├── openai.ts      # OpenAI endpoint
│   │   └── anthropic.ts    # Anthropic endpoint
│   ├── filters/
│   │   └── toolFilter.ts  # INTERCEPT/PASSTHROUGH
│   ├── telegram/
│   │   ├── bot.ts         # Bot polling
│   │   ├── commands.ts    # Command handlers
│   │   └── keyboards.ts   # Inline keyboards
│   ├── approvals/
│   │   ├── queue.ts       # BullMQ queue
│   │   ├── worker.ts      # Job processor
│   │   └── fakeQueue.ts   # In-memory fallback
│   ├── services/
│   │   └── approvalService.ts  # Approval orchestration
│   ├── utils/
│   │   └── toolDetection.ts    # Tool call detection
│   ├── middleware/
│   │   ├── errorHandler.ts     # Error handling
│   │   └── requestLogger.ts    # Request logging
│   └── types/
├── tests/                     # Test files
├── .env.example
├── tsconfig.json
├── package.json
├── vitest.config.ts
└── README.md
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
