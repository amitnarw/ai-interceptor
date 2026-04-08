export interface LogEntry {
  component: string;
  action: string;
  duration_ms?: number;
  error?: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export interface Logger {
  info(action: string, metadata?: Record<string, unknown>): void;
  error(action: string, error: Error | string, metadata?: Record<string, unknown>): void;
  duration(action: string, ms: number, metadata?: Record<string, unknown>): void;
  debug(action: string, metadata?: Record<string, unknown>): void;
}

export function createLogger(component: string): Logger {
  function formatEntry(
    action: string,
    metadata?: Record<string, unknown>,
    errorMsg?: string,
    duration?: number
  ): LogEntry {
    return {
      component,
      action,
      timestamp: new Date().toISOString(),
      ...(errorMsg && { error: errorMsg }),
      ...(duration !== undefined && { duration_ms: duration }),
      ...(metadata && Object.keys(metadata).length > 0 && { metadata }),
    };
  }

  return {
    info(action: string, metadata?: Record<string, unknown>) {
      console.log(JSON.stringify(formatEntry(action, metadata)));
    },

    error(action: string, error: Error | string, metadata?: Record<string, unknown>) {
      const errorMsg = typeof error === 'string' ? error : error.message;
      console.error(JSON.stringify(formatEntry(action, metadata, errorMsg)));
    },

    duration(action: string, ms: number, metadata?: Record<string, unknown>) {
      console.log(JSON.stringify(formatEntry(action, metadata, undefined, ms)));
    },

    debug(action: string, metadata?: Record<string, unknown>) {
      if (process.env.DEBUG) {
        console.log(JSON.stringify(formatEntry(action, metadata)));
      }
    },
  };
}

// Pre-configured loggers for common components
export const telegramLogger = createLogger('Telegram');
export const openAILogger = createLogger('OpenAI');
export const anthropicLogger = createLogger('Anthropic');
export const approvalLogger = createLogger('ApprovalService');
export const liveStatusLogger = createLogger('LiveStatus');
export const queueLogger = createLogger('Queue');
export const workerLogger = createLogger('Worker');
