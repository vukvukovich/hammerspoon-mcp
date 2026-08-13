/**
 * Orchestration: turn a static Lua body plus arguments into a result.
 *
 * The subprocess is spawned with an argv array, never through a shell. That
 * removes shell quoting from the picture entirely, so the codec's base64
 * guarantee is the only boundary that has to hold.
 */

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import {
  buildProgram,
  encodeArgs,
  envelopeToResult,
  newResultMarker,
  parseEnvelope,
} from './codec.js';
import {
  hsNotFound,
  hsNotRunning,
  luaError,
  protocolError,
  timeout as timeoutError,
  type BridgeError,
  type BridgeResult,
} from './errors.js';
import { resolveHsPath, type HsPathLookup } from './hs-path.js';
import type { LuaProgram } from './lua.js';

/** Hammerspoon runs Lua on its main thread, so a hung call blocks everything. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * stdout of a tool call is small (a JSON envelope), but a careless hs_eval can
 * return a lot. Cap it so a runaway result cannot exhaust memory.
 */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** How long a child gets to honour SIGTERM before it is sent SIGKILL. */
const SIGKILL_GRACE_MS = 2000;

/**
 * How long a timed-out child may keep running before the kill begins.
 *
 * Killing at the deadline is what crashed Hammerspoon (#13, #16): the child's
 * CFMessagePort dies with Hammerspoon's reply still pending, and on macOS 26
 * Hammerspoon sending into that invalidated port is a pointer-authentication
 * EXC_BREAKPOINT that takes the whole app down. Reproduced three suite runs
 * in a row, one crash each, always at the deliberately timed-out call.
 *
 * So a timeout now unblocks the caller at the deadline but leaves the child
 * alive: when Hammerspoon wakes and replies, the port is still valid, the CLI
 * exits on its own, and nothing crashes. The kill only happens if the child
 * is still there after this long, as a backstop against a truly wedged
 * Hammerspoon, where no reply is coming anyway.
 */
const TIMEOUT_LINGER_MS = 30_000;

/**
 * Ceiling on lingering timed-out children, alongside the call gate below.
 *
 * A lingering child no longer occupies a gate slot (its caller was already
 * unblocked), but it still holds a real CFMessagePort connection, and the
 * measured channel budget is about eight concurrent connections before
 * degradation sets in. Four active plus four lingering sits exactly at that
 * measured ceiling. When a fifth child would linger, the oldest lingering one
 * is killed early instead; that early kill re-admits the dead-port-reply
 * crash risk, but only in the already-pathological case of five simultaneous
 * wedged calls, where Hammerspoon is not replying to anything anyway (#20).
 */
const MAX_LINGERING_CHILDREN = 4;

/** Oldest-first registry of lingering children, shared like the call gate:
 * the protected resource is the one Hammerspoon process. */
const lingeringChildren: { readonly terminate: () => void }[] = [];

/**
 * Ceiling on `hs` processes in flight at once, across every bridge instance.
 *
 * Each invocation opens its own CFMessagePort to Hammerspoon, and that channel
 * does not cope with churn. Measured on a real machine: up to 8 concurrent
 * calls all succeed in tens of milliseconds, 10 succeed but take 1.4 seconds,
 * 15 drop to 5 successes with exit codes 65 and 69, and 20 drop to 12. Worse,
 * this same pattern crashed Hammerspoon twice inside its own IPC layer
 * (EXC_BREAKPOINT in CFMessagePortSendRequest).
 *
 * MCP clients issue parallel tool calls as a matter of course, so without a
 * gate here a client asking three questions at once is already at risk and a
 * client asking twenty will lose most of them.
 *
 * Serialising entirely would be defensible, because Hammerspoon runs Lua on
 * its main thread and cannot truly execute two calls at once anyway. A small
 * limit is chosen instead so process startup still overlaps, which is the only
 * part that genuinely parallelises. Four sits far below the level where any
 * degradation was observed.
 *
 * This gate counts active calls only. A timed-out call frees its slot at the
 * deadline while its child lingers on (see TIMEOUT_LINGER_MS), so lingering
 * children get their own ceiling, MAX_LINGERING_CHILDREN, and the two bounds
 * together keep the total connection count inside the measured budget.
 */
const MAX_CONCURRENT_CALLS = 4;

/**
 * Minimal FIFO gate. Deliberately not a dependency: the whole contract is
 * "no more than N at once, in arrival order", and a queue of resolvers
 * expresses that in a dozen lines.
 */
class ConcurrencyGate {
  #active = 0;
  readonly #waiting: (() => void)[] = [];
  readonly #limit: number;

  // A parameter property would be neater, but tsconfig sets
  // erasableSyntaxOnly so that Node can strip types without transforming.
  constructor(limit: number) {
    this.#limit = limit;
  }

  async run<TResult>(task: () => Promise<TResult>): Promise<TResult> {
    if (this.#active >= this.#limit) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
    this.#active += 1;
    try {
      return await task();
    } finally {
      this.#active -= 1;
      // Waking exactly one keeps arrival order and cannot overshoot the limit.
      this.#waiting.shift()?.();
    }
  }
}

/**
 * Shared, not per-instance. The constraint is the single Hammerspoon process
 * every bridge talks to, so two bridge objects must still respect one budget.
 */
const callGate = new ConcurrencyGate(MAX_CONCURRENT_CALLS);

/**
 * Signatures of "Hammerspoon is not listening" as opposed to "Lua raised".
 * The exact wording has changed across Hammerspoon versions, so several
 * phrasings are matched rather than one exact string.
 */
const NOT_RUNNING_PATTERNS: readonly RegExp[] = [
  /can'?t connect/i,
  /cannot connect/i,
  /failed to connect/i,
  /connection refused/i,
  /is not running/i,
  /no such (port|process)/i,
  /unable to (find|reach)/i,
];

export type ExecResult = { readonly stdout: string; readonly stderr: string };

export type ExecFn = (
  file: string,
  args: readonly string[],
  options: {
    readonly timeout: number;
    readonly maxBuffer: number;
    /** Test override for TIMEOUT_LINGER_MS; production callers omit it. */
    readonly lingerMs?: number;
  }
) => Promise<ExecResult>;

export type BridgeOptions = {
  /** Explicit binary path, normally from HS_MCP_HS_PATH. */
  readonly hsPathOverride?: string | undefined;
  readonly defaultTimeoutMs?: number;
  /** Injected in tests so no real subprocess is spawned. */
  readonly exec?: ExecFn;
  /** Injected in tests to simulate a machine without Hammerspoon installed. */
  readonly exists?: (path: string) => boolean;
};

export type RunOptions = {
  readonly timeoutMs?: number;
};

/**
 * Runs the binary with stdin explicitly closed.
 *
 * That detail is load-bearing. The hs CLI waits for end-of-file on stdin
 * before it will exit, so handing it an open pipe (which is what execFile does
 * by default) makes every single call hang until the timeout fires. Measured:
 * 16ms with stdin closed, versus a full timeout without. spawn is used instead
 * of execFile because it lets stdin be set to 'ignore' up front rather than
 * closed as an afterthought.
 *
 * Exported so tests can drive it with an arbitrary argv. The bridge itself
 * always sends ['-c', program], which is too rigid to exercise the timeout and
 * output-limit paths.
 */
export const spawnExec: ExecFn = async (file, args, options) =>
  new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(file, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });

    // A pipe delivers bytes, not characters, so a multi-byte UTF-8 sequence
    // can be split across two chunks. Calling chunk.toString('utf8') on each
    // chunk decodes each half on its own and yields replacement characters:
    // verified on a real pipe, where "ok 🚀 done" arrives as "ok ???? done".
    // StringDecoder holds an incomplete sequence back until the rest arrives.
    //
    // This matters beyond cosmetics. Window titles and console lines contain
    // emoji and accents routinely, and a corrupted byte inside the JSON
    // envelope makes the whole result unparseable, turning a working call into
    // a ProtocolError.
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');

    let stdout = '';
    let stderr = '';
    let settled = false;
    let overflowed = false;

    /**
     * Asks the child to stop, then insists.
     *
     * SIGTERM is catchable, and a child that ignores it never emits 'close',
     * which would leave this promise pending forever: the MCP call would hang
     * and the client would wait indefinitely, which is worse than any error we
     * could return. SIGKILL cannot be caught, so escalating guarantees 'close'
     * arrives and the promise always settles.
     */
    let killTimer: NodeJS.Timeout | undefined;
    const terminate = (): void => {
      child.kill('SIGTERM');
      if (killTimer === undefined) {
        killTimer = setTimeout(() => {
          child.kill('SIGKILL');
        }, SIGKILL_GRACE_MS);
        // A kill of an already-lingering child must not keep the parent alive.
        killTimer.unref();
      }
    };

    let lingerTimer: NodeJS.Timeout | undefined;
    const lingerEntry = { terminate };

    const timer = setTimeout(() => {
      // Unblock the caller at the deadline, but do NOT kill the child yet:
      // its message port must stay valid until Hammerspoon's late reply has
      // landed, or Hammerspoon crashes replying into a dead port. See
      // TIMEOUT_LINGER_MS. The child usually exits by itself moments later;
      // the linger timer is the backstop, and it must not keep the parent
      // process alive on its own.
      settle(() => {
        reject(
          Object.assign(new Error('Timed out waiting for Hammerspoon.'), {
            killed: true,
            signal: 'SIGTERM',
            stdout,
            stderr,
          })
        );
      });
      // Entering the linger pool may evict the oldest resident: the total of
      // active plus lingering children must stay inside the channel budget.
      while (lingeringChildren.length >= MAX_LINGERING_CHILDREN) {
        lingeringChildren.shift()?.terminate();
      }
      lingeringChildren.push(lingerEntry);
      lingerTimer = setTimeout(terminate, options.lingerMs ?? TIMEOUT_LINGER_MS);
      lingerTimer.unref();
    }, options.timeout);

    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      action();
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += outDecoder.write(chunk);
      if (stdout.length > options.maxBuffer) {
        overflowed = true;
        terminate();
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += errDecoder.write(chunk);
    });

    // Spawn failures (a missing binary, most importantly) arrive here rather
    // than as a non-zero exit.
    child.on('error', (error) => {
      settle(() => {
        reject(error);
      });
    });

    child.on('close', (code, signal) => {
      // A lingering timed-out child that exits (naturally or evicted) no
      // longer needs its backstop kill or its pool slot.
      if (lingerTimer !== undefined) clearTimeout(lingerTimer);
      const pooled = lingeringChildren.indexOf(lingerEntry);
      if (pooled !== -1) lingeringChildren.splice(pooled, 1);
      settle(() => {
        // Flush whatever the decoders were holding. A process killed mid
        // character leaves a partial sequence, and end() turns it into the
        // replacement character rather than dropping it silently.
        stdout += outDecoder.end();
        stderr += errDecoder.end();

        if (overflowed) {
          reject(new Error(`Output exceeded ${String(options.maxBuffer)} bytes.`));
          return;
        }
        if (code !== 0) {
          reject(
            Object.assign(new Error(`hs exited with code ${String(code)}.`), {
              exitCode: code,
              signal,
              stdout,
              stderr,
            })
          );
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  });

export class HammerspoonBridge {
  readonly #exec: ExecFn;
  readonly #defaultTimeoutMs: number;
  readonly #lookup: HsPathLookup;

  constructor(options: BridgeOptions = {}) {
    this.#exec = options.exec ?? spawnExec;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#lookup = resolveHsPath({
      override: options.hsPathOverride,
      ...(options.exists === undefined ? {} : { exists: options.exists }),
    });
  }

  /** Where the binary was found, for diagnostics. */
  get hsPath(): string | undefined {
    return this.#lookup.found ? this.#lookup.path : undefined;
  }

  /**
   * Runs a static Lua body with the given arguments.
   *
   * The parameter is a `LuaProgram`, not a string, and the only way to make
   * one is the `lua` template tag, which cannot express an interpolation. So
   * "did anyone splice a value into this program" is answered by the compiler
   * rather than by review. See src/bridge/lua.ts.
   *
   * Arguments travel separately through the codec and arrive as `ARGS`. That
   * includes hs_eval's supplied code, which is compiled inside Lua with
   * load(), so even there the program itself stays a constant.
   */
  async run(
    luaBody: LuaProgram,
    args: unknown = {},
    options: RunOptions = {}
  ): Promise<BridgeResult<unknown>> {
    if (!this.#lookup.found) {
      return { ok: false, error: hsNotFound(this.#lookup.searched) };
    }

    const encoded = encodeArgs(args);
    if (!encoded.ok) return encoded;

    // Fresh per call, so nothing in the arguments (which were composed before
    // this existed) can impersonate the result line on stdout.
    const marker = newResultMarker();
    const program = buildProgram(luaBody, encoded.value, marker);
    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;
    // Captured before the closure below, which cannot carry the narrowing
    // from the found check above.
    const hsPath = this.#lookup.path;

    let raw: ExecResult;
    try {
      // Gated: too many simultaneous hs processes overwhelm Hammerspoon's IPC
      // channel and start failing outright. Queued calls still get their full
      // timeout once they start, since the clock is inside the task.
      raw = await callGate.run(async () =>
        this.#exec(hsPath, ['-c', program], {
          timeout: timeoutMs,
          maxBuffer: MAX_OUTPUT_BYTES,
        })
      );
    } catch (cause) {
      return { ok: false, error: this.#classifyExecFailure(cause, timeoutMs) };
    }

    const envelope = parseEnvelope(raw.stdout, marker);
    if (!envelope.ok) {
      // A failure to parse usually means Hammerspoon never answered, and the
      // real explanation is on stderr.
      if (matchesNotRunning(raw.stderr)) {
        return { ok: false, error: hsNotRunning(raw.stderr.trim()) };
      }
      return envelope;
    }

    return envelopeToResult(envelope.value, luaError);
  }

  #classifyExecFailure(cause: unknown, timeoutMs: number): BridgeError {
    const error = cause as NodeJS.ErrnoException & {
      killed?: boolean;
      signal?: string;
      stderr?: string;
      stdout?: string;
    };

    if (error.code === 'ENOENT') {
      return hsNotFound(this.#lookup.found ? [this.#lookup.path] : this.#lookup.searched);
    }

    if (error.killed === true || error.signal === 'SIGTERM') {
      return timeoutError(timeoutMs);
    }

    const stderr = error.stderr ?? '';
    if (matchesNotRunning(stderr) || matchesNotRunning(error.message)) {
      return hsNotRunning((stderr || error.message).trim());
    }

    // A non-zero exit can still carry a valid envelope on stdout, but by the
    // time we are here stdout has already failed us, so this is unexplained.
    return protocolError(
      'The hs command failed unexpectedly.',
      `${error.message}\n${stderr}`.slice(0, 500)
    );
  }
}

function matchesNotRunning(text: string): boolean {
  return NOT_RUNNING_PATTERNS.some((pattern) => pattern.test(text));
}
