import { describe, expect, it, vi } from 'vitest';

import { HammerspoonBridge, type ExecFn } from '../../../src/bridge/bridge.js';

const FAKE_HS = '/fake/bin/hs';

function bridgeWith(exec: ExecFn): HammerspoonBridge {
  return new HammerspoonBridge({ hsPathOverride: FAKE_HS, exec });
}

function stdout(text: string): ExecFn {
  return async () => Promise.resolve({ stdout: text, stderr: '' });
}

/** Typed as Error because that is what child_process actually rejects with. */
function rejectsWith(error: Error): ExecFn {
  return () => Promise.reject(error);
}

describe('HammerspoonBridge.run', () => {
  it('returns the decoded value on success', async () => {
    const bridge = bridgeWith(stdout('{"ok":true,"value":{"count":2}}'));
    const result = await bridge.run('return {}');
    expect(result).toEqual({ ok: true, value: { count: 2 } });
  });

  it('invokes the binary with an argv array and never a shell string', async () => {
    const exec = vi.fn<ExecFn>(async () => Promise.resolve({ stdout: '{"ok":true}', stderr: '' }));
    const bridge = bridgeWith(exec);
    await bridge.run('return 1', { app: 'Safari' });

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
    await bridgeWith(exec).run('return 1', {}, { timeoutMs: 1234 });
    expect(exec.mock.calls[0]?.[2]).toMatchObject({ timeout: 1234 });
  });

  it('surfaces a Lua error as LuaError with its message', async () => {
    const bridge = bridgeWith(stdout('{"ok":false,"err":"no window has id 9"}'));
    const result = await bridge.run('return 1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('LuaError');
    expect(result.error.message).toBe('no window has id 9');
  });

  it('classifies a missing binary as HsNotFound', async () => {
    const missing = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    const result = await bridgeWith(rejectsWith(missing)).run('return 1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('HsNotFound');
    expect(result.error.hint).toContain('HS_MCP_HS_PATH');
  });

  it('classifies a killed process as Timeout', async () => {
    const killed = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' });
    const result = await bridgeWith(rejectsWith(killed)).run('return 1', {}, { timeoutMs: 500 });
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
    const result = await bridgeWith(rejectsWith(failure)).run('return 1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('HsNotRunning');
    expect(result.error.hint).toContain('hs.ipc');
  });

  it('classifies unparseable output with a connection complaint as HsNotRunning', async () => {
    const exec: ExecFn = async () =>
      Promise.resolve({ stdout: 'nonsense', stderr: "can't connect to Hammerspoon" });
    const result = await bridgeWith(exec).run('return 1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('HsNotRunning');
  });

  it('classifies unexplained unparseable output as ProtocolError', async () => {
    const result = await bridgeWith(stdout('not json at all')).run('return 1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('ProtocolError');
  });

  it('classifies an unexplained non-zero exit as ProtocolError', async () => {
    const failure = Object.assign(new Error('exit 3'), { stderr: 'something odd' });
    const result = await bridgeWith(rejectsWith(failure)).run('return 1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('ProtocolError');
  });

  it('reports HsNotFound without executing anything when no binary exists', async () => {
    const exec = vi.fn<ExecFn>();
    const bridge = new HammerspoonBridge({ exec, exists: () => false });
    const result = await bridge.run('return 1');

    expect(exec).not.toHaveBeenCalled();
    expect(bridge.hsPath).toBeUndefined();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('HsNotFound');
  });

  it('rejects an oversized payload before spawning anything', async () => {
    const exec = vi.fn<ExecFn>();
    const result = await bridgeWith(exec).run('return 1', { blob: 'x'.repeat(400_000) });

    expect(exec).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('PayloadTooLarge');
  });

  it('exposes the resolved binary path', () => {
    expect(bridgeWith(stdout('{"ok":true}')).hsPath).toBe(FAKE_HS);
  });
});
