import { Request, Response, NextFunction } from 'express';
import { AxiosError } from 'axios';

// Custom error classes
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public message: string,
    public code?: string
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class APIError extends AppError {
  constructor(
    statusCode: number,
    message: string,
    public apiSource?: 'minimax' | 'telegram'
  ) {
    super(statusCode, message, 'API_ERROR');
    this.name = 'APIError';
  }
}

export class MiniMaxAPIError extends APIError {
  constructor(
    statusCode: number,
    message: string,
    public errorType?: string
  ) {
    super(statusCode, message, 'minimax');
    this.name = 'MiniMaxAPIError';
  }
}

export class TelegramAPIError extends APIError {
  constructor(
    statusCode: number,
    message: string,
    public errorType?: string
  ) {
    super(statusCode, message, 'telegram');
    this.name = 'TelegramAPIError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(400, message, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}

export class TimeoutError extends AppError {
  constructor(message: string = 'Request timeout') {
    super(408, message, 'TIMEOUT_ERROR');
    this.name = 'TimeoutError';
  }
}

// Error categorization for retry logic
export type RetryCategory = 'rate_limit' | 'authentication_failed' | 'server_error' | 'timeout' | 'unknown';

export function categorizeError(error: unknown): RetryCategory {
  if (error instanceof TimeoutError) return 'timeout';
  if (error instanceof MiniMaxAPIError) {
    if (error.statusCode === 429) return 'rate_limit';
    if (error.statusCode === 401 || error.statusCode === 403) return 'authentication_failed';
    if (error.statusCode >= 500) return 'server_error';
  }
  if (error instanceof AppError) {
    if (error.statusCode === 408) return 'timeout';
    if (error.statusCode === 429) return 'rate_limit';
    if (error.statusCode === 401 || error.statusCode === 403) return 'authentication_failed';
    if (error.statusCode >= 500) return 'server_error';
  }
  return 'unknown';
}

export function isRetryable(category: RetryCategory): boolean {
  return category === 'rate_limit' || category === 'server_error' || category === 'timeout';
}

// Parse MiniMax API errors
export function parseMiniMaxError(error: unknown): MiniMaxAPIError | null {
  if (!error || typeof error !== 'object') return null;

  const axiosError = error as AxiosError;
  if (!axiosError.response) return null;

  const status = axiosError.response.status;
  const responseData = axiosError.response.data as Record<string, unknown>;

  let errorType = 'unknown';
  let message = 'MiniMax API error';

  if (typeof responseData === 'object' && responseData !== null) {
    errorType = (responseData.error_type as string) || (responseData.type as string) || 'unknown';
    message = (responseData.error_message as string) || (responseData.message as string) || `HTTP ${status}`;
  }

  // Common error types
  switch (status) {
    case 401:
      errorType = 'invalid_api_key';
      message = 'Invalid MiniMax API key';
      break;
    case 403:
      errorType = 'forbidden';
      message = 'Forbidden: insufficient permissions';
      break;
    case 429:
      errorType = 'rate_limit';
      message = 'Rate limit exceeded. Please try again later.';
      break;
    case 500:
      errorType = 'server_error';
      message = 'MiniMax server error. Please try again later.';
      break;
    case 503:
      errorType = 'service_unavailable';
      message = 'MiniMax service unavailable. Please try again later.';
      break;
  }

  return new MiniMaxAPIError(status, message, errorType);
}

// Parse Telegram API errors
export function parseTelegramError(error: unknown): TelegramAPIError | null {
  if (!error || typeof error !== 'object') return null;

  const axiosError = error as AxiosError;
  if (!axiosError.response) return null;

  const status = axiosError.response.status;
  const responseData = axiosError.response.data as Record<string, unknown>;

  let errorType = 'unknown';
  let message = 'Telegram API error';

  if (typeof responseData === 'object' && responseData !== null) {
    errorType = (responseData.error_type as string) || 'unknown';
    message = (responseData.description as string) || (responseData.message as string) || `HTTP ${status}`;
  }

  // Common error types
  switch (status) {
    case 400:
      errorType = 'bad_request';
      message = `Telegram: ${message}`;
      break;
    case 401:
      errorType = 'unauthorized';
      message = 'Invalid Telegram bot token';
      break;
    case 403:
      errorType = 'bot_blocked';
      message = 'Bot was blocked by user';
      break;
    case 429:
      errorType = 'rate_limit';
      message = 'Telegram rate limit exceeded. Please try again later.';
      break;
  }

  return new TelegramAPIError(status, message, errorType);
}

// Enhanced error handler
export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Log the error with stack trace for debugging
  if (err instanceof AppError) {
    console.error(`[Error] ${err.name} [${err.code}]: ${err.message}`);
  } else {
    console.error(`[Error] ${err.name}: ${err.message}`);
    console.error(`[Error] Stack: ${err.stack}`);
  }

  // Handle known error types
  if (err instanceof MiniMaxAPIError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        type: err.errorType,
        message: err.message,
        source: 'minimax',
      },
    });
    return;
  }

  if (err instanceof TelegramAPIError) {
    // Don't send response if headers already sent (Telegram might not care)
    if (!res.headersSent) {
      res.status(err.statusCode).json({
        error: {
          code: err.code,
          type: err.errorType,
          message: err.message,
          source: 'telegram',
        },
      });
    }
    return;
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
      },
    });
    return;
  }

  // Handle unknown errors
  console.error(`[Error] Unhandled error:`, err);

  if (!res.headersSent) {
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      },
    });
  }
}

// Async handler wrapper to catch promise rejections
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}