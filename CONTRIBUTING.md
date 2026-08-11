# Contributing

Thanks for taking a look. This document covers how to work in the repository.
[CONVENTIONS.md](./CONVENTIONS.md) covers how the code must be written, and it
is binding. Read it before your first pull request.

## Before you start

Open an issue first for anything larger than a bug fix or a typo. That is
especially true for new tools. A new tool is a new capability handed to an
agent, so which tier it belongs in is worth agreeing on before you write it.

## Prerequisites

- macOS. The server only targets macOS, because Hammerspoon only runs there.
- Node.js 24 or newer (Active LTS). Check with `node --version`.
- npm. The lockfile is npm's, so please do not switch package managers.
- Hammerspoon, for integration tests only. Unit tests do not need it.

If you want to run the integration tests, install Hammerspoon and enable its
command line interface:

```sh
brew install --cask hammerspoon
```

Then add `require("hs.ipc")` to `~/.hammerspoon/init.lua`, reload the config from
the Hammerspoon menu bar icon, and confirm the bridge works:

```sh
hs -c "return 1 + 1"
```

## Setup

```sh
git clone https://github.com/vukvukovich/hammerspoon-mcp.git
cd hammerspoon-mcp
npm install
git config core.hooksPath .githooks
```

That last line is not optional. It points git at the repository's hooks
directory, which installs the `commit-msg` hook that validates commit messages.
Git does not enable repository hooks automatically, so without it your commits
will fail in CI instead of on your machine.

## Scripts

| Script                     | What it does                                                   |
| -------------------------- | -------------------------------------------------------------- |
| `npm run build`            | Compile to `dist/` with `tsc`. No bundler.                     |
| `npm run typecheck`        | Type check `src/` and `test/`, no emit.                        |
| `npm run lint`             | ESLint.                                                        |
| `npm run lint:fix`         | ESLint with autofix.                                           |
| `npm run format`           | Prettier, write.                                               |
| `npm run format:check`     | Prettier, check only. This is what CI runs.                    |
| `npm test`                 | Unit tests.                                                    |
| `npm run test:watch`       | Unit tests in watch mode. Use this while developing.           |
| `npm run test:coverage`    | Unit tests with a coverage report.                             |
| `npm run test:integration` | Integration tests. Needs a real, running Hammerspoon.          |
| `npm run check`            | Typecheck, lint, format check, unit tests. Run before pushing. |

`npm run check` is the same set CI runs. If it passes locally it should pass
there.

## Tests

Vitest 4, two projects.

**Unit tests** live in `test/unit/` and mirror the `src/` path of the file they
test. `src/bridge/codec.ts` is tested by `test/unit/bridge/codec.test.ts`. They
never touch a real Hammerspoon. The bridge is exercised against fixtures of
recorded `hs` output, which live in `test/fixtures/`. These run in CI on every
push.

```sh
npm test
npm run test:watch
```

**Integration tests** live in `test/integration/` and drive a real Hammerspoon
through a real `hs` binary. They cannot run in CI, since GitHub's macOS runners
have no Hammerspoon and no Accessibility grants. They detect that at startup and
skip themselves rather than fail, so running them without Hammerspoon is
harmless, just useless.

```sh
npm run test:integration
```

Run these locally before any pull request that touches `src/bridge/` or adds a
tool. Say in the pull request description whether you did.

There is also a **meta-test** that scans the Lua constants in `src/tools/` and
fails if any of them contains a template-literal interpolation. It is a
regression guard for the project's core security property. If it fails, you are
building Lua by string splicing. Do not delete the test, fix the code.

## Branches

Name branches `type/short-slug`, where `type` is the lowercased OpenCommits type
you expect the branch's main commit to use.

```
add/api-search-tool
fix/console-tail-line-limit
ref/split-window-tools
doc/architecture-bridge-contract
chr/bump-typescript-eslint
```

Lowercase, hyphen-separated, short. The slug says what changed, not who asked.

## Commit messages

This project uses **OpenCommits**. It is close to Conventional Commits in
spirit, but the syntax is different, so muscle memory from `feat(scope): thing`
will produce invalid messages here.

### Format

```
Type[!] [scope] description
```

Plain spaces separate the parts. **No colon, no parentheses, no brackets.** The
square brackets above mean "optional", they are not literal characters.

```
Add bridge base64 args codec
Fix tools hs_move_window rejects negative frames
Doc readme document the tool tiers
```

### Type

Mandatory. Exactly three letters, capitalised: first letter upper, next two
lower.

Core types:

| Type  | Use for                                                  |
| ----- | -------------------------------------------------------- |
| `Add` | New features and user-facing capabilities.               |
| `Fix` | Bug fixes.                                               |
| `Ref` | Internal structural change with no behaviour change.     |
| `Opt` | Performance improvements.                                |
| `Rmv` | Removing something.                                      |
| `Doc` | Documentation and comments.                              |
| `Tst` | Tests.                                                   |
| `Sty` | Cosmetic only: formatting, lint fixes. No logic touched. |
| `Chr` | CI/CD, tooling, dependencies, infrastructure.            |
| `Rev` | Reverting an earlier commit.                             |

Extended types this project also uses:

| Type  | Use for                                          |
| ----- | ------------------------------------------------ |
| `Mov` | Relocating a file or module, contents unchanged. |
| `Rnm` | Renames.                                         |
| `Dep` | Deprecating something that still works.          |
| `Sec` | Security-relevant changes.                       |
| `Cfg` | Configuration-only changes.                      |

`Mov` and `Rnm` are for pure moves and pure renames. If you moved a file and
also changed what it does, that is two commits.

### Scope

Optional, lowercase, at most two. Include a scope only when leaving it out would
hide meaningful location context. A repository-wide change does not need one.

Scopes used in this project:

`bridge`, `tools`, `server`, `docs`, `ci`, `deps`, `test`

Two scopes are for changes that genuinely straddle two areas:

```
Ref bridge tools move lua constants next to their tool specs
```

### Description

Lowercase first letter. Specific. Concise. No trailing period.

Describe the change, not the file you edited. "fix off-by-one in console tail
line count" is useful. "update bridge.ts" is not.

### Breaking changes

Put `!` directly after the Type, no space:

```
Fix! bridge argument encoding now rejects oversized payloads
Rmv! tools drop hs_eval from the safe tier
```

### Versioning

Commit types map to SemVer:

| Commit            | Bump  |
| ----------------- | ----- |
| Any type with `!` | MAJOR |
| `Add`, `Dep`      | MINOR |
| `Fix`, `Sec`      | PATCH |
| Everything else   | none  |

While the project is on `v0.x`, a `!` commit bumps the minor version instead,
which is normal pre-1.0 practice.

### One type per commit

If your commit needs two types, it is two commits. A commit that adds a feature
and reformats three unrelated files is an `Add` hiding a `Sty`. Split it. Small
focused commits make `Rev` cheap and `git bisect` useful.

### Validation

The `commit-msg` hook checks each message against this regex (the extended
profile, meaning core types plus the extended ones above):

```
^(Add|Fix|Ref|Opt|Rmv|Doc|Tst|Sty|Chr|Mov|Rnm|Dep|Sec|Cfg|Rev)(!)?( [a-z][a-z0-9]*){0,2} [a-z].+$
```

Enable it once per clone with `git config core.hooksPath .githooks`. Git does
not pick up repository hooks on its own, so this is the one setup step that is
easy to forget.

CI runs the same check on pull requests, in a dedicated `commit-messages` job
that validates every subject in the merge-base range. It mirrors the hook line
for line, so the two never disagree, and skipping the hook locally only moves
the failure later. Commits authored by Dependabot are skipped by author,
because Dependabot renders its configured `Chr` prefix as `Chr:` with a colon,
which the grammar rejects. Skipping by author rather than relaxing the pattern
keeps the rule identical for anything a human writes.

### Examples

Real shapes from this project:

```
Add tools hs_api_search over the bundled hammerspoon docs
Add bridge per-tool timeout for execFile calls
Fix bridge parse the last json line so extension noise is ignored
Fix tools hs_list_windows omits windows with no id
Sec server gate hs_eval behind HS_MCP_TOOLS=all
Sec! bridge reject args payloads above the argv size limit
Ref tools split window helpers into one file per verb
Ref bridge tools move lua constants next to their tool specs
Mov bridge relocate hs path discovery out of bridge.ts
Rnm tools rename hs_windows to hs_list_windows
Rmv tools drop the clipboard read tool
Dep tools deprecate the sound field on hs_notify
Opt bridge cache the resolved hs path for the process lifetime
Doc docs describe the args codec and its threat model
Doc readme explain what enabling the unsafe tier means
Tst test add a meta test rejecting interpolation in lua constants
Tst bridge cover the protocol error path with fixtures
Cfg ci run unit tests on node 24
Chr deps bump typescript-eslint to 8.67
Sty tools apply prettier to the tool specs
Rev bridge revert the timeout change from 3f2a1c9
```

## Pull requests

- **One logical change per pull request.** A refactor and a feature are two pull
  requests, even when the refactor made the feature possible.
- **CI must be green.** Typecheck, lint, format check, unit tests. Run
  `npm run check` first so you find out before the reviewer does.
- **New behaviour needs tests.** New tool means unit tests for its schema and
  its result parsing, plus an integration test if it touches real windows or
  apps. Bug fix means a test that fails before your fix.
- **Touching `src/bridge/` raises the bar.** That is the security boundary. Say
  in the description what you changed about the codec or the invocation path,
  and confirm the meta-test still passes.
- **Adding a tool means arguing its tier.** In the description, say which tier
  and why. Default is `safe`, and `safe` means the worst outcome of an
  injected call is a small, visible, reversible change. Anything that can read
  private data, synthesise input, or execute arbitrary code belongs behind an
  opt-in.
- **Update the docs in the same pull request.** New tool goes in the README
  table. New environment variable goes in the configuration table. Design change
  goes in `docs/ARCHITECTURE.md`.
- **Rebase, do not merge.** Keep the history linear and the commits meaningful.

Reviews are about the code. Expect direct comments, and give them.

## License

By contributing you agree that your contributions are licensed under the MIT
License, the same as the rest of the project.
