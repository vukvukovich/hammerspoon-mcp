/**
 * The source-tree walk shared by the meta-tests that audit every file under
 * src/ (lua-safety, label-chain). One copy, so a change to the walk rules
 * cannot leave one auditor silently covering a different file set.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const SRC_ROOT = new URL('../../../src/', import.meta.url).pathname;

export async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) return collectTypeScriptFiles(full);
      return entry.name.endsWith('.ts') ? [full] : [];
    })
  );
  return files.flat();
}
