/**
 * Library surface.
 *
 * Exported so the pieces can be tested and reused. The supported entry point
 * for end users is the hammerspoon-mcp binary, not this module.
 */

export { HammerspoonBridge, DEFAULT_TIMEOUT_MS } from './bridge/bridge.js';
export type { BridgeOptions, ExecFn, ExecResult, RunOptions } from './bridge/bridge.js';
export {
  buildProgram,
  encodeArgs,
  envelopeToResult,
  parseEnvelope,
  MAX_ENCODED_ARG_BYTES,
} from './bridge/codec.js';
export type { LuaEnvelope } from './bridge/codec.js';
export { formatBridgeError } from './bridge/errors.js';
export type { BridgeError, BridgeErrorKind, BridgeResult } from './bridge/errors.js';
export { candidatePaths, resolveHsPath } from './bridge/hs-path.js';
export type { HsPathLookup, ResolveHsPathOptions } from './bridge/hs-path.js';
export { ENV_KEYS, loadConfig, parseExposure } from './config/env.js';
export type { ServerConfig, ToolExposure } from './config/env.js';
export { createServer, selectTools } from './server.js';
export { defineTool, errorResult, fromBridge, jsonResult, textResult } from './tools/registry.js';
export type { RegisterableTool, ToolContext, ToolDefinition, ToolTier } from './tools/registry.js';
export { ALL_TOOLS } from './tools/index.js';
export { SERVER_NAME, SERVER_VERSION } from './version.js';
