import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  defineTool,
  errorResult,
  fromBridge,
  jsonResult,
  textResult,
} from '../../../src/tools/registry.js';
import type { HammerspoonBridge } from '../../../src/bridge/bridge.js';
import { DocsIndex } from '../../../src/docs/docs-index.js';

import type { McpServer } from '@modelcontextprotocol/server';

const stubDocs = new DocsIndex('/nonexistent/docs.json');
const stubBridge = { hsPath: '/fake/hs', run: vi.fn() } as unknown as HammerspoonBridge;

/**
 * Minimal stand-in for the SDK server. Built through an unknown-typed local
 * rather than an inline cast, which the lint rules forbid on object literals.
 */
function stubServer(registerTool: ReturnType<typeof vi.fn>): McpServer {
  const server: unknown = { registerTool };
  return server as McpServer;
}

describe('defineTool', () => {
  it('passes name, title, description, and schema to the server', () => {
    const registerTool = vi.fn();
    const tool = defineTool({
      name: 'hs_example',
      tier: 'safe',
      title: 'Example',
      description: 'An example tool.',
      inputSchema: z.object({ value: z.string() }),
      handler: async () => Promise.resolve(textResult('ok')),
    });

    tool.register(stubServer(registerTool), { bridge: stubBridge, docs: stubDocs });

    expect(registerTool).toHaveBeenCalledTimes(1);
    const [name, config] = registerTool.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe('hs_example');
    expect(config['title']).toBe('Example');
    expect(config['description']).toBe('An example tool.');
    expect(config['inputSchema']).toBeDefined();
  });

  it('omits annotations entirely when none are declared', () => {
    const registerTool = vi.fn();
    defineTool({
      name: 'hs_plain',
      tier: 'safe',
      title: 'Plain',
      description: 'No annotations.',
      inputSchema: z.object({}),
      handler: async () => Promise.resolve(textResult('ok')),
    }).register(stubServer(registerTool), { bridge: stubBridge, docs: stubDocs });

    const [, config] = registerTool.mock.calls[0] as [string, Record<string, unknown>];
    expect('annotations' in config).toBe(false);
  });

  it('forwards declared annotations', () => {
    const registerTool = vi.fn();
    defineTool({
      name: 'hs_annotated',
      tier: 'safe',
      title: 'Annotated',
      description: 'Has hints.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
      handler: async () => Promise.resolve(textResult('ok')),
    }).register(stubServer(registerTool), { bridge: stubBridge, docs: stubDocs });

    const [, config] = registerTool.mock.calls[0] as [string, Record<string, unknown>];
    expect(config['annotations']).toEqual({ readOnlyHint: true });
  });

  it('exposes the tier without registering it as server-side metadata', () => {
    const registerTool = vi.fn();
    const tool = defineTool({
      name: 'hs_tiered',
      tier: 'unsafe',
      title: 'Tiered',
      description: 'Gated.',
      inputSchema: z.object({}),
      handler: async () => Promise.resolve(textResult('ok')),
    });
    expect(tool.tier).toBe('unsafe');

    tool.register(stubServer(registerTool), { bridge: stubBridge, docs: stubDocs });
    const [, config] = registerTool.mock.calls[0] as [string, Record<string, unknown>];
    // The tier governs whether we register at all. It is not part of the wire
    // contract, so it must not leak into the tool description.
    expect(config['tier']).toBeUndefined();
  });

  it('gives the handler the context it was registered with', async () => {
    const registerTool = vi.fn();
    const handler = vi.fn(async () => Promise.resolve(textResult('done')));
    defineTool({
      name: 'hs_context',
      tier: 'safe',
      title: 'Context',
      description: 'Checks context.',
      inputSchema: z.object({ a: z.string() }),
      handler,
    }).register(stubServer(registerTool), { bridge: stubBridge, docs: stubDocs });

    const registered = registerTool.mock.calls[0]?.[2] as (
      a: unknown,
      c: unknown
    ) => Promise<unknown>;
    await registered({ a: 'x' }, {});

    expect(handler).toHaveBeenCalledWith({ a: 'x' }, { bridge: stubBridge, docs: stubDocs });
  });
});

describe('result helpers', () => {
  it('textResult produces a single text block and no error flag', () => {
    expect(textResult('hello')).toEqual({ content: [{ type: 'text', text: 'hello' }] });
  });

  it('errorResult marks the result as an error', () => {
    expect(errorResult('bad')).toEqual({
      content: [{ type: 'text', text: 'bad' }],
      isError: true,
    });
  });

  it('jsonResult pretty prints so the model can read nested output', () => {
    const result = jsonResult({ a: { b: 1 } });
    expect(result.content[0]).toMatchObject({ type: 'text' });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('\n');
    expect(JSON.parse(text)).toEqual({ a: { b: 1 } });
  });
});

describe('fromBridge', () => {
  it('renders a success value as JSON by default', () => {
    const result = fromBridge({ ok: true, value: { count: 3 } });
    expect(result.isError).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toContain('"count": 3');
  });

  it('uses a custom renderer when one is supplied', () => {
    const result = fromBridge({ ok: true, value: 'raw' }, (value) =>
      textResult(`seen ${String(value)}`)
    );
    expect((result.content[0] as { text: string }).text).toBe('seen raw');
  });

  it('renders a failure with both the message and the hint', () => {
    const result = fromBridge({
      ok: false,
      error: { kind: 'Timeout', message: 'took too long', hint: 'try a smaller call' },
    });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Timeout');
    expect(text).toContain('took too long');
    expect(text).toContain('try a smaller call');
  });
});
