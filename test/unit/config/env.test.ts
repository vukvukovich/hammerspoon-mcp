import { describe, expect, it } from 'vitest';

import { ENV_KEYS, loadConfig, parseExposure, parseTransport } from '../../../src/config/env.js';

describe('parseExposure', () => {
  it('defaults to safe when unset', () => {
    expect(parseExposure(undefined)).toBe('safe');
  });

  it.each(['safe', 'all', 'SAFE', ' All '])('accepts %j', (value) => {
    expect(parseExposure(value)).toBe(value.trim().toLowerCase());
  });

  // Fail closed. Guessing that a typo meant "all" would silently unlock
  // arbitrary code execution, which is the one mistake worth being rigid about.
  it.each(['unsafe', 'yes', 'true', '1', 'al', 'everything'])(
    'falls back to safe for the unrecognised value %j',
    (value) => {
      expect(parseExposure(value)).toBe('safe');
    }
  );
});

describe('parseTransport', () => {
  it('defaults to the socket transport when unset', () => {
    expect(parseTransport(undefined)).toBe('socket');
  });

  it.each(['socket', 'spawn', 'SPAWN', ' Socket '])('accepts %j', (value) => {
    expect(parseTransport(value)).toBe(value.trim().toLowerCase());
  });

  // The socket transport falls back to spawn by itself when it cannot
  // connect, so defaulting to it on a typo is safe rather than optimistic.
  it.each(['tcp', 'http', 'fast', '1'])(
    'falls back to socket for the unrecognised value %j',
    (value) => {
      expect(parseTransport(value)).toBe('socket');
    }
  );
});

describe('loadConfig', () => {
  it('reads every key from the supplied environment', () => {
    const config = loadConfig({
      [ENV_KEYS.exposure]: 'all',
      [ENV_KEYS.transport]: 'spawn',
      [ENV_KEYS.hsPath]: '/custom/hs',
      [ENV_KEYS.docsPath]: '/custom/docs.json',
    });
    expect(config).toEqual({
      exposure: 'all',
      transport: 'spawn',
      hsPathOverride: '/custom/hs',
      docsPathOverride: '/custom/docs.json',
    });
  });

  it('defaults to the safe tier with no overrides on an empty environment', () => {
    expect(loadConfig({})).toEqual({
      exposure: 'safe',
      transport: 'socket',
      hsPathOverride: undefined,
      docsPathOverride: undefined,
    });
  });

  it('treats blank and whitespace-only overrides as absent', () => {
    const config = loadConfig({ [ENV_KEYS.hsPath]: '   ', [ENV_KEYS.docsPath]: '' });
    expect(config.hsPathOverride).toBeUndefined();
    expect(config.docsPathOverride).toBeUndefined();
  });

  it('trims surrounding whitespace from paths', () => {
    expect(loadConfig({ [ENV_KEYS.hsPath]: '  /custom/hs  ' }).hsPathOverride).toBe('/custom/hs');
  });
});
