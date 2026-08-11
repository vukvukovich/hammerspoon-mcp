#!/usr/bin/env node
/**
 * Binary entry point.
 *
 * serveStdio owns the connection lifecycle and the protocol era negotiation:
 * it pins one server instance from the factory for the life of the connection.
 * The factory registers everything once and is reused for either era.
 */

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { loadConfig } from './config/env.js';
import { logger } from './logging/logger.js';
import { createServer } from './server.js';

function main(): void {
  const config = loadConfig();
  const handle = serveStdio(() => createServer(config), {
    onerror: (error) => {
      logger.error('Transport error.', error.message);
    },
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info(`Received ${signal}, shutting down.`);
    void handle.close().finally(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
