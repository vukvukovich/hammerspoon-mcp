import { describe, expect, it } from 'vitest';

import { candidatePaths, resolveHsPath } from '../../../src/bridge/hs-path.js';

const HOME = '/Users/tester';

describe('candidatePaths', () => {
  it('probes both Homebrew prefixes, because Apple Silicon and Intel differ', () => {
    const paths = candidatePaths(HOME);
    expect(paths).toContain('/opt/homebrew/bin/hs');
    expect(paths).toContain('/usr/local/bin/hs');
  });

  it('prefers the user symlink over the application bundle', () => {
    const paths = candidatePaths(HOME);
    const symlink = paths.indexOf(`${HOME}/.local/bin/hs`);
    const bundle = paths.indexOf('/Applications/Hammerspoon.app/Contents/Frameworks/hs/hs');
    expect(symlink).toBeGreaterThanOrEqual(0);
    expect(bundle).toBeGreaterThan(symlink);
  });
});

describe('resolveHsPath', () => {
  it('trusts an explicit override without touching the filesystem', () => {
    const lookup = resolveHsPath({
      override: '/custom/hs',
      exists: () => {
        throw new Error('should not probe when an override is given');
      },
    });
    expect(lookup).toEqual({ found: true, path: '/custom/hs', source: 'env' });
  });

  it.each([undefined, '', '   '])('ignores a blank override (%j) and probes', (override) => {
    const lookup = resolveHsPath({
      override,
      home: HOME,
      exists: (path) => path === '/opt/homebrew/bin/hs',
    });
    expect(lookup).toEqual({ found: true, path: '/opt/homebrew/bin/hs', source: 'probe' });
  });

  it('returns the first existing candidate in priority order', () => {
    const lookup = resolveHsPath({
      home: HOME,
      // Both exist. The earlier candidate must win.
      exists: (path) => path === `${HOME}/.local/bin/hs` || path === '/usr/local/bin/hs',
    });
    expect(lookup).toMatchObject({ found: true, path: `${HOME}/.local/bin/hs` });
  });

  it('reports every path it searched when nothing is found', () => {
    const lookup = resolveHsPath({ home: HOME, exists: () => false });
    expect(lookup.found).toBe(false);
    if (lookup.found) return;
    expect(lookup.searched).toEqual(candidatePaths(HOME));
  });
});
