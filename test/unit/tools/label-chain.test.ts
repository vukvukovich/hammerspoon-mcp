/**
 * The regression guard for #31.
 *
 * hs_ui_press refuses to act when the element's label does not match what the
 * caller read from hs_ui_inspect. That only works if both tools resolve labels
 * identically: the press-side copy once checked three attributes while inspect
 * checked five, so labels sourced from AXHelp or AXPlaceholderValue could
 * never match and the press was refused forever.
 *
 * The lua tag deliberately forbids composing templates from fragments, so the
 * two tools carry byte-identical copies instead, and this test pins them to
 * each other. Editing either copy alone fails here.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC_ROOT = new URL('../../../src/', import.meta.url).pathname;

/**
 * The canonical label-resolution fragment. Byte-for-byte what both
 * accessibility.ts and ui-press.ts must contain. If a deliberate change is
 * made, update all three places: both tools and this constant.
 */
const CANONICAL_FRAGMENT = `local function attr(element, name)
  local ok, value = pcall(function() return element:attributeValue(name) end)
  if ok and type(value) == "string" and value ~= "" then return value end
  return nil
end`;

const CANONICAL_CHAIN = `local function labelOf(element)
  return attr(element, "AXTitle")
    or attr(element, "AXDescription")
    or attr(element, "AXLabel")
    or attr(element, "AXHelp")
    or attr(element, "AXPlaceholderValue")
end`;

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
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

describe('the label-resolution fragment', () => {
  it.each([['src/tools/safe/accessibility.ts'], ['src/tools/unsafe/ui-press.ts']])(
    '%s carries the canonical copy',
    async (relative) => {
      const contents = await readFile(join(SRC_ROOT, '..', relative), 'utf8');
      expect(contents).toContain(CANONICAL_FRAGMENT);
      expect(contents).toContain(CANONICAL_CHAIN);
    }
  );

  it('is never partially copied anywhere else in src', async () => {
    // A third divergent copy is how #31 happened. Any file touching any of
    // the label attributes must carry the full canonical chain - triggering
    // on AXTitle alone would miss a divergent chain that starts lower down.
    const TRIGGERS = [
      '"AXTitle"',
      '"AXDescription"',
      '"AXLabel"',
      '"AXHelp"',
      '"AXPlaceholderValue"',
    ];
    const files = await collectTypeScriptFiles(SRC_ROOT);
    const offenders: string[] = [];

    for (const file of files) {
      const contents = await readFile(file, 'utf8');
      if (!TRIGGERS.some((trigger) => contents.includes(trigger))) continue;
      if (!contents.includes(CANONICAL_FRAGMENT) || !contents.includes(CANONICAL_CHAIN)) {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });
});
