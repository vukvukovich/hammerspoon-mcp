/**
 * Tests the real subprocess wrapper.
 *
 * The child here is Node itself rather than Hammerspoon, so these run
 * anywhere, including CI. What is under test is the spawn plumbing (stdin
 * handling, timeout, exit codes, output capture), not anything Hammerspoon
 * specific.
 */

import { describe, expect, it } from 'vitest';

import { HammerspoonBridge, spawnExec } from '../../../src/bridge/bridge.js';
import { lua } from '../../../src/bridge/lua.js';

/** Drives the private defaultExec by pointing the bridge at the node binary. */
function nodeBridge(): HammerspoonBridge {
  return new HammerspoonBridge({ hsPathOverride: process.execPath });
}

/**
 * The bridge always passes ['-c', program]. Node treats -c as --check (syntax
 * check only), which exits 0 and prints nothing for valid source. That is
 * enough to exercise the spawn path end to end.
 */
describe('the real subprocess path', () => {
  it('completes without hanging, which proves stdin is closed', async () => {
    // Regression guard for the bug that made every call time out: the hs CLI
    // waits for EOF on stdin, so an inherited open pipe blocks forever. If
    // this test starts timing out, stdin handling regressed.
    const started = Date.now();
    const result = await nodeBridge().run(lua`1 + 1`, {}, { timeoutMs: 5000 });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(4000);
    // Node prints nothing, so there is no envelope to parse. Reaching a
    // ProtocolError means the process ran and exited cleanly.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('ProtocolError');
  });

  it('reports a missing binary as HsNotFound', async () => {
    const bridge = new HammerspoonBridge({
      hsPathOverride: '/nonexistent/definitely/not/hs',
    });
    const result = await bridge.run(lua`return 1`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('HsNotFound');
  });

  it('reports a non-zero exit as ProtocolError', async () => {
    // Invalid syntax makes node --check exit non-zero.
    const result = await nodeBridge().run(
      lua`this is (not valid javascript`,
      {},
      { timeoutMs: 5000 }
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('ProtocolError');
  });

  // A timed-out child is deliberately NOT killed at the deadline: its message
  // port must survive long enough to receive Hammerspoon's late reply, or
  // Hammerspoon crashes replying into a dead port (#13, #16). The caller is
  // unblocked at the deadline; the child is reaped after the linger.
  it('rejects at the deadline without waiting for the child', async () => {
    // Driven directly, because the bridge always sends ['-c', program] and no
    // useful binary blocks on that shape.
    const started = Date.now();
    await expect(
      spawnExec('/bin/sleep', ['30'], { timeout: 300, maxBuffer: 1024, lingerMs: 200 })
    ).rejects.toMatchObject({ killed: true, signal: 'SIGTERM' });

    // The rejection must arrive at the deadline, not after the child dies.
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('reaps a lingering child after the linger period, so nothing leaks', async () => {
    const marker = `linger-reap-probe-${String(process.pid)}`;
    const stubborn = `process.title=${JSON.stringify(marker)}; setInterval(() => {}, 1000); // ${marker}`;

    await expect(
      spawnExec(process.execPath, ['-e', stubborn], {
        timeout: 300,
        maxBuffer: 1024,
        lingerMs: 200,
      })
    ).rejects.toMatchObject({ killed: true });

    // SIGTERM lands after ~lingerMs and node dies of it; poll until gone.
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);
    const gone = async (): Promise<boolean> => {
      try {
        await exec('/usr/bin/pgrep', ['-f', marker]);
        return false;
      } catch {
        return true;
      }
    };
    const deadline = Date.now() + 8000;
    while (!(await gone()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(await gone()).toBe(true);
  }, 15_000);

  // Lingering children hold real message-port connections, so they carry
  // their own ceiling: when one too many would linger, the oldest is evicted
  // (#20). Six children time out with a long linger; at most four survive.
  it('bounds the number of lingering children by evicting the oldest', async () => {
    const marker = `linger-pool-probe-${String(process.pid)}`;
    const spawnLingering = (index: number) =>
      spawnExec(
        process.execPath,
        ['-e', `setInterval(() => {}, 1000); // ${marker}-${String(index)}`],
        { timeout: 200, maxBuffer: 1024, lingerMs: 10_000 }
      ).catch(() => undefined);

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);
    const aliveCount = async (): Promise<number> => {
      try {
        const { stdout } = await exec('/usr/bin/pgrep', ['-f', marker]);
        return stdout.trim().split('\n').filter(Boolean).length;
      } catch {
        return 0;
      }
    };

    try {
      await Promise.all([0, 1, 2, 3, 4, 5].map(spawnLingering));
      // Evicted children get SIGTERM immediately and node dies of it; give
      // the signals a moment to land before counting.
      const deadline = Date.now() + 5000;
      let count = await aliveCount();
      while (count > 4 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        count = await aliveCount();
      }
      expect(count).toBeLessThanOrEqual(4);
      expect(count).toBeGreaterThan(0);
    } finally {
      await exec('/usr/bin/pkill', ['-f', marker]).catch(() => undefined);
    }
  }, 15_000);

  // SIGTERM is catchable. A child that ignores it never emits 'close', so
  // without escalation it would live past the linger forever. SIGKILL cannot
  // be caught. The promise itself settles at the deadline either way; what
  // this proves is that the escalation still reaps the child afterwards.
  it('escalates to SIGKILL when a lingering child ignores SIGTERM', async () => {
    const marker = `sigkill-escalation-probe-${String(process.pid)}`;
    const stubborn = `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); // ${marker}`;

    await expect(
      spawnExec(process.execPath, ['-e', stubborn], {
        timeout: 300,
        maxBuffer: 1024,
        lingerMs: 200,
      })
    ).rejects.toMatchObject({ killed: true });

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);
    const gone = async (): Promise<boolean> => {
      try {
        await exec('/usr/bin/pgrep', ['-f', marker]);
        return false;
      } catch {
        return true;
      }
    };
    // linger 200ms + SIGTERM ignored + 2s SIGKILL grace: dead well inside 8s.
    const deadline = Date.now() + 8000;
    while (!(await gone()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(await gone()).toBe(true);
  }, 15_000);

  it('captures stdout from a successful child', async () => {
    const result = await spawnExec(process.execPath, ['-e', 'console.log("hello")'], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    expect(result.stdout.trim()).toBe('hello');
    expect(result.stderr).toBe('');
  });

  // A pipe splits on byte boundaries, so a multi-byte character can land half
  // in one chunk and half in the next. Decoding each chunk on its own turns it
  // into replacement characters, which for this server means a corrupted JSON
  // envelope and a bogus ProtocolError. The child below writes one byte at a
  // time to force the split deterministically.
  it('reassembles multi-byte characters split across chunk boundaries', async () => {
    const payload = 'ok 🚀 café done';
    const script = `
const b = Buffer.from(${JSON.stringify(payload)}, 'utf8');
let i = 0;
const tick = () => {
  if (i < b.length) { process.stdout.write(b.subarray(i, i + 1)); i += 1; setTimeout(tick, 1); }
};
tick();
`;
    const result = await spawnExec(process.execPath, ['-e', script], {
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });

    expect(result.stdout).toBe(payload);
    expect(result.stdout).not.toContain('�');
  });

  it('captures stderr separately from stdout', async () => {
    const result = await spawnExec(process.execPath, ['-e', 'console.error("warned")'], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe('warned');
  });

  it('rejects with the exit code and stderr when the child fails', async () => {
    await expect(
      spawnExec(process.execPath, ['-e', 'console.error("nope"); process.exit(3)'], {
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      })
    ).rejects.toMatchObject({ exitCode: 3, stderr: expect.stringContaining('nope') as unknown });
  });

  it('kills a child that floods stdout past the output limit', async () => {
    await expect(
      spawnExec(process.execPath, ['-e', 'while (true) console.log("x".repeat(1000))'], {
        timeout: 10_000,
        maxBuffer: 4096,
      })
    ).rejects.toThrow(/exceeded/i);
  });
});
