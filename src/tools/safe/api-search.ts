import { z } from 'zod';

import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from '../../docs/docs-index.js';
import { defineTool, errorResult, jsonResult } from '../registry.js';

/**
 * The only tool that does not touch the bridge. It reads Hammerspoon's bundled
 * documentation directly, so it works even when Hammerspoon is not running,
 * which is exactly when someone is most likely writing configuration.
 */
export const apiSearchTool = defineTool({
  name: 'hs_api_search',
  tier: 'safe',
  title: 'Search the Hammerspoon API',
  description:
    "Search Hammerspoon's own API documentation for functions, methods, constants, and modules. Returns exact signatures. Use this before writing Lua so calls are correct the first time, rather than discovering a wrong name from a runtime error.",
  inputSchema: z.object({
    query: z
      .string()
      .min(2)
      .max(100)
      .describe(
        'What to look for. A qualified name like "hs.window.setFrame", a bare name like "setFrame", or words to match against summaries like "screen frame".'
      ),
    module: z
      .string()
      .min(1)
      .max(60)
      .optional()
      .describe('Restrict results to modules whose name contains this, for example "window".'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_SEARCH_LIMIT)
      .default(DEFAULT_SEARCH_LIMIT)
      .describe('Maximum number of results.'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (args, { docs }) => {
    const found = docs.search(args.query, { module: args.module, limit: args.limit });
    if (!found.ok) return Promise.resolve(errorResult(found.error));

    if (found.entries.length === 0) {
      return Promise.resolve(
        errorResult(
          `No documentation matched "${args.query}". Try a shorter query, a bare name without the module prefix, or drop the module filter.`
        )
      );
    }

    return Promise.resolve(
      jsonResult({
        query: args.query,
        totalMatches: found.total,
        showing: found.entries.length,
        results: found.entries,
      })
    );
  },
});
