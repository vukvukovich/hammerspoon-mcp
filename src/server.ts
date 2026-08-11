import { McpServer } from '@modelcontextprotocol/server';

import { HammerspoonBridge } from './bridge/bridge.js';
import type { ServerConfig } from './config/env.js';
import { DocsIndex } from './docs/docs-index.js';
import { logger } from './logging/logger.js';
import { ALL_TOOLS } from './tools/index.js';
import type { RegisterableTool } from './tools/registry.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

/**
 * Selects the tools an exposure level advertises.
 *
 * Gated tools are not registered at all, so they never appear in tools/list.
 * Advertising a tool and then refusing it would still put the capability in
 * front of the model, which is what the tier system exists to avoid.
 */
export function selectTools(
  exposure: ServerConfig['exposure'],
  tools: readonly RegisterableTool[] = ALL_TOOLS
): readonly RegisterableTool[] {
  if (exposure === 'all') return tools;
  return tools.filter((tool) => tool.tier === 'safe');
}

export function createServer(config: ServerConfig): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  const bridge = new HammerspoonBridge({ hsPathOverride: config.hsPathOverride });
  // Parsed lazily on first search, so startup stays fast and a missing docs
  // file only affects the one tool that needs it.
  const docs = new DocsIndex(config.docsPathOverride);
  const tools = selectTools(config.exposure);

  for (const tool of tools) {
    tool.register(server, { bridge, docs });
  }

  logger.info(
    `Registered ${String(tools.length)} tools at exposure "${config.exposure}"${
      config.exposure === 'safe' ? ' (set HS_MCP_TOOLS=all to enable hs_eval)' : ''
    }.`
  );

  if (bridge.hsPath === undefined) {
    // Deliberately not fatal. A server that exits here looks like a crashed
    // server to the client, with no way to ask what went wrong. Staying up
    // means every tool can answer with a setup hint instead.
    logger.warn('The hs binary was not found. Tools will return setup instructions until it is.');
  }

  return server;
}
