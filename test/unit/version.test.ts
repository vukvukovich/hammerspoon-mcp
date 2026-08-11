import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { SERVER_NAME, SERVER_VERSION } from '../../src/version.js';

/**
 * The version is hardcoded so it does not depend on resolving package.json at
 * runtime, which is fragile across install layouts. This test is what keeps
 * the constant honest.
 */
describe('server version', () => {
  it('matches the version in package.json', async () => {
    const manifestUrl = new URL('../../package.json', import.meta.url);
    const manifest = JSON.parse(await readFile(manifestUrl, 'utf8')) as {
      name: string;
      version: string;
    };

    expect(SERVER_VERSION).toBe(manifest.version);
    // The wire name is the unscoped one: clients display it, and the npm scope
    // is a distribution detail rather than part of the server identity.
    expect(manifest.name.endsWith(SERVER_NAME)).toBe(true);
  });

  it('is a semantic version', () => {
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });
});
