/**
 * Server identity reported to MCP clients.
 *
 * Kept as a constant rather than read from package.json, because resolving the
 * manifest relative to the compiled output is fragile across install layouts
 * (npx cache, global install, local link). A unit test asserts this matches
 * package.json, so drift fails CI instead of shipping.
 */
export const SERVER_NAME = 'hammerspoon-mcp';
export const SERVER_VERSION = '0.2.0';
