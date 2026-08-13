/**
 * Persistent Unix-socket transport.
 *
 * Spawning `hs` per call costs ~8.7ms of pure process overhead for Lua work
 * that takes microseconds, and every spawn churns a CFMessagePort, the
 * channel whose churn degraded concurrent calls and crashed Hammerspoon
 * inside its own IPC layer (#13, #19). One long-lived connection has nothing
 * to churn: measured on the target machine, 0.56ms per call against 8.72ms,
 * and 40 simultaneous calls all succeed where spawn managed 5 of 15.
 *
 * The listener is self-installing. The first call bootstraps a small socket
 * server inside the running Hammerspoon over the classic `hs -c` transport,
 * so there is nothing to add to the user's configuration, and a config
 * reload that wipes the Lua state simply triggers a re-bootstrap on the next
 * call. When the socket cannot be established at all, calls fall back to the
 * spawn transport, so behaviour is never worse than the classic path.
 *
 * One socket per MCP server process, keyed by pid. hs.socket's server object
 * broadcasts writes to every connected client, so sharing one socket between
 * two MCP processes would cross their replies; separate sockets make the
 * broadcast semantics harmless. The socket lives under $TMPDIR, which macOS
 * creates per-user with mode 0700, so reachability is user-only by
 * construction. Deliberately NOT under ~/.hammerspoon: config watchers
 * (ReloadConfiguration.spoon) treat any file change there as an edit and
 * reload the config, which would tear the listener down as a side effect of
 * creating it.
 *
 * Wire protocol, one JSON object per line in each direction:
 *   request:  {"id": n, "p": "<base64 Lua program>"}
 *   response: {"id": n, "o": "<base64 of the program's return string>"}
 *           | {"id": n, "e": "<load or runtime error text>"}
 * The program is the same codec-built envelope the CLI runs; its returned
 * string becomes `stdout` for the existing parser, so the codec and every
 * tool are untouched.
 */

import { connect, type Socket } from 'node:net';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildProgram, encodeArgs, newResultMarker, parseEnvelope } from './codec.js';
import { lua } from './lua.js';
import { logger } from '../logging/logger.js';

import type { ExecFn, ExecResult } from './bridge.js';

/**
 * After a failed bootstrap-and-connect cycle, how long to serve calls from
 * the spawn fallback before trying the socket again. Retrying every call
 * would add a failed bootstrap to each one; never retrying would strand the
 * fast path after one transient failure.
 */
const RETRY_BACKOFF_MS = 30_000;

/** How long the bootstrap round trip (an `hs -c` spawn) may take. */
const BOOTSTRAP_TIMEOUT_MS = 10_000;

const BOOTSTRAP_LUA = lua`
__hsmcp_transport = __hsmcp_transport or { servers = {}, timers = {}, seen = {} }
local reg = __hsmcp_transport

-- Prune listeners left behind by MCP processes that exited: their socket
-- files are gone (each process unlinks its own on exit).
for stalePath, staleServer in pairs(reg.servers) do
  if stalePath ~= ARGS.path and not hs.fs.attributes(stalePath) then
    pcall(function() staleServer:disconnect() end)
    if reg.timers[stalePath] then reg.timers[stalePath]:stop() end
    reg.servers[stalePath] = nil
    reg.timers[stalePath] = nil
    reg.seen[stalePath] = nil
  end
end

if reg.servers[ARGS.path] then
  return { ready = true, existing = true }
end

os.remove(ARGS.path)

local server
server = hs.socket.server(ARGS.path, function(data)
  local ok, request = pcall(hs.json.decode, data)
  if ok and request and request.id then
    local reply
    local chunk, loadError = load(hs.base64.decode(request.p), "hsmcp", "t")
    if not chunk then
      reply = { id = request.id, e = "load failed: " .. tostring(loadError) }
    else
      local ran, result = pcall(chunk)
      if ran then
        reply = { id = request.id, o = hs.base64.encode(tostring(result or "")) }
      else
        reply = { id = request.id, e = tostring(result) }
      end
    end
    server:write(hs.json.encode(reply) .. "\\n")
  end
  server:read("\\n")
end)
if not server then
  error("could not bind a socket at " .. tostring(ARGS.path), 0)
end

-- hs.socket only arms reads on clients connected at the time of the read()
-- call, and exposes no accept event, so watch the connection count and arm
-- the first read when the client appears. Costs at most one tick of latency
-- once per connection; the reply handler re-arms every read after that.
reg.seen[ARGS.path] = 0
reg.timers[ARGS.path] = hs.timer.doEvery(0.1, function()
  local connections = server:connections()
  if connections > (reg.seen[ARGS.path] or 0) then server:read("\\n") end
  reg.seen[ARGS.path] = connections
end)
reg.servers[ARGS.path] = server
return { ready = true }
`;

type PendingRequest = {
  readonly resolve: (result: ExecResult) => void;
  readonly reject: (cause: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly maxBuffer: number;
};

/** Error shape #classifyExecFailure reads as a Timeout. */
function timeoutShapedError(): Error {
  return Object.assign(new Error('Timed out waiting for Hammerspoon.'), {
    killed: true,
    signal: 'SIGTERM',
    stdout: '',
    stderr: '',
  });
}

/**
 * Error for a request that may already be executing when the connection
 * died (a reload or crash mid-call). It must NOT be retried on the fallback
 * transport: the program may have run, and running it twice repeats its side
 * effects. The message matches the classifier's not-running patterns, which
 * is the honest reading of a connection that just vanished.
 */
function connectionLostError(): Error {
  return Object.assign(
    new Error('failed to connect: the Hammerspoon connection was lost mid-call.'),
    {
      stderr: 'failed to connect: the Hammerspoon connection dropped while a call was in flight.',
      stdout: '',
    }
  );
}

class HsSocketClient {
  readonly #path: string;
  #socket: Socket | undefined;
  #connecting: Promise<void> | undefined;
  #buffer = '';
  #nextId = 1;
  readonly #pending = new Map<number, PendingRequest>();

  constructor(path: string) {
    this.#path = path;
  }

  get connected(): boolean {
    return this.#socket !== undefined;
  }

  async connect(): Promise<void> {
    if (this.#socket !== undefined) return;
    this.#connecting ??= new Promise<void>((resolve, reject) => {
      const socket = connect(this.#path);
      socket.once('connect', () => {
        socket.removeAllListeners('error');
        this.#adopt(socket);
        resolve();
      });
      socket.once('error', (cause) => {
        socket.destroy();
        reject(cause);
      });
    }).finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  #adopt(socket: Socket): void {
    this.#socket = socket;
    // The socket must not keep the server process alive on its own; pending
    // requests hold their own timers.
    socket.unref();
    socket.on('data', (chunk: Buffer) => {
      this.#buffer += chunk.toString('utf8');
      let newline;
      while ((newline = this.#buffer.indexOf('\n')) !== -1) {
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        this.#dispatch(line);
      }
    });
    const drop = (): void => {
      this.#dropConnection();
    };
    socket.on('error', drop);
    socket.on('close', drop);
  }

  #dropConnection(): void {
    this.#socket?.destroy();
    this.#socket = undefined;
    this.#buffer = '';
    for (const [, request] of this.#pending) {
      clearTimeout(request.timer);
      request.reject(connectionLostError());
    }
    this.#pending.clear();
  }

  #dispatch(line: string): void {
    let message: { id?: number; o?: string; e?: string };
    try {
      // Boundary cast: shape-checked field by field below.
      message = JSON.parse(line) as { id?: number; o?: string; e?: string };
    } catch {
      return; // Noise on the line protocol; the per-request timeout covers us.
    }
    if (typeof message.id !== 'number') return;
    const request = this.#pending.get(message.id);
    if (request === undefined) return; // Late reply for a timed-out call.
    this.#pending.delete(message.id);
    clearTimeout(request.timer);

    if (message.e !== undefined) {
      request.reject(
        Object.assign(new Error(`hs exited with code 1.`), {
          exitCode: 1,
          stdout: '',
          stderr: message.e,
        })
      );
      return;
    }
    const stdout = Buffer.from(message.o ?? '', 'base64').toString('utf8');
    if (stdout.length > request.maxBuffer) {
      request.reject(new Error(`Output exceeded ${String(request.maxBuffer)} bytes.`));
      return;
    }
    request.resolve({ stdout, stderr: '' });
  }

  async request(
    program: string,
    options: { readonly timeout: number; readonly maxBuffer: number }
  ): Promise<ExecResult> {
    const socket = this.#socket;
    if (socket === undefined) throw new Error('not connected');

    const id = this.#nextId++;
    return new Promise<ExecResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Unblock the caller; the entry's removal makes the eventual reply a
        // no-op. The connection stays up: there is no port to invalidate and
        // the late reply simply gets dropped by id (#16's lesson, for free).
        this.#pending.delete(id);
        reject(timeoutShapedError());
      }, options.timeout);
      this.#pending.set(id, { resolve, reject, timer, maxBuffer: options.maxBuffer });
      socket.write(
        JSON.stringify({ id, p: Buffer.from(program, 'utf8').toString('base64') }) + '\n'
      );
    });
  }
}

export type SocketExecOptions = {
  /** Socket path override, for tests. Defaults to a per-process $TMPDIR path. */
  readonly socketPath?: string;
  /** Skips the exit-hook unlink, for tests that manage their own files. */
  readonly registerCleanup?: boolean;
};

export function defaultSocketPath(): string {
  return join(tmpdir(), `hsmcp-${String(process.pid)}.sock`);
}

/**
 * Wraps the spawn transport with the persistent socket, falling back to it
 * whenever the socket cannot be established. The fallback is passed in
 * rather than imported so the module has no value dependency on bridge.ts.
 */
export function createSocketExec(fallback: ExecFn, options: SocketExecOptions = {}): ExecFn {
  const socketPath = options.socketPath ?? defaultSocketPath();
  const client = new HsSocketClient(socketPath);
  let announced = false;
  let retryAfter = 0;

  if (options.registerCleanup !== false) {
    process.once('exit', () => {
      try {
        unlinkSync(socketPath);
      } catch {
        // Never bootstrapped, or already gone. Either way there is nothing
        // for the Lua-side pruner to find.
      }
    });
  }

  const bootstrap = async (file: string): Promise<void> => {
    const encoded = encodeArgs({ path: socketPath });
    if (!encoded.ok) throw new Error(encoded.error.message);
    const marker = newResultMarker();
    const program = buildProgram(BOOTSTRAP_LUA, encoded.value, marker);
    const raw = await fallback(file, ['-c', program], {
      timeout: BOOTSTRAP_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    });
    const envelope = parseEnvelope(raw.stdout, marker);
    if (!envelope.ok || envelope.value.ok !== true) {
      throw new Error('bootstrap did not confirm the listener');
    }
  };

  return async (file, args, execOptions) => {
    // args is ['-c', program] by the bridge's construction.
    const program = args[1] ?? '';

    if (!client.connected && Date.now() < retryAfter) {
      return fallback(file, args, execOptions);
    }

    if (!client.connected) {
      try {
        try {
          await client.connect();
        } catch {
          // No listener yet (first call, or a reload wiped it). Install one
          // and connect again.
          await bootstrap(file);
          await client.connect();
        }
      } catch (cause) {
        retryAfter = Date.now() + RETRY_BACKOFF_MS;
        logger.warn(
          `Persistent socket transport unavailable (${cause instanceof Error ? cause.message : String(cause)}); using spawn per call for ${String(RETRY_BACKOFF_MS / 1000)}s.`
        );
        return fallback(file, args, execOptions);
      }
      if (!announced) {
        announced = true;
        logger.info(`Persistent socket transport connected at ${socketPath}.`);
      }
    }

    return client.request(program, execOptions);
  };
}
