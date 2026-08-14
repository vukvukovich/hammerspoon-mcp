/**
 * Tool definition and registration.
 *
 * Every tool declares a tier. The server registers only the tiers the current
 * configuration exposes, so a gated tool is absent from tools/list entirely
 * rather than present and refusing. An agent cannot be talked into calling a
 * tool that was never advertised.
 *
 * `defineTool` exists so each tool file keeps its own precise schema type while
 * the server can still hold a homogeneous array of them. The generic is
 * captured inside the closure and erased at the boundary.
 */

import type { McpServer, CallToolResult } from '@modelcontextprotocol/server';
import type { z } from 'zod';

import type { HammerspoonBridge } from '../bridge/bridge.js';
import { formatBridgeError, type BridgeResult } from '../bridge/errors.js';
import type { DocsIndex } from '../docs/docs-index.js';

export type ToolTier = 'safe' | 'unsafe';

export type ToolContext = {
  readonly bridge: HammerspoonBridge;
  /** Hammerspoon's bundled API reference. Read directly, never through the bridge. */
  readonly docs: DocsIndex;
};

export type ToolDefinition<TShape extends z.ZodRawShape> = {
  /** Wire name, snake_case with an hs_ prefix. */
  readonly name: string;
  readonly tier: ToolTier;
  /** Human-friendly label shown in client tool pickers. */
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodObject<TShape>;
  /**
   * Hints for the client. `readOnlyHint` matters here: it tells the client
   * which tools cannot change machine state, which some clients use to decide
   * what may run without a prompt.
   */
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
  readonly handler: (
    args: z.infer<z.ZodObject<TShape>>,
    context: ToolContext
  ) => Promise<CallToolResult>;
};

/** A tool with its schema type erased, ready to be put in a list. */
export type RegisterableTool = {
  readonly name: string;
  readonly tier: ToolTier;
  readonly register: (server: McpServer, context: ToolContext) => void;
};

export function defineTool<TShape extends z.ZodRawShape>(
  definition: ToolDefinition<TShape>
): RegisterableTool {
  return {
    name: definition.name,
    tier: definition.tier,
    register: (server, context) => {
      server.registerTool(
        definition.name,
        {
          title: definition.title,
          description: definition.description,
          inputSchema: definition.inputSchema,
          ...(definition.annotations === undefined ? {} : { annotations: definition.annotations }),
        },
        async (args) => definition.handler(args, context)
      );
    },
  };
}

/** Text payload helper. Tool output is text; structured data is JSON inside it. */
export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

export function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export function jsonResult(value: unknown): CallToolResult {
  return textResult(JSON.stringify(value, null, 2));
}

/**
 * Standard mapping from a bridge outcome to a tool result.
 *
 * Failures come back as `isError` with the actionable hint attached, so the
 * agent can usually fix the problem itself (start Hammerspoon, load hs.ipc)
 * instead of reporting an opaque failure.
 */
export function fromBridge(
  result: BridgeResult<unknown>,
  render: (value: unknown) => CallToolResult = jsonResult
): CallToolResult {
  if (result.ok) {
    // A value Lua could not encode arrives as its tostring form, which is
    // indistinguishable from a genuine string ("table: 0x...") unless it is
    // labelled. Saying so beats handing back a pointer as though it were the
    // answer (#29). The tool's own renderer is bypassed here on purpose: it
    // was written to shape a real value, and there is not one.
    if (result.unencodable === true) {
      return jsonResult({
        value: result.value,
        encodable: false,
        hint: 'Lua could not represent this value as JSON, so only its tostring form is shown. Cyclic tables, tables mixing array and named keys, functions, and userdata handles all do this. Return specific fields instead, for example the id or name you need.',
      });
    }
    return render(result.value);
  }
  return errorResult(formatBridgeError(result.error));
}
