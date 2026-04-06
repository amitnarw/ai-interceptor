# Proxy Telegram Agent

Local HTTP proxy that intercepts AI tool calls and requires Telegram approval when in Away Mode.

## Features

- **OpenAI Compatible** - Works with Kilo-code, Cline, and other OpenAI-compatible extensions
- **Anthropic Compatible** - Works with Claude Code via `ANTHROPIC_BASE_URL`
- **Tool Call Interception** - Detects and optionally blocks dangerous tool calls
- **Telegram Integration** - Approve/reject/custom modify tool calls via Telegram bot
- **Dual Modes** - Desk Mode (transparent) or Away Mode (approval required)
- **Custom Modifications** - Provide custom instructions when rejecting tool calls

## Quick Start

### 1. Configure Environment

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
MINIMAX_API_KEY=your_minimax_api_key
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_chat_id
```

### 2. Install & Run

```bash
npm install
npm run dev
```

### 3. Configure VS Code

**Kilo-code / Cline:**
- API Provider: OpenAI Compatible
- Base URL: `http://localhost:4000/v1`

**Claude Code:**
```bash
export ANTHROPIC_BASE_URL=http://localhost:4000
```

## Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `MINIMAX_API_KEY` | MiniMax API key | Yes | - |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather | Yes | - |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID | Yes | - |
| `PROXY_PORT` | Server port | No | `4000` |
| `MODE` | Initial mode (`desk` or `away`) | No | `desk` |
| `AUTO_REJECT_TIMEOUT_MS` | Auto-reject timeout (ms) | No | `600000` (10 min) |
| `USE_REDIS_MOCK` | Use in-memory queue (no Redis) | No | `true` |
| `REDIS_HOST` | Redis host | No | - |
| `REDIS_PORT` | Redis port | No | `6379` |
| `REDIS_PASSWORD` | Redis password | No | - |
| `REDIS_DB` | Redis database number | No | `0` |

## Mode Operation

### Desk Mode (Default)
- All AI requests pass through transparently
- No interception or approval required
- Use for trusted development

### Away Mode
- `write_to_file`, `create_file`, `delete_file`, `execute_command`, etc. are intercepted
- `read_file`, `list_directory`, `search_files`, `web_search`, etc. pass through
- Tool calls require Telegram approval
- 10-minute auto-reject timeout

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Show welcome message |
| `/desk` | Switch to Desk Mode |
| `/away` | Switch to Away Mode |
| `/status` | Show current mode and recent tool calls |
| `/clear` | Clear tool call history |

## Telegram Approval Buttons

When a tool call is intercepted in Away Mode:

- **Accept** - Approve the tool call as-is
- **Reject** - Deny the tool call
- **Custom** - Provide custom modification instructions

## Tool Classification

### Intercept Tools (Require Approval in Away Mode)
- `write_to_file` - Write content to files
- `create_file` - Create new files
- `delete_file` - Delete files
- `apply_diff` - Apply patches
- `str_replace` - Replace file content
- `insert_content` - Insert content into files
- `execute_command` - Run shell commands
- `run_terminal_cmd` - Run terminal commands
- `computer_use` - Control computer input

### Passthrough Tools (Always Allowed)
- `read_file` - Read file contents
- `list_directory` - List directory contents
- `search_files` - Search for files
- `grep_search` - Search within files
- `web_search` - Search the web
- `get_file_info` - Get file metadata

## API Endpoints

### OpenAI Compatible
```
POST http://localhost:4000/v1/chat/completions
```

### Anthropic Compatible
```
POST http://localhost:4000/v1/messages
```

### Health Check
```
GET http://localhost:4000/health
```

## Development

```bash
npm run dev        # Start with hot reload
npm run build      # Build for production
npm start          # Run production build
npm run typecheck  # TypeScript validation
npm run lint        # ESLint
npm test           # Run tests
```

## Architecture

```
Client Request
     │
     ▼
┌─────────────┐
│  Proxy      │
│  Server     │
└──────┬──────┘
       │
       ▼
┌─────────────────┐     ┌──────────────┐
│  Tool Call     │────▶│ Telegram Bot │
│  Detection      │     └──────────────┘
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Mode Check      │
├─────────────────┤
│ Desk Mode:       │──▶ Forward Request
│ Away Mode:       │
│   Passthrough ──▶│──▶ Forward Request
│   Intercept ────▶│──▶ Await Approval
└─────────────────┘
```

## Testing

```bash
npm test           # Run all tests
npm run test:watch # Run tests in watch mode
```

Tests cover:
- Tool detection (OpenAI and Anthropic formats)
- Tool filtering (intercept vs passthrough classification)
- API endpoint integration
- Mode management