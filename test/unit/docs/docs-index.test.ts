import { describe, expect, it } from 'vitest';

import {
  buildEntries,
  scoreEntry,
  DocsIndex,
  MAX_SEARCH_LIMIT,
  type DocEntry,
} from '../../../src/docs/docs-index.js';

const FIXTURE = new URL('../../fixtures/docs.json', import.meta.url).pathname;

function index(): DocsIndex {
  return new DocsIndex(FIXTURE);
}

function entry(partial: Partial<DocEntry>): DocEntry {
  return {
    qualifiedName: 'hs.window.setFrame',
    module: 'hs.window',
    name: 'setFrame',
    kind: 'Method',
    signature: 'hs.window:setFrame(rect)',
    summary: 'Sets the frame of the window',
    ...partial,
  };
}

describe('buildEntries', () => {
  it('indexes modules themselves, so a module name is findable', () => {
    const entries = buildEntries(JSON.parse('[{"name":"hs.window","desc":"Windows","items":[]}]'));
    expect(entries).toEqual([
      {
        qualifiedName: 'hs.window',
        module: 'hs.window',
        name: 'hs.window',
        kind: 'Module',
        signature: 'hs.window',
        summary: 'Windows',
      },
    ]);
  });

  it('qualifies item names with their module', () => {
    const found = index().search('setFrame');
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.entries[0]?.qualifiedName).toBe('hs.window.setFrame');
  });

  it('falls back to def when signature is absent', () => {
    const found = index().search('hs.window.focusedWindow');
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.entries[0]?.signature).toBe('hs.window.focusedWindow() -> hs.window object');
  });

  it('falls back to the first line of doc when desc is absent', () => {
    const found = index().search('hs.window.focusedWindow');
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    // The second paragraph must not leak into a one-line summary.
    expect(found.entries[0]?.summary).toBe('Returns the window that has keyboard focus');
  });

  it('skips modules and items that have no name', () => {
    const entries = buildEntries(JSON.parse('[{"name":"","items":[{"name":""}]}]'));
    expect(entries).toEqual([]);
  });

  it('returns nothing for input that is not an array', () => {
    expect(buildEntries({ not: 'an array' })).toEqual([]);
    expect(buildEntries(null)).toEqual([]);
  });
});

describe('scoreEntry ranking tiers', () => {
  const target = entry({});

  it('ranks an exact qualified name above everything', () => {
    expect(scoreEntry(target, 'hs.window.setframe', ['hs.window.setframe'])).toBe(1000);
  });

  it('ranks an exact bare name below a qualified match but above prefixes', () => {
    const exact = scoreEntry(target, 'setframe', ['setframe']);
    const prefix = scoreEntry(target, 'hs.window.set', ['hs.window.set']);
    expect(exact).toBeGreaterThan(prefix);
  });

  it('ranks a substring below a prefix', () => {
    const prefix = scoreEntry(target, 'setf', ['setf']);
    const substring = scoreEntry(target, 'window.setf', ['window.setf']);
    expect(prefix).toBeGreaterThan(0);
    expect(substring).toBeGreaterThan(0);
    expect(prefix).toBeGreaterThanOrEqual(substring);
  });

  it('matches prose only when every term is present', () => {
    expect(scoreEntry(target, 'sets frame', ['sets', 'frame'])).toBeGreaterThan(0);
    expect(scoreEntry(target, 'sets bluetooth', ['sets', 'bluetooth'])).toBe(0);
  });

  it('excludes an entry that matches nothing', () => {
    expect(scoreEntry(target, 'totallyunrelated', ['totallyunrelated'])).toBe(0);
  });
});

describe('DocsIndex.search', () => {
  it('puts the exact match first even when other entries also match', () => {
    const found = index().search('hs.window');
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.entries[0]?.qualifiedName).toBe('hs.window');
    expect(found.total).toBeGreaterThan(1);
  });

  it('is case insensitive', () => {
    const lower = index().search('setframe');
    const upper = index().search('SETFRAME');
    expect(lower.ok && upper.ok).toBe(true);
    if (!lower.ok || !upper.ok) return;
    expect(upper.entries[0]?.qualifiedName).toBe(lower.entries[0]?.qualifiedName);
  });

  it('restricts results to a module when asked', () => {
    const found = index().search('show', { module: 'alert' });
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.entries.every((hit) => hit.module === 'hs.alert')).toBe(true);
  });

  it('reports the full match count while returning only the requested page', () => {
    const found = index().search('hs', { limit: 2 });
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.entries).toHaveLength(2);
    expect(found.total).toBeGreaterThan(2);
  });

  it('never returns more than the hard limit', () => {
    const found = index().search('hs', { limit: 999 });
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.entries.length).toBeLessThanOrEqual(MAX_SEARCH_LIMIT);
  });

  it('returns an empty result rather than an error when nothing matches', () => {
    const found = index().search('nonexistentapicall');
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.entries).toEqual([]);
    expect(found.total).toBe(0);
  });

  it('finds an entry by words from its summary', () => {
    const found = index().search('large words');
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.entries[0]?.qualifiedName).toBe('hs.alert.show');
  });

  it('parses the file once and reuses the index', () => {
    const shared = index();
    const first = shared.search('setFrame');
    const second = shared.search('mainScreen');
    expect(first.ok && second.ok).toBe(true);
  });
});

describe('DocsIndex failure handling', () => {
  it('explains where it looked and how to override when the file is missing', () => {
    const found = new DocsIndex('/nonexistent/docs.json').search('anything');
    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.error).toContain('/nonexistent/docs.json');
    expect(found.error).toContain('HS_MCP_DOCS_PATH');
  });

  it('reports a parse failure rather than throwing', () => {
    const notJson = new URL('../../fixtures/not-json.txt', import.meta.url).pathname;
    const found = new DocsIndex(notJson).search('anything');
    expect(found.ok).toBe(false);
  });

  it('falls back to bundle locations when no override is given', () => {
    expect(new DocsIndex().candidates.length).toBeGreaterThan(1);
    expect(new DocsIndex('/custom.json').candidates).toEqual(['/custom.json']);
  });
});
