/**
 * Search over Hammerspoon's own API reference.
 *
 * Hammerspoon ships its complete documentation inside the application bundle
 * as docs.json (roughly 7MB, 140 modules, about 2000 entries). Reading it
 * locally means an agent can look up an exact signature instead of guessing at
 * an API and finding out from a runtime error. No network access is involved.
 *
 * The file is parsed once on first use and reduced to a flat entry list. The
 * parsed JSON is discarded afterwards: the index is a few hundred kilobytes,
 * while the raw document is megabytes of prose we do not need to keep.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** One documented function, method, constant, or module. */
export type DocEntry = {
  /** Fully qualified, for example "hs.window.setFrame". */
  readonly qualifiedName: string;
  readonly module: string;
  readonly name: string;
  /** Function, Method, Constructor, Constant, Variable, Field, Deprecated, or Module. */
  readonly kind: string;
  /** Call signature as documented, for example "hs.window:setFrame(rect[, duration])". */
  readonly signature: string;
  /** One-line summary. */
  readonly summary: string;
};

export type DocsSearchOptions = {
  readonly module?: string | undefined;
  readonly limit?: number | undefined;
};

export type DocsLookup =
  | { readonly ok: true; readonly entries: readonly DocEntry[]; readonly total: number }
  | { readonly ok: false; readonly error: string };

export const DEFAULT_DOCS_PATHS: readonly string[] = [
  '/Applications/Hammerspoon.app/Contents/Resources/docs.json',
  join(homedir(), 'Applications/Hammerspoon.app/Contents/Resources/docs.json'),
];

export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 25;

/** Shape of the parts of docs.json this reads. Everything else is ignored. */
type RawItem = {
  name?: unknown;
  signature?: unknown;
  def?: unknown;
  type?: unknown;
  desc?: unknown;
  doc?: unknown;
};

type RawModule = {
  name?: unknown;
  desc?: unknown;
  doc?: unknown;
  items?: unknown;
};

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The first line of the long-form doc, used when a short desc is absent. */
function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? '';
}

export function buildEntries(parsed: unknown): DocEntry[] {
  if (!Array.isArray(parsed)) return [];
  const entries: DocEntry[] = [];

  for (const rawModule of parsed as RawModule[]) {
    const moduleName = asString(rawModule.name);
    if (moduleName === '') continue;

    // The module itself is searchable, so "window" finds hs.window and not
    // only the members inside it.
    entries.push({
      qualifiedName: moduleName,
      module: moduleName,
      name: moduleName,
      kind: 'Module',
      signature: moduleName,
      summary: asString(rawModule.desc) || firstLine(asString(rawModule.doc)),
    });

    const items = Array.isArray(rawModule.items) ? (rawModule.items as RawItem[]) : [];
    for (const item of items) {
      const itemName = asString(item.name);
      if (itemName === '') continue;

      const signature =
        asString(item.signature) || asString(item.def) || `${moduleName}.${itemName}`;
      entries.push({
        qualifiedName: `${moduleName}.${itemName}`,
        module: moduleName,
        name: itemName,
        kind: asString(item.type) || 'Unknown',
        signature,
        summary: asString(item.desc) || firstLine(asString(item.doc)),
      });
    }
  }

  return entries;
}

/**
 * Relevance score. Higher wins, zero excludes.
 *
 * The tiers are deliberately coarse and ordered by how confident an exact
 * reading of the query makes us: an exact qualified name beats a prefix, which
 * beats a substring, which beats a match found only in prose.
 */
export function scoreEntry(entry: DocEntry, query: string, terms: readonly string[]): number {
  const qualified = entry.qualifiedName.toLowerCase();
  const name = entry.name.toLowerCase();

  if (qualified === query) return 1000;
  if (name === query) return 900;
  if (qualified.startsWith(query)) return 700;
  if (name.startsWith(query)) return 600;
  if (qualified.includes(query)) return 400;

  // Multi-word queries fall back to prose, requiring every term to appear
  // somewhere. Requiring all of them keeps "window frame" from returning
  // everything that merely mentions windows.
  const haystack = `${qualified} ${entry.summary.toLowerCase()}`;
  if (terms.length > 0 && terms.every((term) => haystack.includes(term))) return 200;

  return 0;
}

export class DocsIndex {
  readonly #override: string | undefined;
  #entries: readonly DocEntry[] | undefined;
  #loadError: string | undefined;

  constructor(override?: string) {
    this.#override = override;
  }

  /** Candidate locations, in probe order. */
  get candidates(): readonly string[] {
    return this.#override === undefined ? DEFAULT_DOCS_PATHS : [this.#override];
  }

  /** Parses on first call and caches. Later calls reuse the built index. */
  #load(): readonly DocEntry[] | undefined {
    if (this.#entries !== undefined) return this.#entries;
    if (this.#loadError !== undefined) return undefined;

    const found = this.candidates.find((candidate) => existsSync(candidate));
    if (found === undefined) {
      this.#loadError =
        `Could not find the Hammerspoon documentation. Looked in: ${this.candidates.join(', ')}. ` +
        'Set HS_MCP_DOCS_PATH if Hammerspoon is installed somewhere else.';
      return undefined;
    }

    try {
      const entries = buildEntries(JSON.parse(readFileSync(found, 'utf8')));
      if (entries.length === 0) {
        this.#loadError = `The documentation at ${found} parsed but contained no entries.`;
        return undefined;
      }
      this.#entries = entries;
      return entries;
    } catch (cause) {
      this.#loadError = `Could not read the documentation at ${found}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`;
      return undefined;
    }
  }

  search(query: string, options: DocsSearchOptions = {}): DocsLookup {
    const entries = this.#load();
    if (entries === undefined) {
      return { ok: false, error: this.#loadError ?? 'The documentation index is unavailable.' };
    }

    const normalised = query.trim().toLowerCase();
    const terms = normalised.split(/\s+/).filter((term) => term.length > 0);
    const moduleFilter = options.module?.trim().toLowerCase();
    const limit = Math.min(options.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);

    const scored: { entry: DocEntry; score: number }[] = [];
    for (const entry of entries) {
      if (moduleFilter !== undefined && moduleFilter !== '') {
        if (!entry.module.toLowerCase().includes(moduleFilter)) continue;
      }
      const score = scoreEntry(entry, normalised, terms);
      if (score > 0) scored.push({ entry, score });
    }

    scored.sort((left, right) =>
      right.score === left.score
        ? left.entry.qualifiedName.localeCompare(right.entry.qualifiedName)
        : right.score - left.score
    );

    return {
      ok: true,
      entries: scored.slice(0, limit).map((hit) => hit.entry),
      total: scored.length,
    };
  }
}
