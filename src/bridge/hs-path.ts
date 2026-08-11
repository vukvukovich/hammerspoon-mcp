/**
 * Locating the `hs` command line tool.
 *
 * Hammerspoon ships `hs` inside its application bundle and users may also
 * symlink it onto their PATH via hs.ipc.cliInstall(). Homebrew on Apple
 * Silicon and Intel use different prefixes, so all the usual locations are
 * probed rather than assuming one.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Probed in order. The first path that exists wins. */
export function candidatePaths(home: string = homedir()): readonly string[] {
  return [
    join(home, '.local/bin/hs'),
    '/opt/homebrew/bin/hs',
    '/usr/local/bin/hs',
    '/Applications/Hammerspoon.app/Contents/Frameworks/hs/hs',
    join(home, 'Applications/Hammerspoon.app/Contents/Frameworks/hs/hs'),
  ];
}

export type HsPathLookup =
  | { readonly found: true; readonly path: string; readonly source: 'env' | 'probe' }
  | { readonly found: false; readonly searched: readonly string[] };

export type ResolveHsPathOptions = {
  /** Explicit override, normally from HS_MCP_HS_PATH. */
  readonly override?: string | undefined;
  /** Injected for tests. */
  readonly exists?: (path: string) => boolean;
  readonly home?: string;
};

/**
 * An explicit override is trusted without probing the filesystem: the user
 * asked for that exact binary, and a clear "not found" at execution time beats
 * silently falling back to a different one.
 */
export function resolveHsPath(options: ResolveHsPathOptions = {}): HsPathLookup {
  const exists = options.exists ?? existsSync;
  const override = options.override?.trim();

  if (override !== undefined && override !== '') {
    return { found: true, path: override, source: 'env' };
  }

  const candidates = candidatePaths(options.home ?? homedir());
  for (const candidate of candidates) {
    if (exists(candidate)) {
      return { found: true, path: candidate, source: 'probe' };
    }
  }

  return { found: false, searched: candidates };
}
