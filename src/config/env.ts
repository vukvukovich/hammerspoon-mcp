/**
 * Environment configuration.
 *
 * Parsing is deliberately fail-closed: an unrecognised HS_MCP_TOOLS value
 * falls back to the safe tier and warns, rather than guessing that the user
 * meant to unlock arbitrary code execution.
 */

import { logger } from '../logging/logger.js';

/**
 * Which tools are exposed.
 *
 * - `safe`: inspect, arrange, notify, search docs. The default.
 * - `all`: additionally exposes hs_eval, which runs arbitrary Lua and can
 *   therefore do anything the user can do on the machine.
 */
export type ToolExposure = 'safe' | 'all';

/**
 * How Lua reaches Hammerspoon.
 *
 * - `socket`: a persistent Unix socket, self-installed on first call, with
 *   automatic fallback to spawn when it cannot be established. The default.
 * - `spawn`: one `hs -c` process per call, the classic transport. The escape
 *   hatch if the socket path misbehaves on some setup.
 */
export type TransportKind = 'socket' | 'spawn';

export type ServerConfig = {
  readonly exposure: ToolExposure;
  readonly transport: TransportKind;
  readonly hsPathOverride: string | undefined;
  readonly docsPathOverride: string | undefined;
};

export const ENV_KEYS = {
  exposure: 'HS_MCP_TOOLS',
  transport: 'HS_MCP_TRANSPORT',
  hsPath: 'HS_MCP_HS_PATH',
  docsPath: 'HS_MCP_DOCS_PATH',
  logLevel: 'HS_MCP_LOG_LEVEL',
} as const;

function readOptional(source: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = source[key]?.trim();
  return raw === undefined || raw === '' ? undefined : raw;
}

export function parseExposure(raw: string | undefined): ToolExposure {
  if (raw === undefined) return 'safe';

  const normalised = raw.trim().toLowerCase();
  if (normalised === 'safe' || normalised === 'all') return normalised;

  logger.warn(
    `${ENV_KEYS.exposure}="${raw}" is not recognised, falling back to "safe". Valid values are "safe" and "all".`
  );
  return 'safe';
}

export function parseTransport(raw: string | undefined): TransportKind {
  if (raw === undefined) return 'socket';

  const normalised = raw.trim().toLowerCase();
  if (normalised === 'socket' || normalised === 'spawn') return normalised;

  logger.warn(
    `${ENV_KEYS.transport}="${raw}" is not recognised, falling back to "socket". Valid values are "socket" and "spawn".`
  );
  return 'socket';
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    exposure: parseExposure(readOptional(source, ENV_KEYS.exposure)),
    transport: parseTransport(readOptional(source, ENV_KEYS.transport)),
    hsPathOverride: readOptional(source, ENV_KEYS.hsPath),
    docsPathOverride: readOptional(source, ENV_KEYS.docsPath),
  };
}
