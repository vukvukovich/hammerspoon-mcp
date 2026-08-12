import { describe, expect, it, vi } from 'vitest';

import { HammerspoonBridge, type ExecFn } from '../../../src/bridge/bridge.js';
import { lua } from '../../../src/bridge/lua.js';

const FAKE_HS = '/fake/bin/hs';

function bridgeWith(exec: ExecFn): HammerspoonBridge {
  return new HammerspoonBridge({ hsPathOverride: FAKE_HS, exec });
}

/**
 * Stands in for the hs CLI. The real one prints the result prefixed with the
 * per-call marker the program asks for, so the fake reads that marker out of
 * the program it was handed and does the same. Without it the bridge would
 * correctly reject the reply as unmarked.
 */
function stdout(payload: string): ExecFn {
  return async (_file, args) => {
    const program = args[1] ?? '';
    const marker = /return "([A-Za-z0-9]+)" \.\. __payload/.exec(program)?.[1] ?? '';
    return Promise.resolve({ stdout: `${marker}${payload}`, stderr: '' });
  };
}

/** Typed as Error because that is what child_process actually rejects with. */
function rejectsWith(error: Error): ExecFn {
  return () => Promise.reject(error);
}

/**
 * Concurrency is a correctness property here, not a performance one.
 *
 * Each hs invocation opens its own CFMessagePort. Measured against a real
 * Hammerspoon: 8 simultaneous calls all succeed in milliseconds, 15 drop to 5
 * successes with exit codes 65 and 69, and the same pattern crashed
 * Hammerspoon inside its own IPC layer. MCP clients issue parallel tool calls
 * routinely, so the bridge caps how many run at once.
 */
describe('concurrency gate', () => {
  it('never runs more than the limit at once, however many are requested', async () => {
    let active = 0;
    let peak = 0;

    const exec: ExecFn = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { stdout: `${'x'}`, stderr: '' };
    };

    const bridge = new HammerspoonBridge({ hsPathOverride: FAKE_HS, exec });
    await Promise.all(Array.from({ length: 30 }, async () => bridge.run(lua`return 1`)));

    expect(peak).toBeGreaterThan(1); // still overlaps, not fully serialised
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('runs every queued call rather than dropping any', async () => {
    let started = 0;
    const exec: ExecFn = async () => {
      started += 1;
      await new Promise((resolve) => setTimeout(resolve, 2));
      return { stdout: '', stderr: '' };
    };

    const bridge = new HammerspoonBridge({ hsPathOverride: FAKE_HS, exec });
    await Promise.all(Array.from({ length: 25 }, async () => bridge.run(lua`return 1`)));

    expect(started).toBe(25);
  });

  it('releases its slot when a call fails, so a failure cannot wedge the queue', async () => {
    let calls = 0;
    const exec: ExecFn = async () => {
      calls += 1;
      // Every one rejects. If the gate leaked slots, later calls would hang
      // and this test would time out rather than fail.
      return Promise.reject(Object.assign(new Error('boom'), { stderr: '' }));
    };

    const bridge = new HammerspoonBridge({ hsPathOverride: FAKE_HS, exec });
    const results = await Promise.all(
      Array.from({ length: 12 }, async () => bridge.run(lua`return 1`))
    );

    expect(calls).toBe(12);
    expect(results.every((result) => !result.ok)).toBe(true);
  });
});

describe('HammerspoonBridge.run', () => {
  it('returns the decoded value on success', async () => {
    const bridge = bridgeWith(stdout('{"ok":true,"value":{"count":2}}'));
    const result = await bridge.run(lua`return {}`);
    expect(result).toEqual({ ok: true, value: { count: 2 } });
  });

  it('invokes the binary with an argv array and never a shell string', async () => {
    const exec = vi.fn<ExecFn>(async () => Promise.resolve({ stdout: '{"ok":true}', stderr: '' }));
    const bridge = bridgeWith(exec);
    await bridge.run(lua`return 1`, { app: 'Safari' });

    expect(exec).toHaveBeenCalledTimes(1);
    const [file, args] = exec.mock.calls[0] ?? [];
    expect(file).toBe(FAKE_HS);
    expect(args?.[0]).toBe('-c');
    // The program is one argv element. Arguments live in the base64 blob,
    // so the app name must not appear as literal text in the source.
    expect(args).toHaveLength(2);
    expect(args?.[1]).not.toContain('Safari');
    expect(args?.[1]).toContain('hs.base64.decode');
  });

  it('passes the caller timeout through to the subprocess', async () => {
    const exec = vi.fn<ExecFn>(async () => Promise.resolve({ stdout: '{"ok":true}', stderr: '' }));
    await bridgeWith(exec).run(lua`return 1`, {}, { timeoutMs: 1234 });
    expect(exec.mock.calls[0]?.[2]).toMatchObject({ timeout: 1234 });
  });

  it('surfaces a Lua error as LuaError with its message', async () => {
    const bridge = bridgeWith(stdout('{"ok":false,"err":"no window has id 9"}'));
    const result = await bridge.run(lua`return 1`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('LuaError');
    expect(result.error.message).toBe('no window has id 9');
  });

  it('classifies a missing binary as HsNotFound', async () => {
    const missing = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    const result = await bridgeWith(rejectsWith(missing)).run(lua`return 1`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('HsNotFound');
    expect(result.error.hint).toContain('HS_MCP_HS_PATH');
  });

  it('classifies a killed process as Timeout', async () => {
    const killed = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' });
    const result = await bridgeWith(rejectsWith(killed)).run(lua`return 1`, {}, { timeoutMs: 500 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Timeout');
    expect(result.error.message).toContain('500');
  });

  it.each([
    "can't connect to Hammerspoon",
    'cannot connect to the ipc port',
    'error: failed to connect',
    'Hammerspoon is not running',
  ])('classifies %j on stderr as HsNotRunning', async (stderrText) => {
    const failure = Object.assign(new Error('exit 1'), { stderr: stderrText });
    const result = await bridgeWith(rejectsWith(failure)).run(lua`return 1`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('HsNotRunning');
    expect(result.error.hint).toContain('hs.ipc');
  });

  it('classifies unparseable output with a connection complaint as HsNotRunning', async () => {
    const exec: ExecFn = async () =>
      Promise.resolve({ stdout: 'nonsense', stderr: "can't connect to Hammerspoon" });
    const result = await bridgeWith(exec).run(lua`return 1`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('HsNotRunning');
  });

  it('classifies unexplained unparseable output as ProtocolError', async () => {
    const result = await bridgeWith(stdout('not json at all')).run(lua`return 1`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('ProtocolError');
  });

  it('classifies an unexplained non-zero exit as ProtocolError', async () => {
    const failure = Object.assign(new Error('exit 3'), { stderr: 'something odd' });
    const result = await bridgeWith(rejectsWith(failure)).run(lua`return 1`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('ProtocolError');
  });

  it('reports HsNotFound without executing anything when no binary exists', async () => {
    const exec = vi.fn<ExecFn>();
    const bridge = new HammerspoonBridge({ exec, exists: () => false });
    const result = await bridge.run(lua`return 1`);

    expect(exec).not.toHaveBeenCalled();
    expect(bridge.hsPath).toBeUndefined();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('HsNotFound');
  });

  it('rejects an oversized payload before spawning anything', async () => {
    const exec = vi.fn<ExecFn>();
    const result = await bridgeWith(exec).run(lua`return 1`, { blob: 'x'.repeat(400_000) });

    expect(exec).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('PayloadTooLarge');
  });

  it('exposes the resolved binary path', () => {
    expect(bridgeWith(stdout('{"ok":true}')).hsPath).toBe(FAKE_HS);
  });
});
