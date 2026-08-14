/**
 * The fake-bridge and handler-capture harness shared by the unit tests that
 * exercise tool handlers (handlers.test.ts, applescript.test.ts). One copy,
 * for the same reason src-walker.ts exists: when registerTool's signature or
 * the result shape changes, two private copies drift silently.
 */

import { vi } from 'vitest';

import type { HammerspoonBridge } from '../../../src/bridge/bridge.js';
import type { BridgeResult } from '../../../src/bridge/errors.js';
import { DocsIndex } from '../../../src/docs/docs-index.js';
import { ALL_TOOLS } from '../../../src/tools/index.js';
import type { ToolContext } from '../../../src/tools/registry.js';

export type CapturedCall = { lua: string; args: unknown; options: unknown };
export type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

/** Parses the JSON payload a tool result carries in its first text block. */
export function payloadOf<T>(result: ToolResult): T {
  return JSON.parse(result.content[0]?.text ?? '{}') as T;
}

export const stubDocs = new DocsIndex('/nonexistent/docs.json');

export function fakeBridge(result: BridgeResult<unknown>): {
  bridge: HammerspoonBridge;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const bridge = {
    hsPath: '/fake/hs',
    run: vi.fn(async (lua: string, args?: unknown, options?: unknown) => {
      calls.push({ lua, args, options });
      return Promise.resolve(result);
    }),
  };
  return { bridge: bridge as unknown as HammerspoonBridge, calls };
}

/** Pulls the handler back out of a tool by registering it against a stub server. */
export function handlerFor(
  name: string,
  context: ToolContext
): (args: unknown, ctx: unknown) => Promise<ToolResult> {
  const tool = ALL_TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`no tool named ${name}`);

  let captured: ((args: unknown, ctx: unknown) => Promise<ToolResult>) | undefined;
  const server = {
    registerTool: (
      _name: string,
      _config: unknown,
      handler: (args: unknown, ctx: unknown) => Promise<ToolResult>
    ) => {
      captured = handler;
    },
  };
  tool.register(server as never, context);

  if (captured === undefined) throw new Error(`${name} did not register a handler`);
  return captured;
}
