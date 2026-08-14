<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/vukvukovich/hammerspoon-mcp/main/docs/assets/banner-dark.svg">
  <img src="https://raw.githubusercontent.com/vukvukovich/hammerspoon-mcp/main/docs/assets/banner-light.svg" alt="Hammerspoon MCP" width="680">
</picture>

[![npm](https://img.shields.io/npm/v/%40vukvukovich%2Fhammerspoon-mcp?style=flat-square&label=npm&color=ffcc66)](https://www.npmjs.com/package/@vukvukovich/hammerspoon-mcp)
[![CI](https://img.shields.io/github/actions/workflow/status/vukvukovich/hammerspoon-mcp/ci.yml?branch=main&style=flat-square&label=ci)](https://github.com/vukvukovich/hammerspoon-mcp/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/%40vukvukovich%2Fhammerspoon-mcp?style=flat-square&label=node&color=5fa04e)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-4c72b0?style=flat-square)](./LICENSE)

Let an AI agent drive your Mac through Hammerspoon, without ever splicing its
input into Lua source.

</div>

## What it is

[Hammerspoon](https://www.hammerspoon.org) is a macOS automation app you script
in Lua. It exposes a command line interface through its `hs.ipc` module, so
`hs -c "<lua>"` runs Lua inside the running Hammerspoon process.

This project is an MCP (Model Context Protocol) server that sits in front of
that CLI. It gives an agent a set of typed tools (list windows, move a window,
focus an app, search the Hammerspoon API docs, tail the console, reload your
config) and translates each tool call into a Lua program that Hammerspoon runs.

It speaks MCP over stdio, so any MCP client can use it: Claude Code, Claude
Desktop, or your own.

## Project status

Published on npm as `v0.4.x`: 38 safe-tier tools, plus 3 gated behind
`HS_MCP_TOOLS=all`. Still pre-1.0, so tool names and argument shapes can
change between minor versions.

## Why this one is different

### 1. Injection-safe by construction

Most of the risk in a "run Lua for me" bridge is the moment you build the Lua.
The usual approach is to interpolate the arguments into a source string and
escape the dangerous characters. Escaping is a discipline, and disciplines slip.

This server never interpolates. Every tool's Lua body is a **static constant**
in the TypeScript source. Arguments travel separately:

1. The validated argument object is JSON-encoded.
2. That JSON is base64-encoded.
3. The base64 text is spliced once, into one fixed prelude line:

```lua
local ARGS = hs.json.decode(hs.base64.decode("<base64>"))
```

The tool body then reads `ARGS.title`, `ARGS.windowId`, and so on.

The base64 alphabet is `A-Z`, `a-z`, `0-9`, `+`, `/`, and `=`. It contains no
quote, no backslash, no newline, no square bracket, and no hyphen. So the
payload cannot close the Lua string, cannot start an escape sequence, cannot
open a long bracket, and cannot open a comment. Injection is impossible because
of the alphabet, not because someone remembered to escape correctly.

There is no shell layer either. The server talks to Hammerspoon over a
persistent Unix socket, falling back to `spawn(hsPath, ["-c", lua])` with an
argv array, so no `sh` ever parses the command on either path.

### 2. Tiered tools, safe by default

The default tier is `safe`: read, inspect, and arrange operations. Arbitrary
Lua evaluation exists as `hs_eval`, but it is off unless you set
`HS_MCP_TOOLS=all`.

See [Security](#security) for the reasoning. Short version: the threat is prompt
injection, not you.

### 3. Built for the config-development loop

Most of the value of Hammerspoon is your own `init.lua`. So the server helps you
write it, not just drive it:

- `hs_api_search` searches Hammerspoon's bundled API documentation, so the agent
  can look up the real signature of `hs.window.moveToUnit` instead of guessing.
- `hs_console_tail` reads back the Hammerspoon console, so the agent can see its
  own errors.
- `hs_reload_config` reloads `init.lua` after an edit.

Edit, reload, read the console, fix. The agent can run that loop itself.

## Quick start

### Prerequisites

- macOS.
- Node.js 24 or newer.
- Hammerspoon, installed and running:

  ```sh
  brew install --cask hammerspoon
  ```

- The `hs.ipc` module loaded in your Hammerspoon config. Add this line to
  `~/.hammerspoon/init.lua`:

  ```lua
  require("hs.ipc")
  ```

  Then reload your config from the Hammerspoon menu bar icon. This is what
  installs and enables the `hs` command line tool. Without it, `hs -c` has
  nothing to talk to.

Verify the bridge by hand before wiring up any client:

```sh
hs -c "return 1 + 1"
```

If that prints `2`, you are ready.

### Add it to your MCP client

Claude Code:

```sh
claude mcp add hammerspoon -- npx -y @vukvukovich/hammerspoon-mcp
```

Any client that takes an `mcpServers` JSON block:

```json
{
  "mcpServers": {
    "hammerspoon": {
      "command": "npx",
      "args": ["-y", "@vukvukovich/hammerspoon-mcp"]
    }
  }
}
```

To opt into the unsafe tier, add the environment variable. Claude Code:

```sh
claude mcp add hammerspoon -e HS_MCP_TOOLS=all -- npx -y @vukvukovich/hammerspoon-mcp
```

JSON:

```json
{
  "mcpServers": {
    "hammerspoon": {
      "command": "npx",
      "args": ["-y", "@vukvukovich/hammerspoon-mcp"],
      "env": {
        "HS_MCP_TOOLS": "all"
      }
    }
  }
}
```

Ask the agent to call `hs_health` first. It reports whether the `hs` binary was
found, whether Hammerspoon is running, and whether `hs.ipc` answered.

## Tool reference

Forty-one tools: thirty-eight in the safe tier, three gated.

| Tool                  | Tier   | What it does                                                                                                                                                                                                    |
| --------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hs_health`           | safe   | Report bridge status: resolved `hs` path, whether Hammerspoon answers, its version.                                                                                                                             |
| `hs_api_search`       | safe   | Search Hammerspoon's bundled API reference and return exact signatures.                                                                                                                                         |
| `hs_console_tail`     | safe   | Return the last N lines of the Hammerspoon console.                                                                                                                                                             |
| `hs_reload_config`    | safe   | Reload `~/.hammerspoon/init.lua`.                                                                                                                                                                               |
| `hs_notify`           | safe   | Show a transient on-screen alert, without stealing focus.                                                                                                                                                       |
| `hs_list_windows`     | safe   | List windows, with id, title, owning app, screen, and frame.                                                                                                                                                    |
| `hs_focus_window`     | safe   | Focus a window by id, or by a substring of its title.                                                                                                                                                           |
| `hs_move_window`      | safe   | Move or resize a window by id, in absolute screen pixels.                                                                                                                                                       |
| `hs_window_layout`    | safe   | Snap a window to a named preset such as `left-half` or `quarter-top-left`.                                                                                                                                      |
| `hs_list_apps`        | safe   | List running applications, with bundle id, PID, and window count.                                                                                                                                               |
| `hs_launch_app`       | safe   | Launch an application by name, or focus it if it is already running.                                                                                                                                            |
| `hs_focus_app`        | safe   | Bring an already-running application to the front.                                                                                                                                                              |
| `hs_screens`          | safe   | List screens, with id, name, frame, and which one is primary.                                                                                                                                                   |
| `hs_machine_status`   | safe   | Battery, brightness, wifi, idle time, audio, and host info in one call.                                                                                                                                         |
| `hs_audio_devices`    | safe   | List audio output and input devices, showing the current default.                                                                                                                                               |
| `hs_audio_set_device` | safe   | Switch the default output or input device, for example to headphones.                                                                                                                                           |
| `hs_audio_volume`     | safe   | Get or set volume and mute on the default device.                                                                                                                                                               |
| `hs_brightness`       | safe   | Get or set built-in display brightness.                                                                                                                                                                         |
| `hs_media_control`    | safe   | Play, pause, skip, or go back, via system media keys.                                                                                                                                                           |
| `hs_list_spaces`      | safe   | List desktops (Spaces) per screen, with positions and which is current.                                                                                                                                         |
| `hs_goto_space`       | safe   | Switch desktop by id or by 1-based position.                                                                                                                                                                    |
| `hs_eval`             | unsafe | Evaluate arbitrary Lua. Requires `HS_MCP_TOOLS=all`.                                                                                                                                                            |
| `hs_applescript`      | unsafe | Run AppleScript. Reaches Mail, Notes, Reminders, Finder. Requires `HS_MCP_TOOLS=all`.                                                                                                                           |
| `hs_ui_press`         | unsafe | Press a UI element found by `hs_ui_inspect`. Refuses to act without an `expectLabel` or `expectRole` from the inspection, and refuses when the element there no longer matches it. Requires `HS_MCP_TOOLS=all`. |

`hs_window_layout` presets: `left-half`, `right-half`, `top-half`, `bottom-half`,
`maximize`, `center`, `thirds-left`, `thirds-center`, `thirds-right`,
`two-thirds-left`, `two-thirds-right`, and the four `quarter-*` corners.
Positions are computed from the screen's usable frame, so they respect the menu
bar and the Dock, and they work on a second monitor whose origin is negative.

`hs_ui_inspect` returns structure and labels only, never the contents of text
fields or documents. Structure is what an agent needs in order to act; contents
are what a password manager is made of.

Tools in the `unsafe` tier are not registered at all unless you opt in. A client
connected with default settings will not see `hs_eval`, `hs_applescript`, or
`hs_ui_press` in its tool list.

## Configuration

All configuration is environment variables, read once at startup.

| Variable           | Values                                 | Default             | Meaning                                                                                                                                                         |
| ------------------ | -------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HS_MCP_TOOLS`     | `safe` \| `all`                        | `safe`              | Which tiers to register. `all` adds the unsafe tier: `hs_eval`, `hs_applescript`, and `hs_ui_press`.                                                            |
| `HS_MCP_TRANSPORT` | `socket` \| `spawn`                    | `socket`            | How Lua reaches Hammerspoon: a persistent Unix socket (~10x faster, self-installed on first call, falls back to spawn by itself), or one `hs` process per call. |
| `HS_MCP_HS_PATH`   | absolute path                          | auto-detected       | Path to the `hs` binary. Set this if your install is somewhere unusual.                                                                                         |
| `HS_MCP_DOCS_PATH` | absolute path                          | from the app bundle | Path to Hammerspoon's bundled API documentation JSON, used by `hs_api_search`.                                                                                  |
| `HS_MCP_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` | `info`              | Verbosity of the stderr log. Logs never touch stdout, which carries the protocol.                                                                               |

An unrecognised value for `HS_MCP_TOOLS` logs a loud warning and falls back to
`safe` - never to the wider tier. A typo can cost you the gated tools, but it
can never grant them. For the discovery order behind the `hs` path default,
see [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## Security

Read this section before you set `HS_MCP_TOOLS=all`.

### Where the server runs

The server is a local process. Your MCP client spawns it, talks to it over
stdio, and it runs as your user account. There is no network listener and no
remote surface.

That also means it inherits your permissions. Hammerspoon holds macOS TCC
(Transparency, Consent, and Control) grants such as Accessibility, and possibly
Screen Recording and Automation. Anything running inside Hammerspoon acts with
those grants. This server does not add permissions and it cannot take any away.

### The actual threat model

The risk is not that you are untrustworthy. The risk is **prompt injection**.

An agent reads untrusted text constantly: web pages, README files, issue bodies,
log lines, the output of other tools. Any of that text can contain instructions.
Sometimes the agent follows them. This is not hypothetical and it is not solved.

So the question for every tool is: if the agent is talked into calling this, how
bad is it?

- A curated verb has a small blast radius. Worst case with `hs_move_window`, a
  window ends up in the wrong place. Annoying, reversible, visible.
- Arbitrary Lua has no blast radius limit. Hammerspoon's Lua can run shell
  commands, read the clipboard, capture the screen, watch keystrokes, and make
  network requests. One successful injection is full control of the machine,
  quietly.

That gap is the whole reason for tiers.

### What `HS_MCP_TOOLS=all` means

It registers `hs_eval`, `hs_applescript`, and `hs_ui_press`. From that point
the agent can execute any Lua or AppleScript it can write, and press UI
elements, inside a process that holds your Accessibility grants. Treat it as
handing over a shell that also has the screen and the keyboard.

It is a genuinely useful mode. Writing and debugging Hammerspoon config is much
faster when the agent can try a snippet directly. Use it in a session you are
watching, for work you asked for, and turn it back off. Do not leave it on in a
long-running or unattended agent that browses the web.

Safe by default is not a claim that you cannot be trusted with the dangerous
tool. It is a claim that turning it on should be a decision you made on purpose,
on a specific day, for a specific reason.

### What is deliberately not here

These are not oversights. They are refusals, with reasons.

- **Raw shell execution.** Agents already have shell tools, sandboxed and
  audited by their own host. A Mac-control server does not need to be a second,
  worse shell.
- **Keystroke and click synthesis.** Synthetic typing into whatever window
  happens to be focused is arbitrary code execution with extra steps. If that
  window is a terminal, "type this text" and "run this command" are the same
  operation.
- **Clipboard reads.** Your clipboard holds passwords, tokens, and private
  messages, often within seconds of you copying them. A tool that reads it is an
  exfiltration primitive pointed at your most sensitive short-lived data.
- **Screenshots.** Same reasoning. A screen capture is everything visible,
  including the windows the agent was not asked about.

Some of these may come back later, each behind its own explicit opt-in, the way
`hs_eval` is gated now. None of them will ever be in the default tier.

### Reporting a vulnerability

Open a
[security advisory](https://github.com/vukvukovich/hammerspoon-mcp/security/advisories/new)
on the repository rather than a public issue.

## One thing to know: calls are queued

Hammerspoon runs Lua on a single thread, so it executes one call at a time no
matter how many arrive. Measured: four 400ms calls issued together take 1629ms,
not 417ms.

The server queues accordingly, four in flight at once. That is not a throttle
for its own sake. Left unbounded, simultaneous calls do not merely wait, they
start failing (5 of 15 succeeded in testing) and the pattern crashed
Hammerspoon twice inside its own IPC layer.

The practical consequence: **a slow tool blocks the others**, because there is
only one queue. If something feels stuck, one call is usually holding it.
[ARCHITECTURE.md](./docs/ARCHITECTURE.md#concurrency-calls-are-queued-four-at-a-time)
has the measurements.

## Troubleshooting

Start with `hs_health`. It is designed to tell you which of these you have.

**`hs` not found.** The server looks in a fixed list of locations and then on
`PATH`. If your Hammerspoon lives somewhere else, set `HS_MCP_HS_PATH` to the
absolute path of the binary. Note that GUI-launched MCP clients often have a
minimal `PATH` that does not include Homebrew, so a path that works in your
terminal may not work for the server. When in doubt, set the variable.

**Hammerspoon is not running.** The `hs` CLI is a client. It needs the
Hammerspoon app running to talk to. Launch Hammerspoon and retry.

**`hs.ipc` is not loaded.** Hammerspoon is running but nothing answers, or the
`hs` binary does not exist at all. Both usually mean `require("hs.ipc")` is
missing from `~/.hammerspoon/init.lua`. Add it, reload the config from the menu
bar icon, then check `hs -c "return 1 + 1"` in a terminal.

**Tools are missing from the client's list.** If `hs_eval` is the missing one,
that is the default tier working as intended. Set `HS_MCP_TOOLS=all` in the
client's server config, then restart the client so the server is respawned with
the new environment.

**A tool times out.** Hammerspoon is single-threaded. If your config is stuck in
a loop or a modal dialog is blocking, calls will not return. Check the console
with `hs_console_tail`, or reload the config.

## Development

```sh
git clone https://github.com/vukvukovich/hammerspoon-mcp.git
cd hammerspoon-mcp
npm install
```

| Script                     | What it does                                          |
| -------------------------- | ----------------------------------------------------- |
| `npm run build`            | Compile TypeScript to `dist/` with `tsc`.             |
| `npm run typecheck`        | Type check everything, no emit.                       |
| `npm run lint`             | ESLint.                                               |
| `npm run lint:fix`         | ESLint with autofix.                                  |
| `npm run format`           | Prettier, write.                                      |
| `npm run format:check`     | Prettier, check only.                                 |
| `npm test`                 | Unit tests (Vitest).                                  |
| `npm run test:watch`       | Unit tests in watch mode.                             |
| `npm run test:coverage`    | Unit tests with coverage.                             |
| `npm run test:integration` | Integration tests. Needs a real, running Hammerspoon. |
| `npm run check`            | Everything CI runs: typecheck, lint, format, tests.   |

Stack: TypeScript 5.9 in strict mode, ESM only, Node 24+, the
`@modelcontextprotocol/server` v2 SDK, Zod v4 for schemas, Vitest 4, and
typescript-eslint 8 with Prettier 3. Plain `tsc` for the build, no bundler.

Before contributing, read [CONVENTIONS.md](./CONVENTIONS.md) (binding rules) and
[CONTRIBUTING.md](./CONTRIBUTING.md) (workflow and commit format). The design is
written up in [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## License

MIT. Copyright (c) 2026 Vuk Vukovich. See [LICENSE](./LICENSE).

Hammerspoon is a separate project with its own license and is not affiliated
with this one.
