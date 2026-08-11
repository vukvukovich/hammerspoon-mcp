/**
 * The logger has one job that matters: never write to stdout. stdout carries
 * the MCP protocol, so a single stray byte there breaks the client connection.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

/** Reimports the module so the level is recomputed from the stubbed env. */
async function freshLogger(level?: string) {
  vi.resetModules();
  if (level === undefined) {
    vi.stubEnv('HS_MCP_LOG_LEVEL', '');
  } else {
    vi.stubEnv('HS_MCP_LOG_LEVEL', level);
  }
  return import('../../../src/logging/logger.js');
}

describe('logger', () => {
  it('writes to stderr and never to stdout', async () => {
    const { logger } = await freshLogger('debug');
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(stderr).toHaveBeenCalledTimes(4);
    expect(stdout).not.toHaveBeenCalled();
  });

  it('prefixes every line so the source is identifiable in a client log', async () => {
    const { logger } = await freshLogger('info');
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    logger.info('something happened');

    expect(stderr).toHaveBeenCalledWith('[hammerspoon-mcp] info: something happened');
  });

  it('passes structured detail through as a second argument', async () => {
    const { logger } = await freshLogger('info');
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    logger.error('failed', { code: 7 });

    expect(stderr).toHaveBeenCalledWith('[hammerspoon-mcp] error: failed', { code: 7 });
  });

  it('suppresses levels below the configured threshold', async () => {
    const { logger } = await freshLogger('warn');
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    logger.debug('hidden');
    logger.info('hidden');
    logger.warn('shown');
    logger.error('shown');

    expect(stderr).toHaveBeenCalledTimes(2);
  });

  it('defaults to info when the level is unset or nonsense', async () => {
    for (const level of [undefined, 'gibberish']) {
      const { logger } = await freshLogger(level);
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      logger.debug('hidden');
      logger.info('shown');

      expect(stderr).toHaveBeenCalledTimes(1);
      vi.restoreAllMocks();
    }
  });
});
