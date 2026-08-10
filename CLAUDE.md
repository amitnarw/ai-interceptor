# CLAUDE.md — agentwatch

## Project Overview

`agentwatch` lets you monitor and approve AI agent actions (file writes, shell commands, file reads, MCP calls) from Telegram — with a local web UI and Android app on the roadmap. It works via **native hooks** for Claude Code, Cursor, and OpenCode, so it works with any subscription tier (Pro/Max/Free) — no base URL changes required. It is installed per-project.

The project evolved from `ai-interceptor` (a MiniMax HTTP proxy). That proxy architecture is deprecated; `agentwatch` is hooks-first. This repo is a scratch/source repo — the primary work happens in the sibling `D:\amit\agentwatch` repo.

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
  - Streaming response text (accumulated in chat state)
  - Status line: `Idle`, `Active`, or `Awaiting Approval`
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

### `liveStatus` — Single Evolving Telegram Message
- `startStatus(chatId)` — begins tracking, sends initial pinned message
- `addStatusEvent(chatId, event)` — adds event, schedules throttled edit
- `appendText(chatId, text)` — appends streaming text to message body
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

## Approval Workflow
- `requestApproval(...)` — Promise-based, blocks until user responds or timeout
- Custom input: `force_reply` via `sendMessageForceReply()`, matched by `reply_to_message_id`

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
- **Console logging** with `[Component]` prefix, e.g. `[Telegram]`, `[LiveStatus]`, `[Approval]`
- **Error handling** — always log and continue (never crash the daemon)

## Project Structure
```
src/
  bot.ts          # Telegram bot logic (start, stop, send, edit, commands)
  liveStatus.ts   # Live status tracking (pinned message, events, approval)
  hooks/          # Telegram hooks adapter
    claudeCode.ts  # Claude Code native hook adapter
    cursor.ts       # Cursor hooks.json adapter
    openCode.ts     # OpenCode permission config adapter
  types/          # TypeScript interfaces and types
  utils/          # Utility functions
  cli.ts          # CLI interface (init, start, status, install, uninstall)
  daemon.ts       # Daemon process
  test/           # Tests
```

## Dependencies

- `typescript` >= 5.0
- `otel-node` for tracing
- `express` for web UI
- `node-telegram-bot-api` for Telegram
- `dotenv` for configuration
- `chalk` for console output

## Installation

```bash
npm install
npm run build
npm run test
npm run typecheck
```

## Usage

```bash
npm run start      # Start the daemon
npm run install    # Install hooks on connected agents
npm run uninstall  # Remove hooks from connected agents
```

## Roadmap

- [x] Basic Telegram bot with approval workflow
- [x] Claude Code native hook adapter
- [x] Cursor hooks.json adapter
- [x] OpenCode permission config adapter
- [ ] Android app (on roadmap)
- [ ] Web UI (on roadmap)
- [ ] CLI: init, start, status, install, uninstall
- [ ] Better error handling and retry logic