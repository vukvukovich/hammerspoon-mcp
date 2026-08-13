# Architecture

How the server is put together, and why. If you only read one section, read
[The ARGS codec](#the-args-codec), because that is the property everything else
is arranged to protect.

## The shape of the problem

Hammerspoon is a macOS automation app scripted in Lua. Its `hs.ipc` module
installs a command line tool, `hs`, which sends Lua to the running Hammerspoon
process and prints whatever comes back:

```sh
hs -c "return hs.screen.primaryScreen():name()"
```

So a bridge between an AI agent and Hammerspoon comes down to three jobs:

1. Turn a typed tool call into Lua.
2. Run it through `hs`.
3. Turn the output back into a structured result.

Job 1 is where the security of the whole thing is decided. Jobs 2 and 3 are
where the reliability is decided, because the `hs` CLI is chatty and
Hammerspoon can hang.

## Layers

```
MCP client (Claude Code, Claude Desktop, ...)
        |  JSON-RPC over stdio
        v
+-----------------------------------------------+
|  main.ts        bin entry, serveStdio,        |
|                 signal handling               |
+-----------------------------------------------+
|  server.ts      builds the McpServer,         |
|                 filters tools by tier         |
+-----------------------------------------------+
|  tools/registry.ts   defineTool, result       |
|                      helpers                  |
+-----------------------------------------------+
|  tools/safe/*, tools/unsafe/eval.ts           |
|                 Zod schema + static Lua body  |
+-----------------------------------------------+
|  bridge/        codec, path, spawn, errors    |
+-----------------------------------------------+
        |  spawn(hsPath, ["-c", lua],
        |        { stdio: ["ignore", "pipe", "pipe"] })
        v
   unix socket (persistent, default)  --->  Hammerspoon.app (Lua runtime)
   hs CLI (bootstrap + fallback)      --->  Hammerspoon.app (Lua runtime)
```

Each layer only knows the one below it. Tools do not know how the subprocess is
started. The bridge does not know what MCP is. That separation is what makes the
bridge testable with no Hammerspoon in the room: a test injects its own `exec`
function through `BridgeOptions` and nothing else changes.

One tool sits outside this stack. `hs_api_search` reads Hammerspoon's bundled
`docs.json` through `src/docs/docs-index.ts` and never calls the bridge, so it
answers even when Hammerspoon is not running. See
[API documentation search](#api-documentation-search).

### The request path

```mermaid
sequenceDiagram
    participant C as MCP client
    participant S as server.ts
    participant R as registry.ts
    participant T as tool definition
    participant B as bridge.ts
    participant H as hs CLI
    participant A as Hammerspoon

    C->>S: tools/call hs_move_window {id, x, y, width, height}
    S->>R: dispatch to the registered handler
    R->>T: validate args with Zod schema
    T->>B: run(MOVE_WINDOW_LUA, args)
    B->>B: JSON.stringify -> base64 -> prelude
    B->>H: spawn(hsPath, ["-c", prelude + body])
    H->>A: send Lua over hs.ipc
    A->>A: pcall(tool body), read ARGS.*
    A-->>H: one JSON line {ok:true,value:...}
    H-->>B: stdout (extension noise + that line)
    B->>B: take last JSON-parseable line
    B-->>T: Ok(value) or BridgeError
    T-->>S: tool result content
    S-->>C: response
```

## The ARGS codec

`src/bridge/codec.ts`.

### What the usual approach gets wrong

The obvious way to pass a window title into Lua is to interpolate it:

```ts
const lua = `hs.window.find("${args.title}")`; // do not do this
```

Now the correctness of the whole server rests on escaping. Someone has to
remember quotes, backslashes, newlines, and Lua's long-bracket syntax
(`[[ ... ]]`, `[==[ ... ]==]`), forever, in every tool anyone ever adds. The
agent's arguments frequently come from untrusted text it read somewhere. One
missed case is arbitrary code execution.

Escaping is a discipline. Disciplines fail at the edges.

### What this server does instead

Every tool's Lua body is a static string constant in the TypeScript source. It
is written once, reviewed once, and never assembled at runtime. Arguments travel
out of band:

```
args object  ->  JSON.stringify  ->  Buffer.from(json).toString("base64")
```

The base64 text is spliced into exactly one place, a fixed prelude line:

```lua
local ARGS = hs.json.decode(hs.base64.decode("PGJhc2U2ND4=")) or {}
```

The full program sent to `hs` is that prelude, plus a `pcall` wrapper, plus the
static body. The body reads `ARGS.id`, `ARGS.width`, and so on. The `or {}` means
a tool that takes no arguments still sees a table rather than `nil`.

### The invariant has no exceptions

No tool in this codebase builds Lua by string concatenation. Not one, and that
includes `hs_eval`.

`hs_eval` is the tool that runs code the caller supplied, so it looks like the
obvious place to give up and splice. It does not. The supplied code travels
through the same base64 `ARGS` channel as every other argument, and the static
body compiles it inside Lua:

```lua
local chunk, compileError = load(ARGS.code, "hs_eval", "t")
if not chunk then error("syntax error: " .. tostring(compileError), 0) end
return chunk()
```

That buys two things. The codec invariant stays absolute, so "does any tool
splice?" has a one-word answer instead of a list of exceptions to audit. And a
syntax error in the supplied code becomes a clean `LuaError` naming `hs_eval`,
instead of a mangled program whose parse failure lands somewhere unrelated.

The security boundary for `hs_eval` is the tier, not the encoding. Arbitrary Lua
can do anything the user can do. Encoding it safely just means the failure modes
are the ones you asked for.

### Why base64 makes injection impossible

Standard base64 output uses exactly these characters:

```
A-Z  a-z  0-9  +  /  =
```

Look at what is missing:

| Character   | What it would let an attacker do | In base64? |
| ----------- | -------------------------------- | ---------- |
| `"`         | Close the Lua string             | no         |
| `'`         | Close a single-quoted string     | no         |
| `\`         | Start an escape sequence         | no         |
| newline     | End the statement                | no         |
| `[` `]`     | Open or close a long bracket     | no         |
| `-`         | Start a `--` comment             | no         |
| `;` `(` `)` | Chain or call                    | no         |

There is no character in the payload that can terminate the string literal it
sits inside. So there is no payload that reaches the Lua parser as code. This
holds no matter what the agent was told to send, and it holds without anyone
writing an escaping function.

The property comes from the **alphabet**, not from care. That is the point.
Escaping can be done wrong. An alphabet that lacks the dangerous characters
cannot be done wrong.

Two supporting details:

- **Encoding cannot fail.** `JSON.stringify` on a validated Zod object followed
  by base64 has no error path that produces partial output. Either you get the
  full encoded string or you get an exception before anything is sent.
- **Decoding happens inside Lua.** `hs.json.decode` produces a Lua table. It
  does not evaluate anything. A payload of `"os.execute('rm -rf ~')"` becomes a
  Lua string containing that text, not a call.

### No shell layer

Invocation is `spawn(hsPath, ["-c", lua], ...)`. `spawn` takes an argv array and
hands it straight to the operating system. There is no `sh -c`, so there is no
second quoting context to get right. Using `exec` with a command string would
put the shell back in the path and undo the whole design, which is why
[CONVENTIONS.md](../CONVENTIONS.md) bans it outright.

### The regression guard

`test/unit/tools/lua-safety.test.ts` is a meta-test. It reads the source of
every `.ts` file under `src/` and fails the build on four things:

1. **No Lua constant exists at all.** If the pattern below stops matching
   anything, the test is silently passing on nothing, so it asserts that it
   found some.
2. **A `*_LUA` constant contains `${`.** That is a template-literal
   interpolation, which means a value is being spliced into Lua source.
3. **A `*_LUA` constant is declared indented.** Indentation means the constant
   sits inside a function, which means it is rebuilt on every call and could
   capture a local. Module-level declaration is what makes "static" checkable by
   grep. The check matches `\n[ \t]+const ..._LUA` specifically, because `\s+`
   would span newlines and flag a top-level constant that merely has a blank
   line above it.
4. **`bridge.run` is called with anything other than an identifier ending in
   `LUA`.** A template literal, a concatenation, or a function call in that
   position is a splicing risk even when every named constant is clean.

These are blunt textual checks and that is fine. Their job is to make the day
someone reintroduces splicing a red CI run rather than a CVE. They also explain
the naming rule: the `_LUA` suffix is not decoration, it is what the scanner
matches on.

## Binary discovery

`src/bridge/hs-path.ts`.

The `hs` binary lands in different places depending on how Hammerspoon was
installed and which Homebrew prefix the machine uses. The server takes the first
path that exists:

1. `$HS_MCP_HS_PATH`, if set. Short-circuits everything below.
2. `~/.local/bin/hs` (the usual target of `hs.ipc.cliInstall()`)
3. `/opt/homebrew/bin/hs` (Homebrew on Apple Silicon)
4. `/usr/local/bin/hs` (Homebrew on Intel, or a manual install)
5. `/Applications/Hammerspoon.app/Contents/Frameworks/hs/hs` (inside the bundle)
6. `~/Applications/Hammerspoon.app/Contents/Frameworks/hs/hs` (per-user install)

The check is existence only (`existsSync`), not an executable-bit test. A path
that exists but cannot be run fails later as a spawn error, which the classifier
turns into `HsNotFound`.

An explicit `HS_MCP_HS_PATH` is trusted without probing the filesystem at all.
If the user named a binary, a clear failure at execution time is better than
quietly running a different one.

There is deliberately no `PATH` lookup. An MCP server is spawned by a graphical
application, and graphical applications on macOS inherit a minimal environment
that usually does not include Homebrew's `bin`. A bare `hs` that resolves in
your terminal often does not resolve for the server, so relying on `PATH` would
work on the developer's machine and fail on the user's. The absolute locations
above cover every normal install, and `HS_MCP_HS_PATH` covers the rest.

When nothing matches, the lookup returns the full list of paths it searched, and
that list goes into the `HsNotFound` hint. "Not found" is not actionable. "Not
found, here is every place I looked" is.

Resolution runs once, in the `HammerspoonBridge` constructor. The server builds
one bridge, so in practice that is once per process.

## The result protocol

Every tool's Lua produces exactly one JSON line on stdout. `buildProgram` in
`src/bridge/codec.ts` wraps the static body to guarantee it:

```lua
local ARGS = hs.json.decode(hs.base64.decode("<base64>")) or {}
local __ok, __res = pcall(function()
  -- static tool body, reads ARGS.*
  return { count = 3 }
end)
if not __ok then
  return hs.json.encode({ ok = false, err = tostring(__res) })
end
local __encoded, __json = pcall(hs.json.encode, { ok = true, value = __res })
if __encoded then return __json end
return hs.json.encode({ ok = true, value = tostring(__res), unencodable = true })
```

The program `return`s the JSON string rather than printing it. The `hs` CLI
prints whatever the program returns, so this stays one line and one line only.

The locals are `__` prefixed so a tool body can declare `ok`, `res`, or `json`
without colliding with the wrapper.

So the wire format is one of three shapes:

```json
{ "ok": true, "value": { "count": 3 } }
{ "ok": false, "err": "attempt to index a nil value" }
{ "ok": true, "value": "hs.window: Safari", "unencodable": true }
```

The third one exists because some Hammerspoon values cannot be JSON-encoded at
all. A cyclic table, or a userdata handle, makes `hs.json.encode` throw. Losing
the whole call to that is worse than handing back `tostring(value)` and a flag
saying so, so the encode itself runs under a second `pcall`.

`pcall` is what keeps a Lua runtime error from becoming a process-level failure
with no diagnosis. A crashed tool still returns a structured `err` the agent can
read and act on.

### Why the parser takes the last JSON-parseable line

The `hs` CLI prints its own noise before your output. Loading extensions emits
lines like:

```
-- Loading extension: window
-- Loading extension: json
{"ok":true,"value":{"count":3}}
```

Naively parsing the first line, or the whole of stdout, fails. So the decoder
splits stdout into lines, walks them from the end, and returns the first one
that parses as JSON and has a boolean `ok` field. Anything before it is
discarded as noise.

This also handles a tool body that logs with `print` for debugging. Its output
scrolls past, and the real result is still the last line.

If no line parses, that is a `ProtocolError`, described below.

## Invocation and timeouts

`src/bridge/bridge.ts` orchestrates one call:

1. Resolve the `hs` path (cached).
2. Encode args, assemble prelude plus body.
3. `spawn(hsPath, ["-c", lua], { stdio: ["ignore", "pipe", "pipe"] })`.
4. Classify the outcome into a success value or a `BridgeError`.

Calls are asynchronous. Synchronous child process calls are banned, because the
server holds an open protocol connection on a single thread. A blocking
subprocess means the server stops answering the client while Hammerspoon works.

### Why stdin is set to ignore

This one line is load-bearing, and getting it wrong makes the entire server
look broken.

The `hs` command line tool waits for end-of-file on stdin before it exits.
Node's `execFile` gives a child an open stdin pipe by default and never closes
it, so `hs` sits there waiting for input that will never arrive. Every single
call then hangs until the timeout fires. The first version of this bridge used
`execFile` and every integration test failed with a ten second `Timeout`, while
the exact same command run by hand in a terminal returned instantly. The
difference is that a terminal gives the process a real stdin that reaches
end-of-file.

Measured on this machine: 16ms with stdin closed, versus a full timeout
without.

`spawn` is used rather than `execFile` because it sets stdin to `ignore` up
front, as a property of how the child is created, instead of closing the pipe
afterwards and hoping nothing raced.

Only an integration test could have caught this. Unit tests inject a fake
`ExecFn`, so they never create a real process and never see the behaviour. The
regression guard lives in `test/unit/bridge/default-exec.test.ts` under the
name "completes without hanging, which proves stdin is closed", spawning Node
itself so it still runs in continuous integration. If that test ever starts
timing out, stdin handling has regressed.

### A timed-out child is not killed at the deadline

The caller gets its `Timeout` error the moment the deadline passes, but the
`hs` child process is left running for up to 30 more seconds. This is a crash
fix, not laziness. Each invocation holds a CFMessagePort with Hammerspoon's
reply pending; killing the child invalidates that port, and on macOS 26
Hammerspoon crashes with a pointer-authentication `EXC_BREAKPOINT` the moment
it wakes and sends its reply into the dead port. Reproduced three integration
runs in a row, one Hammerspoon crash each, always at the deliberately
timed-out call, and zero crashes with the linger in place. The lingering child
receives the late reply, exits on its own, and is force-killed only if it is
still there after the linger, which means Hammerspoon is wedged and no reply
is coming anyway.

Timeouts are **per tool**, declared in the tool's spec, not one global number.
`hs_list_windows` should answer in well under a second. `hs_reload_config` runs
the user's whole `init.lua` and reasonably takes longer. A single timeout would
have to be set for the slowest tool, which makes every fast tool hang for that
long when Hammerspoon is wedged.

Hammerspoon is single-threaded. A config stuck in a loop, or a modal dialog on
screen, means calls do not return. The timeout is what turns that into a
diagnosable error instead of an agent that appears to freeze.

## The persistent socket transport

`src/bridge/socket-transport.ts`. The default since 0.3; `HS_MCP_TRANSPORT=spawn`
restores the classic behaviour.

Spawning `hs` per call costs about 9ms of process overhead for Lua work that
takes microseconds, and every spawn churns a CFMessagePort, the channel whose
churn degraded concurrent calls and crashed Hammerspoon inside its own IPC
layer. One long-lived Unix domain socket has nothing to churn. Measured with
the committed benchmark (`node test/bench/transport-bench.mjs`): 0.97ms per
call against 9.45ms, and forty simultaneous calls all succeed in ~25ms.

The listener is **self-installing**: the first call bootstraps a small socket
server inside the running Hammerspoon over one classic `hs -c` spawn, so there
is nothing to add to the user's configuration. A config reload wipes the
listener with the rest of the Lua state; the next call notices the dead
socket and bootstraps again. When the socket cannot be established at all,
calls are served by the spawn transport (with a 30s backoff between socket
retries), so behaviour is never worse than the classic path — including on a
machine where `hs.socket` misbehaves entirely.

Three design points that were learned the hard way:

- **One socket per MCP process**, `$TMPDIR/hsmcp-<pid>.sock`. hs.socket's
  server object broadcasts writes to every connected client, so one shared
  socket would cross replies between two MCP sessions. Per-process sockets
  make the broadcast semantics harmless, and `$TMPDIR` is per-user mode 0700
  on macOS, so access is user-only by construction. The socket deliberately
  does not live under `~/.hammerspoon`: config watchers such as
  ReloadConfiguration.spoon treat any file change there as a config edit and
  reload, which would tear down the listener as a side effect of creating it.
- **A call in flight when the connection dies is an error, not a retry.** The
  program may already have run; re-running it on the fallback would repeat
  its side effects. The error is classified as HsNotRunning, which is the
  honest reading of a connection that just vanished.
- **Timeouts drop the reply by id.** The caller unblocks at the deadline and
  the connection stays up; the late reply matches no pending request and is
  discarded. This is the linger fix's property for free: there is no port to
  invalidate, so nothing crashes.

The wire protocol is one JSON object per line in each direction; the Lua
program travels base64-encoded and its returned envelope string comes back the
same way. The codec, every tool, and the result parser are untouched: the
transport implements the same `ExecFn` seam the spawn path does.

## Concurrency: calls are queued, four at a time

MCP clients issue parallel tool calls as a matter of course. Ask an agent about
audio, windows, and battery at once and it fires all three together. The bridge
does not pass that concurrency straight through, and the reason is worth
understanding before changing it.

### Hammerspoon executes Lua strictly serially

Not "mostly", not "usually". Measured against a real Hammerspoon, with a body
that sleeps 400ms:

| Calls            | Wall time |
| ---------------- | --------- |
| 1                | 417ms     |
| 4 issued at once | 1629ms    |

That is 4 x 407ms. No overlap whatsoever.

Two reasons, both structural:

- **One Lua state, and Lua states are not thread-safe.** Hammerspoon runs a
  single interpreter, so it cannot be entered from two threads at once.
- **The APIs call AppKit.** `hs.window`, `hs.screen`, and `hs.menubar` touch
  Cocoa, which macOS pins to the main thread. Even a thread-safe Lua would have
  to funnel this work back to one thread.

So `hs.ipc` dispatches every message onto the main run loop and handles them one
at a time. Twenty clients is twenty people queueing at one till.

### Unbounded concurrency does not queue, it fails

Serialisation on its own would only mean waiting. What actually happens is
worse, because each invocation opens its own CFMessagePort and that channel
does not tolerate churn:

| Simultaneous `hs` calls | Result                        |
| ----------------------- | ----------------------------- |
| 2 to 8                  | all succeed, milliseconds     |
| 10                      | all succeed, but 1.4 seconds  |
| 15                      | 5 of 15, exit codes 65 and 69 |
| 20                      | 12 of 20                      |

This pattern also crashed Hammerspoon twice during development, with
`EXC_BREAKPOINT` inside `CFMessagePortSendRequest`, a pointer-authentication
failure on an invalidated port. A client should not be able to crash the
application by connecting too quickly; that part is a Hammerspoon bug rather
than something this server can fix.

### Why the limit is four and not one

Given Lua is serial, a strict one-at-a-time queue looks like the obvious
answer. It is measurably worse:

| Gate | 40 calls | Per call |
| ---- | -------- | -------- |
| 1    | 315ms    | 7.88ms   |
| 2    | 201ms    | 5.03ms   |
| 4    | 111ms    | 2.77ms   |
| 8    | 3745ms   | 93.63ms  |

A call is roughly 8ms of process spawn plus microseconds of Lua. The Lua cannot
overlap, but the **spawning** can: while one call runs its body, the next few
are already loading. Four pipelines the expensive part around the serial core
and still sits well below where the channel degrades. Eight is past the cliff.

The gate is a plain FIFO in `src/bridge/bridge.ts`, shared across every bridge
instance, because the thing being protected is the single Hammerspoon process
rather than any one object.

With the persistent socket as the default transport, the gate's numbers above
describe the **spawn path**: the bootstrap call and every call served by the
fallback. Socket-path calls flow through the same gate but a limit of four
merely caps pipelining depth on the one connection, which measurement showed
is harmless (forty simultaneous calls pipeline fine; Hammerspoon executes
them serially either way). The gate is kept at four rather than reduced to
one so the fallback path keeps its measured spawn-overlap benefit.

### Consequences worth knowing

- **A slow tool blocks every other tool.** There is one till. Any Lua that
  blocks (a network scan, a `usleep`, a modal dialog) stalls unrelated calls.
  Tool bodies must stay fast and must not do blocking I/O.
- **This is a correctness property, not a performance tweak.** Removing the
  gate does not make things faster, it makes calls fail.
- **It changes if the transport changes.** Moving from spawn-per-call to one
  persistent connection (`hs.httpserver` or a Unix socket) measured 0.95ms per
  call against 8.72ms, a 9.2x improvement, and removes the port churn entirely.
  With no process to spawn there is nothing left to pipeline, so the gate would
  correctly become a limit of one.

## Error taxonomy

`src/bridge/errors.ts`. Every bridge failure is one of a closed set of kinds.
A tool call returns a `BridgeResult`, which is a discriminated union on `ok`, so
consumers cannot read a value without handling the failure case first.

```ts
type BridgeErrorKind =
  'HsNotFound' | 'HsNotRunning' | 'LuaError' | 'Timeout' | 'PayloadTooLarge' | 'ProtocolError';

type BridgeError = {
  readonly kind: BridgeErrorKind;
  readonly message: string; // short technical description
  readonly hint: string; // what the user should do about it
  readonly detail?: string; // raw underlying output, logs only
};

type BridgeResult<TValue> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly error: BridgeError };
```

Errors are built by a small constructor per kind (`hsNotFound`, `hsNotRunning`,
`luaError`, `timeout`, `payloadTooLarge`, `protocolError`) rather than by
literal objects at call sites. That keeps the wording of a given failure in one
place, so improving a hint improves it everywhere.

| Kind              | Detected by                                                                                                     | Hint returned to the agent                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `HsNotFound`      | No candidate path exists, or `execFile` fails with `ENOENT`.                                                    | Install Hammerspoon, add `require("hs.ipc")`, or set `HS_MCP_HS_PATH`. The hint lists every path that was searched. |
| `HsNotRunning`    | The binary exists but the CLI cannot reach the app: non-zero exit, no result line, connection-shaped failure.   | Open Hammerspoon, confirm `require("hs.ipc")` is in `init.lua`, reload the config.                                  |
| `LuaError`        | A well-formed result line with `ok: false`. The Lua ran and threw.                                              | Check the arguments, or call `hs_console_tail` for the surrounding log output. The Lua message is carried through.  |
| `Timeout`         | The per-tool deadline passes with no reply. The caller is unblocked immediately; the child lingers (see below). | Hammerspoon may be blocked by a long-running Lua call or a modal dialog. Check the console, prefer smaller calls.   |
| `PayloadTooLarge` | The encoded ARGS blob exceeds the configured byte limit, checked before spawning anything.                      | Pass less data. Oversized payloads risk hitting the operating system's argument size limit.                         |
| `ProtocolError`   | The process exited cleanly but no line parsed as our result shape.                                              | This is a bug in the server, report it with the stderr log. The raw output is attached as `detail`.                 |

`PayloadTooLarge` is a pre-flight check, not a reaction to a failure. Base64
inflates a payload by about a third, and `execFile` passes the program as a
single argv entry, so a large enough argument object would hit `ARG_MAX` and
fail as an opaque spawn error. Rejecting it early turns that into a clear
message.

Note the `detail` field. Raw subprocess output goes to logs, not into the value
returned to the model, because that output is exactly the kind of untrusted text
that carries injected instructions. The agent gets `message` and `hint`, which
the server wrote.

Two more rules about this table.

**Every error carries an actionable hint.** An agent that gets "command failed"
retries the same call and fails the same way. An agent that gets "Hammerspoon is
not running, launch it and retry" can tell the user something true. Error
messages are the main interface a failing tool has with its caller, so they get
written as carefully as the success path.

**Detection lives in one place.** Matching CLI output to `HsNotRunning` involves
inspecting exit codes and message text, which is inherently a bit fragile.
Keeping all of it inside `errors.ts` means it is one file to fix when a
Hammerspoon release changes the wording, instead of a pattern smeared across
every tool.

## The server starts even when Hammerspoon is missing

A tempting design is to check for Hammerspoon at startup and exit if it is not
there. This server deliberately does not.

An MCP server that exits during startup gives the client nothing to work with.
The user sees "server failed" or a tool list that never arrives, with no
explanation, and the logs are somewhere they will not look. That is the worst
possible failure mode for a piece of software whose entire job is to be spawned
invisibly by another program.

So startup does no probing. Tools register, the transport connects, the server
answers. The first call that needs Hammerspoon returns a structured
`HsNotFound` or `HsNotRunning` with a hint the agent can read out loud and act
on. `hs_health` exists precisely so an agent can ask "is this working?" and get
a real answer instead of silence.

The rule generalises: **a diagnosable error beats a dead process.**

## Tool registry and tiers

`src/tools/registry.ts`.

A tool is a `ToolSpec`: a name, a tier, a description, a Zod v4 input schema, a
static Lua body, a timeout, and a function that shapes the decoded value into
MCP result content.

```ts
type ToolTier = 'safe' | 'unsafe';

type ToolSpec<TArgs> = {
  readonly name: string; // hs_snake_case, the wire format
  readonly tier: ToolTier;
  readonly description: string;
  readonly schema: z.ZodType<TArgs>;
  readonly lua: string; // static constant, never interpolated
  readonly timeoutMs: number;
};
```

Registration is a filter, not a runtime check:

1. `config/env.ts` parses `HS_MCP_TOOLS` into an allowed tier set. `safe` is the
   default. `all` means both tiers. Anything else is a startup error, because a
   typo that silently downgrades your configuration is worse than a crash.
2. The registry filters the spec list by that set.
3. Only the survivors are registered with the SDK.

The distinction matters. An unregistered tool is not in `tools/list`, so the
model never sees it, never suggests it, and cannot be talked into asking for it.
A tool that is registered but refuses at call time still advertises a capability
and still invites attempts. Filtering at registration is the stronger position.

`safe` today means read, inspect, and arrange: listing windows and apps, moving
and focusing them, searching docs, reading the console, reloading config, and
posting a notification. `unsafe` today means `hs_eval` and nothing else. The
tier is a property of the spec, so a new tool declares its own, and reviewers
argue about that declaration.

## The documentation index

`src/docs/docs-index.ts` is the one component that never touches the bridge.

Hammerspoon ships its complete API reference inside the application bundle as
`docs.json`: roughly 7MB, 140 modules, about 2057 entries. The index reads that
file lazily, on the first search rather than at startup, so a missing file
degrades one tool instead of the whole server. It flattens the document into
entries of qualified name, module, kind, signature, and one-line summary, then
discards the parsed JSON. The index is a few hundred kilobytes; the raw
document is mostly long-form prose we do not need to keep.

Ranking is deliberately coarse, ordered by how confidently the query can be
read as naming something:

| Match                                       | Score |
| ------------------------------------------- | ----- |
| Exact qualified name (`hs.window.setFrame`) | 1000  |
| Exact bare name (`setFrame`)                | 900   |
| Qualified-name prefix                       | 700   |
| Bare-name prefix                            | 600   |
| Qualified-name substring                    | 400   |
| Every query term appears in the summary     | 200   |

Anything scoring zero is excluded. The prose tier requires _every_ term to be
present, which stops a query like "window frame" from returning everything that
merely mentions windows.

Because it reads a file rather than talking to Hammerspoon, `hs_api_search`
works while Hammerspoon is closed. That is deliberate: the moment you most need
to look up an API is while writing configuration, which is often exactly when
Hammerspoon is not running cleanly.

## Why stdout is sacred

The MCP transport is JSON-RPC over stdio. Stdout **is** the protocol channel.
Any byte written to it that is not a protocol message corrupts the stream, and
the client's parser gives up. The symptom is a connection that dies for no
visible reason, which is a miserable thing to debug.

So `logging/logger.ts` writes to stderr and only stderr. It is the single module
allowed to touch the console at all, with a narrow ESLint exemption at the two
lines that do it. Everywhere else in `src/`, `console` is banned outright.
Verbosity comes from `HS_MCP_LOG_LEVEL` (`debug`, `info`, `warn`, `error`,
defaulting to `info`). Client applications capture stderr into their own logs,
so diagnostics are not lost, they are just kept out of the channel that cannot
tolerate them.

This also constrains the Lua side. Tool bodies `print` exactly one JSON line.
Debug prints from a tool body are tolerated by the parser (it takes the last
parseable line), but they are noise and should not survive review.

## Testing strategy

**Unit tests** (`test/unit/`, mirroring `src/` paths) run in CI on every push.
They cover the codec both ways, path discovery against a faked filesystem,
result parsing against recorded `hs` output in `test/fixtures/` (including the
extension-loading noise and malformed output), the error classifier, tier
filtering, and every tool's Zod schema. No Hammerspoon involved. The bridge is
designed so the process boundary is the only thing that needs stubbing.

**Integration tests** (`test/integration/`) drive a real `hs` binary against a
real Hammerspoon. They cannot run in CI: hosted macOS runners have no
Hammerspoon and no Accessibility grants, and window management without
Accessibility is meaningless. So they detect a working bridge at startup and
skip themselves when there is none. Running them without Hammerspoon is
harmless. Contributors run them locally for anything touching `src/bridge/` or
adding a tool.

**The end-to-end smoke test** (`test/e2e/smoke.mjs`, run with
`npm run test:e2e`) spawns the built binary exactly as a client does and speaks
the real MCP stdio protocol to it: `initialize`, then `tools/list`, then
several `tools/call`. It checks that the safe tier advertises thirteen tools
and hides `hs_eval`, that the gated tier advertises fourteen, that a schema
violation is rejected, that an injection payload comes back as inert data, and
that nothing but protocol ever reaches stdout. Unit tests verify the modules;
this verifies the artifact people actually install.

**The meta-test** (`test/unit/tools/lua-safety.test.ts`) enforces the codec
invariant by inspecting the source. It fails if any `*_LUA` constant contains a
template-literal interpolation, if such a constant is declared indented (which
would put it inside a function where it could capture a variable), or if
`bridge.run` is ever called with anything other than an identifier ending in
`LUA`. It also asserts that a meaningful number of Lua constants exist, so the
check cannot quietly pass by matching nothing.

It is not testing behaviour, it is testing that a design rule still holds.
Security properties that depend on people remembering things decay, so having a
machine watch this one is worth the small cost.

It is the second layer, not the first. On its own it is three regular
expressions over source text, and an adversarial review found several rewrites
that slip past: build the program with `+` or `.join()`, launder it through a
second variable before assigning it to a `*_LUA` name, or call the bridge
through a destructured `run`.

**The first layer is the type system**, and it catches all of those.

`HammerspoonBridge.run` does not accept a `string`. It accepts a `LuaProgram`,
a branded type whose only constructor is the `lua` template tag in
`src/bridge/lua.ts`:

```ts
export type LuaProgram = string & { readonly [luaProgramBrand]: true };

export function lua(source: TemplateStringsArray, ...values: never[]): LuaProgram;
```

`...values: never[]` is what does the work. A tagged template with a
substitution passes that value as an argument, and nothing is assignable to
`never`, so `lua\`return ${x}\``does not compile. Concatenation,`.join()`,
`.replace()`, `String.raw`, and plain strings all fail too, because none of
them produce the brand.

`test/unit/bridge/lua-type-safety.test.ts` asserts this. Each bypass sits under
a `@ts-expect-error`, so if any of them ever starts compiling, TypeScript
reports the directive as unused and the typecheck fails. The test cannot rot
into a no-op the way a regex can.

Two honest limits. Anyone who can commit can still write `as LuaProgram`, so
this stops mistakes rather than a hostile maintainer, and the meta-test bans
that cast and the named escape hatch anywhere under `src/`. And the brand is
erased at runtime: it is a compile-time claim, which is exactly where the
mistake it prevents would happen.

## Future work

Not committed to, not scheduled, listed so the direction is visible.

- **Window layout presets.** Named multi-window arrangements applied in one
  call, instead of the agent issuing a sequence of `hs_move_window` calls and
  hoping about ordering.
- **Event watchers.** Hammerspoon can watch for window, application, and screen
  events. Surfacing those as MCP notifications would let an agent react to the
  desktop rather than only poll it. This needs thought about lifecycle and about
  how much a subscription can leak.
- **MCP registry publication.** Listing the server in public MCP registries once
  the tool surface is stable enough to promise.

Anything that would widen the default tier gets the same argument every time:
what happens when an injected prompt calls it?
