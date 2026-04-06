import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config();

interface Config {
  minimaxApiKey: string;
  telegramBotToken: string;
  telegramChatId: string;
  proxyPort: number;
  mode: 'desk' | 'away';
  autoRejectTimeoutMs: number;
}

function getEnv(key: string, fallback: string): string {
  const value = process.env[key];
  if (!value) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getEnvInt(key: string, fallback: number): number {
  const value = getEnv(key, fallback.toString());
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be a valid integer`);
  }
  return parsed;
}

export const config: Config = {
  minimaxApiKey: getEnv('MINIMAX_API_KEY', ''),
  telegramBotToken: getEnv('TELEGRAM_BOT_TOKEN', ''),
  telegramChatId: getEnv('TELEGRAM_CHAT_ID', ''),
  proxyPort: getEnvInt('PROXY_PORT', 4000),
  mode: (getEnv('MODE', 'desk') as 'desk' | 'away'),
  autoRejectTimeoutMs: getEnvInt('AUTO_REJECT_TIMEOUT_MS', 600000),
};

const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
