# Proxy Telegram Agent

Local HTTP proxy that intercepts AI tool calls and requires Telegram approval when in Away Mode.

## Features

- Intercepts tool calls (file edits, terminal commands) from VS Code AI extensions
- Sends Telegram notifications with Accept/Reject/Custom buttons
- Toggle between Desk Mode (transparent passthrough) and Away Mode (approval required)
- Supports Kilo-code, Cline, and Claude Code extensions

## Setup

1. Copy `.env.example` to `.env` and fill in your credentials:
   - `MINIMAX_API_KEY` - Your MiniMax API key
   - `TELEGRAM_BOT_TOKEN` - From [@BotFather](https://t.me/BotFather)
   - `TELEGRAM_CHAT_ID` - Your Telegram chat ID

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the server:
   ```bash
   npm run dev
   ```

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `MINIMAX_API_KEY` | MiniMax API key | Required |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token | Required |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID | Required |
| `PROXY_PORT` | Server port | 4000 |
| `MODE` | Initial mode (`desk` or `away`) | desk |
| `AUTO_REJECT_TIMEOUT_MS` | Auto-reject after timeout | 600000 |

## VS Code Extension Configuration

### Kilo-code / Cline
- API Provider: OpenAI Compatible
- Base URL: `http://localhost:4000/v1`

### Claude Code
- Set environment variable: `ANTHROPIC_BASE_URL=http://localhost:4000`

## Telegram Commands

- `/start` - Welcome message
- `/away` - Enable approval mode
- `/desk` - Disable approval mode (transparent passthrough)
- `/status` - Show current mode

## Development

```bash
npm run dev      # Start with hot reload
npm run build    # Build for production
npm start        # Run production build
npm run typecheck # TypeScript validation
npm run lint     # ESLint
```
