/**
 * Orchestration: turn a static Lua body plus arguments into a result.
 *
 * The subprocess is spawned with an argv array, never through a shell. That
 * removes shell quoting from the picture entirely, so the codec's base64
 * guarantee is the only boundary that has to hold.
 */

import { spawn } from 'node:child_process';

import { buildProgram, encodeArgs, envelopeToResult, parseEnvelope } from './codec.js';
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

/** Hammerspoon runs Lua on its main thread, so a hung call blocks everything. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * stdout of a tool call is small (a JSON envelope), but a careless hs_eval can
 * return a lot. Cap it so a runaway result cannot exhaust memory.
 */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

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
  options: { readonly timeout: number; readonly maxBuffer: number }
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

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let overflowed = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeout);

    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > options.maxBuffer) {
        overflowed = true;
        child.kill('SIGTERM');
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    // Spawn failures (a missing binary, most importantly) arrive here rather
    // than as a non-zero exit.
    child.on('error', (error) => {
      settle(() => {
        reject(error);
      });
    });

    child.on('close', (code, signal) => {
      settle(() => {
        if (overflowed) {
          reject(new Error(`Output exceeded ${String(options.maxBuffer)} bytes.`));
          return;
        }
        if (timedOut) {
          reject(
            Object.assign(new Error('Timed out waiting for Hammerspoon.'), {
              killed: true,
              signal: 'SIGTERM',
              stdout,
              stderr,
            })
          );
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
   * `luaBody` must be a constant defined in this codebase. Never pass a string
   * assembled from user or model input: that would reintroduce exactly the
   * injection hole the codec exists to close. The single legitimate exception
   * is the gated hs_eval tool, where running supplied code is the whole point.
   */
  async run(
    luaBody: string,
    args: unknown = {},
    options: RunOptions = {}
  ): Promise<BridgeResult<unknown>> {
    if (!this.#lookup.found) {
      return { ok: false, error: hsNotFound(this.#lookup.searched) };
    }

    const encoded = encodeArgs(args);
    if (!encoded.ok) return encoded;

    const program = buildProgram(luaBody, encoded.value);
    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;

    let raw: ExecResult;
    try {
      raw = await this.#exec(this.#lookup.path, ['-c', program], {
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
      });
    } catch (cause) {
      return { ok: false, error: this.#classifyExecFailure(cause, timeoutMs) };
    }

    const envelope = parseEnvelope(raw.stdout);
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
