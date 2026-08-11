/**
 * Bridge error taxonomy.
 *
 * Every failure mode of talking to Hammerspoon is one of these kinds. They are
 * a discriminated union rather than Error subclasses so that callers must
 * handle each case explicitly, and so the compiler catches a missed case when
 * a new kind is added.
 *
 * Each error carries a `hint`: the actionable sentence shown to the agent (and
 * therefore to the user). A bridge failure is almost always a setup problem,
 * and the agent can only fix what the error tells it.
 */

export type BridgeErrorKind =
  'HsNotFound' | 'HsNotRunning' | 'LuaError' | 'Timeout' | 'PayloadTooLarge' | 'ProtocolError';

export type BridgeError = {
  readonly kind: BridgeErrorKind;
  /** Short technical description of what failed. */
  readonly message: string;
  /** What the user should do about it. */
  readonly hint: string;
  /** Raw underlying detail, for logs only. Never shown verbatim to the model. */
  readonly detail?: string;
};

export type BridgeResult<TValue> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly error: BridgeError };

const SETUP_HINT =
  'Install Hammerspoon (brew install --cask hammerspoon), then add require("hs.ipc") to ~/.hammerspoon/init.lua and reload the config.';

export function hsNotFound(searched: readonly string[]): BridgeError {
  return {
    kind: 'HsNotFound',
    message: 'The hs command line tool was not found.',
    hint: `${SETUP_HINT} Searched: ${searched.join(', ')}. Set HS_MCP_HS_PATH to point at it directly.`,
  };
}

export function hsNotRunning(detail: string): BridgeError {
  return {
    kind: 'HsNotRunning',
    message: 'Hammerspoon is not running, or its hs.ipc module is not loaded.',
    hint: `Open Hammerspoon and make sure ~/.hammerspoon/init.lua contains require("hs.ipc"), then reload the config. ${SETUP_HINT}`,
    detail,
  };
}

export function luaError(message: string): BridgeError {
  return {
    kind: 'LuaError',
    message,
    hint: 'The Lua code raised an error inside Hammerspoon. Check the arguments, or run hs_console_tail to see surrounding log output.',
  };
}

export function timeout(milliseconds: number): BridgeError {
  return {
    kind: 'Timeout',
    message: `Hammerspoon did not respond within ${String(milliseconds)}ms.`,
    hint: 'Hammerspoon may be blocked by a long-running Lua call. Check the Hammerspoon console, and prefer smaller operations.',
  };
}

export function payloadTooLarge(bytes: number, limit: number): BridgeError {
  return {
    kind: 'PayloadTooLarge',
    message: `Encoded arguments are ${String(bytes)} bytes, over the ${String(limit)} byte limit.`,
    hint: 'Pass less data. Large payloads risk exceeding the operating system argument size limit.',
  };
}

export function protocolError(message: string, detail?: string): BridgeError {
  return {
    kind: 'ProtocolError',
    message,
    hint: 'This is a bug in hammerspoon-mcp. Please report it with the stderr log attached.',
    ...(detail === undefined ? {} : { detail }),
  };
}

/** One-line rendering for tool output. */
export function formatBridgeError(error: BridgeError): string {
  return `${error.kind}: ${error.message}\n\n${error.hint}`;
}
