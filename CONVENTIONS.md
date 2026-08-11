# Conventions

These rules are binding. Code review checks them. If you disagree with one, open
an issue and argue it there, do not quietly deviate in a pull request.

Everything here is enforced by ESLint, Prettier, and `tsc` where it can be.
Where a rule cannot be automated, it still applies.

## Files and folders

- **kebab-case** for every file and directory name: `hs-path.ts`,
  `list-windows.ts`, `tools/safe/`.
- **One concern per file.** A file holds one tool, or one type of thing. If you
  need "and" to describe what a file does, split it.
- **`.ts` only.** No `.js` and no `.cjs` in `src/`. The package is ESM only.
- **Relative imports carry the `.js` extension**, because that is what Node's
  ESM resolver wants at runtime: `import { resolveHsPath } from "./hs-path.js"`.
  The file on disk is still `hs-path.ts`.

### Layout

```
src/
  main.ts               bin entry, shebang, signal handling
  index.ts              library exports
  server.ts             MCP server construction and tool registration
  config/env.ts         env parsing: HS_MCP_TOOLS, HS_MCP_HS_PATH, HS_MCP_DOCS_PATH
  logging/logger.ts     stderr-only logger (stdout is the MCP protocol channel)
  bridge/
    hs-path.ts          locate the hs binary
    codec.ts            ARGS encoding, result decoding
    errors.ts           error taxonomy
    bridge.ts           execFile orchestration
  tools/
    registry.ts         ToolSpec type, tier filtering, SDK registration
    safe/               one file per tool or tool group
    unsafe/eval.ts
test/
  unit/                 mirrors src/ paths
  integration/          requires a real Hammerspoon, auto-skips without it
  fixtures/
```

### Test file placement

A unit test mirrors the path of the file it tests, under `test/unit/`, with a
`.test.ts` suffix.

| Source                      | Test                                   |
| --------------------------- | -------------------------------------- |
| `src/bridge/codec.ts`       | `test/unit/bridge/codec.test.ts`       |
| `src/tools/safe/windows.ts` | `test/unit/tools/safe/windows.test.ts` |
| `src/config/env.ts`         | `test/unit/config/env.test.ts`         |

No test files inside `src/`. Integration tests live in `test/integration/` and
do not mirror anything, because they test end to end behaviour.

## Naming

| Kind                              | Style                   | Example                       |
| --------------------------------- | ----------------------- | ----------------------------- |
| Types, interfaces, classes, enums | `PascalCase`            | `ToolSpec`, `BridgeError`     |
| Functions, methods                | `camelCase`             | `resolveHsPath`, `encodeArgs` |
| Variables, parameters             | `camelCase`             | `hsPath`, `windowId`          |
| Object properties                 | `camelCase`             | `{ bundleId, screenId }`      |
| Module-level immutable constants  | `SCREAMING_SNAKE_CASE`  | `DEFAULT_TIMEOUT_MS`          |
| Generic type parameters           | `T`-prefixed PascalCase | `TArgs`, `TResult`            |

**No `I` prefix on interfaces.** It is `ToolSpec`, never `IToolSpec`. The `I` is
Hungarian notation for a language that does not need it.

`SCREAMING_SNAKE_CASE` is for module-level constants that are genuinely fixed
values, like a timeout or a lookup table. A `const` that holds a function or a
configured object is still `camelCase`.

Generic parameters get real names. `TArgs` beats `T` once there is more than one
of them, and even a lone one is clearer named.

### Project-specific naming

Two rules that override the table above, because they encode external contracts.

**MCP tool names are `hs_snake_case`.** That is the wire format the protocol
carries, so it is not ours to prettify: `hs_list_windows`, `hs_api_search`,
`hs_reload_config`. Every tool name starts with the `hs_` prefix. The TypeScript
identifier holding the spec stays camelCase, so `listWindowsTool` describes the
tool named `hs_list_windows`.

**Lua source constants are `SCREAMING_SNAKE_CASE` with a `_LUA` suffix.**

```ts
const LIST_WINDOWS_LUA = `
  local out = {}
  for _, w in ipairs(hs.window.visibleWindows()) do
    out[#out + 1] = { id = w:id(), title = w:title() }
  end
  return out
`;
```

The suffix makes Lua constants greppable, and greppability is a security
feature. The meta-test that guards against string splicing finds them by that
name.

Tool argument fields keep camelCase on the TypeScript side, and the Lua body
reads them the same way: `ARGS.windowId`. The codec does not rename anything.

## TypeScript rules

The compiler is already strict, with `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, and friends. These rules cover what the compiler
does not.

- **No `any`.** Not as a parameter type, not as a return type, and definitely
  not as an escape hatch. Use `unknown` and narrow it.
- **No non-null assertions (`!`).** If you know a value is present, prove it
  with a check the compiler can see. If the check is genuinely redundant, throw
  in the impossible branch, do not assert it away.
- **No `as` casts**, except at a genuine boundary: parsed JSON, a Node API that
  types a value too loosely, an SDK type that does not line up. Every such cast
  needs a comment saying why it is safe. Prefer a Zod parse over a cast whenever
  the value came from outside the process.
- **`type` over `interface`** for object shapes. Use `interface` only when you
  need declaration merging, which in this codebase means basically never.
- **Discriminated unions for anything that can fail.** Results and errors carry
  a `kind` field and get narrowed by it. See `bridge/errors.ts`.
- **`readonly` where practical.** Readonly properties on result types, and
  `readonly T[]` for arrays you do not intend to mutate.
- **Exhaustive switches**, with a `never` check in the default branch so adding
  a union member breaks the build:

  ```ts
  function allowedTiers(setting: ToolsSetting): readonly ToolTier[] {
    switch (setting) {
      case 'safe':
        return ['safe'];
      case 'all':
        return ['safe', 'unsafe'];
      default: {
        const unreachable: never = setting;
        throw new Error(`unhandled tools setting: ${String(unreachable)}`);
      }
    }
  }
  ```

- **Zod v4 schemas are the single source of truth for tool inputs.** Derive the
  TypeScript type with `z.infer`. Never hand-write a type next to a schema and
  hope they stay in sync.
- **No default exports.** Named exports only, so renames are greppable.

## Hard prohibitions

Four things will get a pull request rejected on sight. Each one exists because
breaking it breaks a property the project promises.

**1. Never build Lua by string interpolation.**

```ts
// NO. Not with escaping, not with a helper, not "just this once".
const lua = `hs.alert.show("${args.message}")`;
```

Arguments go through the codec and arrive as `ARGS`. The Lua body is a static
constant. A meta-test scans every `*_LUA` constant and fails if it contains a
template-literal interpolation.

More importantly, the compiler enforces it. Write every Lua body with the
`lua` template tag, and it becomes a `LuaProgram`, which is the only type
`bridge.run` accepts:

```ts
const MOVE_WINDOW_LUA = lua`
local w = hs.window.get(ARGS.id)
`;
```

Interpolation does not compile, and neither does concatenation, `.join()`,
`.replace()`, or a plain string. You do not have to remember the rule; you
cannot express the violation. The regex meta-test stays as a cheap second
layer, and it also bans `as LuaProgram` and the `unsafeLuaFromString` escape
hatch anywhere under `src/`.

```ts
// Yes.
const SHOW_ALERT_LUA = `hs.alert.show(ARGS.message)`;
```

**2. Never write to stdout.**

Stdout is the MCP protocol channel. One stray byte corrupts the JSON-RPC stream
and the client drops the connection. No `console.log`, no `process.stdout.write`
outside the SDK's transport. Diagnostics go through `logging/logger.ts`, which
writes to stderr and nowhere else. ESLint bans `console` in `src/`.

**3. Never use `execSync` or any synchronous child process call.**

The server has one thread and an open protocol connection on it. A synchronous
subprocess blocks the event loop, so the server stops answering the client while
Hammerspoon thinks. Use the promisified `execFile`, always with a timeout.

Also: `execFile` with an argv array, never `exec` with a command string. `exec`
spawns a shell, which reintroduces the quoting problem we removed.

**4. Never silence the type checker.**

No `as any`, no `@ts-ignore`, no `@ts-expect-error` outside a test that is
deliberately checking a type error. If the types are wrong, fix the types.

## Imports

One blank line between groups, in this order:

1. Node builtins, with the `node:` prefix (`node:child_process`, `node:path`).
2. External dependencies (`@modelcontextprotocol/server`, `zod`).
3. Internal modules, by relative path.
4. Type-only imports, using `import type`.

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { z } from 'zod';

import { encodeArgs } from '../bridge/codec.js';

import type { ToolSpec } from './registry.js';
```

`verbatimModuleSyntax` is on, so type-only imports must say `import type`. The
linter will tell you.

## Comments

Comments explain **why**, never **what**. The code already says what it does.

Write a comment when there is a constraint a reader cannot see: an external
contract, a workaround, an ordering that matters, a security property.

```ts
// The hs CLI prints "-- Loading extension: ..." lines before our output,
// so take the last JSON-parseable line rather than the first.
```

Do not write a comment that restates the line below it.

```ts
// increment the counter
counter += 1;
```

Use JSDoc on exported symbols where the name is not enough on its own,
especially anything in `index.ts`. Skip it on obvious internal helpers.

`TODO` comments need a name or an issue number, otherwise they are litter:
`// TODO(#42): support unit rects on non-primary screens`.

## Commits

Commit messages follow the **OpenCommits** standard:
`Type[!] [scope] description`.

```
Add tools hs_api_search over the bundled hammerspoon docs
Fix bridge parse the last json line so extension noise is ignored
Sec server gate hs_eval behind HS_MCP_TOOLS=all
```

The full specification, the type list, the scopes this project uses, and the
validation regex are in [CONTRIBUTING.md](./CONTRIBUTING.md#commit-messages). A
`commit-msg` hook enforces it.
