/**
 * Logging goes to stderr, never stdout.
 *
 * stdout is the MCP protocol channel: the client parses it as a stream of
 * JSON-RPC messages. A single stray character written there corrupts the
 * stream and the client drops the connection. This module is the only place
 * in the codebase allowed to touch the console, and it only ever uses stderr.
 */

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function resolveMinLevel(): LogLevel {
  const raw = process.env['HS_MCP_LOG_LEVEL']?.toLowerCase();
  const match = LEVELS.find((level) => level === raw);
  return match ?? 'info';
}

const minRank = LEVEL_RANK[resolveMinLevel()];

function write(level: LogLevel, message: string, detail?: unknown): void {
  if (LEVEL_RANK[level] < minRank) return;
  const line = `[hammerspoon-mcp] ${level}: ${message}`;
  // console is banned everywhere else by lint. This file is the one exception,
  // configured as an override in eslint.config.js, and it only ever writes to
  // stderr.
  if (detail === undefined) {
    console.error(line);
    return;
  }
  console.error(line, detail);
}

export const logger = {
  debug: (message: string, detail?: unknown): void => {
    write('debug', message, detail);
  },
  info: (message: string, detail?: unknown): void => {
    write('info', message, detail);
  },
  warn: (message: string, detail?: unknown): void => {
    write('warn', message, detail);
  },
  error: (message: string, detail?: unknown): void => {
    write('error', message, detail);
  },
} as const;
