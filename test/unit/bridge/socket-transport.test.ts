/**
 * The persistent-socket transport against a fake listener.
 *
 * The listener here is a real Unix domain socket served by Node, speaking the
 * line protocol, so framing, timeouts, fallback, and reconnection are all
 * exercised without a Hammerspoon in the room. What it cannot prove — that
 * the bootstrap Lua actually installs a working listener — is covered by the
 * integration suite, which runs the whole bridge over this transport.
 */

import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSocketExec } from '../../../src/bridge/socket-transport.js';

import type { ExecFn, ExecResult } from '../../../src/bridge/bridge.js';

let counter = 0;
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function testSocketPath(): string {
  counter += 1;
  return join(tmpdir(), `hsmcp-ut-${String(process.pid)}-${String(counter)}.sock`);
}

type FakeListener = {
  readonly server: Server;
  /** Programs received, decoded from base64. */
  readonly received: string[];
  ready: Promise<void>;
};

/** Serves the wire protocol: replies to each request with `respond(program)`. */
function startFakeListener(
  path: string,
  respond: (program: string, id: number, socket: Socket) => void
): FakeListener {
  const received: string[] = [];
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const request = JSON.parse(line) as { id: number; p: string };
        const program = Buffer.from(request.p, 'base64').toString('utf8');
        received.push(program);
        respond(program, request.id, socket);
      }
    });
  });
  const ready = new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(() => {
    server.close();
    try {
      unlinkSync(path);
    } catch {
      // Already removed.
    }
  });
  return { server, received, ready };
}

function reply(socket: Socket, id: number, output: string): void {
  socket.write(JSON.stringify({ id, o: Buffer.from(output, 'utf8').toString('base64') }) + '\n');
}

const NEVER_SPAWNS: ExecFn = () => {
  throw new Error('the fallback must not run in this test');
};

/** A fallback that plays Hammerspoon's part in the bootstrap: it answers the
 * bootstrap program with a success envelope and starts the listener. */
function bootstrappingFallback(
  path: string,
  respond: (program: string, id: number, socket: Socket) => void
): { fallback: ExecFn; calls: string[] } {
  const calls: string[] = [];
  const fallback: ExecFn = async (_file, args) => {
    const program = args[1] ?? '';
    calls.push(program);
    const marker = /return "(HSMCP[0-9a-f]+)"/.exec(program)?.[1];
    if (program.includes('__hsmcp_transport') && marker !== undefined) {
      const listener = startFakeListener(path, respond);
      await listener.ready;
      return { stdout: `${marker}{"ok":true,"value":{"ready":true}}`, stderr: '' };
    }
    return { stdout: 'spawned-fallback-ran', stderr: '' };
  };
  return { fallback, calls };
}

describe('createSocketExec', () => {
  it('serves calls over an existing listener without touching the fallback', async () => {
    const path = testSocketPath();
    const listener = startFakeListener(path, (program, id, socket) => {
      reply(socket, id, `echo:${program}`);
    });
    await listener.ready;

    const exec = createSocketExec(NEVER_SPAWNS, { socketPath: path, registerCleanup: false });
    const result = await exec('/fake/hs', ['-c', 'return 42'], {
      timeout: 2000,
      maxBuffer: 1024,
    });

    expect(result.stdout).toBe('echo:return 42');
    expect(listener.received).toEqual(['return 42']);
  });

  it('bootstraps through the fallback when no listener exists, then uses the socket', async () => {
    const path = testSocketPath();
    const { fallback, calls } = bootstrappingFallback(path, (program, id, socket) => {
      reply(socket, id, `ran:${program}`);
    });

    const exec = createSocketExec(fallback, { socketPath: path, registerCleanup: false });
    const first = await exec('/fake/hs', ['-c', 'return "a"'], { timeout: 2000, maxBuffer: 1024 });
    const second = await exec('/fake/hs', ['-c', 'return "b"'], { timeout: 2000, maxBuffer: 1024 });

    expect(first.stdout).toBe('ran:return "a"');
    expect(second.stdout).toBe('ran:return "b"');
    // Exactly one fallback call: the bootstrap. The tool calls went over the
    // socket.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('__hsmcp_transport');
  });

  it('rejects a slow call with the timeout shape and drops the late reply', async () => {
    const path = testSocketPath();
    const held: { id: number; socket: Socket }[] = [];
    const listener = startFakeListener(path, (program, id, socket) => {
      if (program.includes('slow')) {
        held.push({ id, socket });
        return;
      }
      reply(socket, id, 'fast-ok');
    });
    await listener.ready;
    const exec = createSocketExec(NEVER_SPAWNS, { socketPath: path, registerCleanup: false });

    await expect(
      exec('/fake/hs', ['-c', 'slow'], { timeout: 150, maxBuffer: 1024 })
    ).rejects.toMatchObject({ killed: true, signal: 'SIGTERM' });

    // The late reply lands on a dead id and must not confuse later calls.
    const pending = held[0];
    if (pending) reply(pending.socket, pending.id, 'too-late');
    const after = await exec('/fake/hs', ['-c', 'fast'], { timeout: 2000, maxBuffer: 1024 });
    expect(after.stdout).toBe('fast-ok');
  });

  it('rejects, not retries, a call in flight when the connection dies', async () => {
    const path = testSocketPath();
    const listener = startFakeListener(path, (_program, _id, socket) => {
      // Simulate Hammerspoon reloading mid-call.
      socket.destroy();
    });
    await listener.ready;
    const spawned = vi.fn<ExecFn>();
    const exec = createSocketExec(spawned, {
      socketPath: path,
      registerCleanup: false,
    });

    await expect(
      exec('/fake/hs', ['-c', 'return 1'], { timeout: 2000, maxBuffer: 1024 })
    ).rejects.toThrow(/failed to connect/);
    // Re-running the program on the fallback could repeat its side effects,
    // so a mid-flight loss must surface as an error instead.
    expect(spawned).not.toHaveBeenCalled();
  });

  it('falls back to spawn when bootstrap fails, and backs off retrying', async () => {
    const path = testSocketPath();
    const calls: string[] = [];
    const failingBootstrap: ExecFn = (_file, args): Promise<ExecResult> => {
      const program = args[1] ?? '';
      calls.push(program);
      if (program.includes('__hsmcp_transport')) {
        return Promise.reject(
          Object.assign(new Error('hs exited with code 65.'), { exitCode: 65 })
        );
      }
      return Promise.resolve({ stdout: 'spawn-served', stderr: '' });
    };

    const exec = createSocketExec(failingBootstrap, { socketPath: path, registerCleanup: false });
    const first = await exec('/fake/hs', ['-c', 'return 1'], { timeout: 2000, maxBuffer: 1024 });
    const second = await exec('/fake/hs', ['-c', 'return 2'], { timeout: 2000, maxBuffer: 1024 });

    expect(first.stdout).toBe('spawn-served');
    expect(second.stdout).toBe('spawn-served');
    // One failed bootstrap, then two spawn-served calls; the second call must
    // not have attempted another bootstrap inside the backoff window.
    const bootstraps = calls.filter((program) => program.includes('__hsmcp_transport'));
    expect(bootstraps).toHaveLength(1);
  });

  it('rejects output past maxBuffer like the spawn transport does', async () => {
    const path = testSocketPath();
    const listener = startFakeListener(path, (_program, id, socket) => {
      reply(socket, id, 'x'.repeat(2048));
    });
    await listener.ready;
    const exec = createSocketExec(NEVER_SPAWNS, { socketPath: path, registerCleanup: false });

    await expect(
      exec('/fake/hs', ['-c', 'return 1'], { timeout: 2000, maxBuffer: 1024 })
    ).rejects.toThrow(/Output exceeded/);
  });

  it('surfaces a Lua-side load error as a nonzero-exit shape', async () => {
    const path = testSocketPath();
    const listener = startFakeListener(path, (_program, id, socket) => {
      socket.write(JSON.stringify({ id, e: 'load failed: unexpected symbol' }) + '\n');
    });
    await listener.ready;
    const exec = createSocketExec(NEVER_SPAWNS, { socketPath: path, registerCleanup: false });

    await expect(
      exec('/fake/hs', ['-c', 'not lua'], { timeout: 2000, maxBuffer: 1024 })
    ).rejects.toMatchObject({ exitCode: 1, stderr: 'load failed: unexpected symbol' });
  });
});
