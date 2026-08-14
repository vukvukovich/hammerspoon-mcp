import { z } from 'zod';

import { defineTool, fromBridge } from '../registry.js';
import { lua } from '../../bridge/lua.js';

/**
 * Arbitrary Lua evaluation. Gated behind HS_MCP_TOOLS=all.
 *
 * Note that even here the supplied code is NOT spliced into the program. It
 * arrives in ARGS like every other argument and is compiled with load(). That
 * keeps the codec invariant absolute: no tool in this codebase builds Lua by
 * string concatenation, without exception. It also means a syntax error is
 * reported cleanly instead of corrupting the surrounding program.
 *
 * The security boundary is the tier, not the encoding. Anything Hammerspoon
 * can do, this tool can do.
 *
 * Only the first returned value survives (#30). `pcall` hands back every
 * value, but the codec's wrapper binds one, and packing them into an array
 * instead would make the result shape depend on how many values a body
 * happened to return, which is worse than a documented truncation. The
 * description tells callers to wrap several values in a table.
 */
const EVAL_LUA = lua`
local chunk, compileError = load(ARGS.code, "hs_eval", "t")
if not chunk then error("syntax error: " .. tostring(compileError), 0) end
return chunk()
`;

/** Evaluation may legitimately take longer than a simple query. */
const MAX_EVAL_TIMEOUT_MS = 30_000;

export const evalTool = defineTool({
  name: 'hs_eval',
  tier: 'unsafe',
  title: 'Evaluate Lua in Hammerspoon',
  description:
    'Run arbitrary Lua inside the running Hammerspoon instance and return the result. Use `return` to produce a value. Only the FIRST returned value comes back, so wrap several in a table: `local ok, err = pcall(f) return { ok = ok, err = err }`. A value with no JSON form (a cyclic table, a table mixing array and named keys, a function, a userdata handle) comes back as its tostring form with encodable=false, so return the specific fields you need instead. This has full access to the machine, so prefer a specific tool when one exists.',
  inputSchema: z.object({
    code: z
      .string()
      .min(1)
      .max(100_000)
      .describe('Lua source. Use a return statement to produce a value.'),
    timeoutMs: z
      .number()
      .int()
      .min(100)
      .max(MAX_EVAL_TIMEOUT_MS)
      .default(10_000)
      .describe('Abort if Hammerspoon has not answered within this many milliseconds.'),
  }),
  annotations: { destructiveHint: true, openWorldHint: true },
  handler: async (args, { bridge }) =>
    fromBridge(await bridge.run(EVAL_LUA, { code: args.code }, { timeoutMs: args.timeoutMs })),
});
