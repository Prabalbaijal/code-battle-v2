import { pino, type Logger as PinoLogger, type LoggerOptions } from 'pino';

export type Logger = PinoLogger;

export interface CreateLoggerOptions {
  service: string;
  level?: string;
  /** Extra static fields added to every line. */
  base?: Record<string, unknown>;
}

/** Paths that must never reach logs (credentials, tokens, PII). */
export const REDACT_PATHS = [
  'password',
  '*.password',
  'passwordHash',
  '*.passwordHash',
  'token',
  '*.token',
  'refreshToken',
  '*.refreshToken',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers["x-auth-token"]',
  'headers["x-rapidapi-key"]',
];

export function createLogger(opts: CreateLoggerOptions): Logger {
  const options: LoggerOptions = {
    level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
    base: { service: opts.service, env: process.env.NODE_ENV ?? 'development', ...opts.base },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  };
  return pino(options);
}
