# CLAUDE.md — AI Proxy Telegram Interceptor

## Project Overview

This is a local HTTP proxy server that intercepts AI tool-calling requests and lets users approve/reject them via Telegram. It sits between an AI coding assistant (Cursor, Windsurf, etc.) and the MiniMax AI backend.

**Mode**: `DESK` (transparent passthrough) or `AWAY` (intercept tools for approval).

## Architecture Rules

### 1. No Classes — Functions Only
The codebase must use **module-level functions and state** — no `class` declarations. This was enforced after a 2026-04 refactor to simplify dependency injection and testing.

**Pattern**:
```typescript
// WRONG
class TelegramBot {
  private token: string;
  async sendMessage() { ... }
}
export const telegramBot = new TelegramBot();

// RIGHT
let token = '';
async function sendMessage(...) { ... }
export const telegramBot = { sendMessage, start, stop };
```

State lives in module-level variables (`Map`s for indexed state, plain variables for scalars).

### 2. No Classes in Tests
Mock dependencies by replacing module-level exports, not by instantiating classes with constructor args.

## Telegram UX Rules

### Message Design
- **ONE pinned message** per chat — evolves via `editMessage` as events stream in
- The pinned message shows:
  - Raw SSE streaming text (accumulated in `ChatState.sseText`)
  - Status line: `[Idle]`, `[Active]`, or `[Awaiting Approval]`
  - Pending approval info (tool name, file path, preview)
  - Recent events log
- **Always visible**: command keyboard at bottom
- When `awaiting_approval`: approval keyboard (Accept/Reject/Custom) appears above command buttons

### Command Keyboard
Buttons use `callback_data` — no emoji, plain text labels:
```
[Status] [Away] [Desk]
[Clear]
```

### Chat Input
- Chat message input field is **not used** for commands
- All interaction via inline keyboard buttons
- Custom input uses Telegram `force_reply` (user's next message = modification text)

## State Management

### `liveStatus.ts` — Single Evolving Telegram Message
- `startStatus(chatId)` — begins tracking, sends initial pinned message
- `addStatusEvent(chatId, event)` — adds event, schedules throttled edit
- `appendSseText(chatId, text)` — appends streaming text to message body
- `setApprovalRequired(...)` — transitions to `awaiting_approval`, shows approval keyboard
- `setApprovalResult(...)` — transitions back to `active`
- `completeStatus(chatId, success)` — shows final status, resets for next request
- Throttle: minimum 1000ms between edits (`MIN_EDIT_INTERVAL_MS`)

### `flushId` — Stale Timeout Guard
When `startStatus()` is called multiple times rapidly, `flushId` increments and old queued timeouts are discarded:
```typescript
const currentFlushId = chatState.flushId;
chatState.queueTimeout = setTimeout(async () => {
  if (chatState.flushId !== currentFlushId) {
    return; // stale — discard
  }
  await flushStatusUpdate(chatState);
}, delay);
```

### `approvalService.ts` — Approval Workflow
- `needsApproval(toolCalls)` — checks mode + tool classification
- `peekForToolCalls()` — non-streaming probe to detect tools before streaming
- `requestApproval(...)` — Promise-based, blocks until user responds or 10min timeout
- Custom input: `force_reply` via `sendMessageForceReply()`, matched by `reply_to_message_id`

## SSE Streaming

`SSEParser` in `src/utils/sseParser.ts` handles both OpenAI and Anthropic SSE formats. It:
- Tracks pending tool calls (multi-delta accumulation)
- Buffers text deltas
- Strips `data: [DONE]` and `event: ping` from forwarded content

In route handlers, for each SSE chunk:
1. `sseParser.parse(chunk)` → `{ events, cleanChunk }`
2. `appendSseText(chatId, cleanChunk)` → adds to Telegram message
3. `addStatusEvent(chatId, event)` for each parsed event
4. Forward `cleanChunk` to the original client

## Telegram Bot — Module Structure

Functions in `bot.ts`:
- `startBot()` / `stopBot()` — lifecycle
- `sendMessage(chatId, text, replyMarkup?)` — fire-and-forget
- `sendMessageWithId(chatId, text, replyMarkup?)` — returns `TelegramMessage`
- `editMessage(chatId, messageId, text, replyMarkup?)` — edit text + keyboard
- `pinChatMessage(chatId, messageId)` / `unpinChatMessage(chatId)`
- `setMyCommands()` — registers `/start`, `/away`, `/desk`, `/status`, `/clear`
- `sendMessageForceReply(chatId, text)` — for custom input prompts
- `getPinnedMessageId(chatId)` — accessor
- `clearCustomInputState(chatId)` — clears force_reply tracking

## Coding Conventions

- **No default exports** — all exports are named
- **Async/await** for all I/O (no raw `.then()` chains)
- **Interfaces preferred over types** for object shapes
- **`Map`** for indexed state (chatId → state), never plain objects as maps
- **No mutation of passed objects** — clone before modify
- **Console logging** with `[Component]` prefix, e.g. `[Telegram]`, `[LiveStatus]`, `[ApprovalService]`
- **Error handling** — always log and continue (never crash the server)
