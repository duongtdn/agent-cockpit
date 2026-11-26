# CLAUDE.md — agent-cockpit

`@duongtdn/agent-cockpit` drives coding agents, in their real terminal UI,
from an app's own web UI. It is a library for the app's Node server and its
browser code; it ships no web UI. It works through drivers; Claude Code is
the first. Everything here is US English.

## Layout

```
src/
  server/       the entry `.`: core, handler and router, sessions, asks,
                the channel's MCP server, activity, the session host (tmux)
  fastify/      `./fastify`: the Fastify adapter, wiring only
  claude-code/  `./claude-code`: the Claude Code driver
  channel/      `./channel`: the channel declaration; imports neither side
  channel-server/  the channel's runtime: not an entry, imported only by
                `server/`
  client/       `./client`: the framework-free browser client
  terminal/     `./terminal`: the mounted terminal (xterm.js)
  shared/       what both sides use: CockpitError, the wire's types
test/
  unit/  integration/  contract/  live/  e2e/  support/
examples/       example apps: the demos and the end-to-end fixtures
docs/           guide.md, api.md, security.md, machines.md
```

Import rules, checked by a test, as an allow-list: a folder imports only
what is named here. Folders: `server/` imports `channel-server/`, `channel/`
and `shared/` (no driver, no adapter); `fastify/` and `claude-code/` import
`server/` and `shared/`; `channel-server/` imports `channel/` and `shared/`,
and only `server/` imports it; `channel/`, `client/` and `terminal/` import
`shared/`; `shared/` imports nothing. Packages: `server/` `node-pty`, `ws`
and `zod`; `fastify/` `fastify`; `channel-server/` and `channel/` `zod`;
`terminal/` `@xterm/*`; `claude-code/`, `client/` and `shared/` none. Node
built-ins: `server/`, `fastify/`, `claude-code/` and `channel-server/` only.

## Commands

- `pnpm check` — typecheck, lint, unit, integration and contract tests,
  build, `npm pack --dry-run`: what CI runs. Green before every commit that
  ends a piece of work.
- `pnpm test`, `pnpm test:integration`, `pnpm test:contract`,
  `pnpm test:e2e`, `pnpm test:live` (the real model; by hand only).
- `pnpm build`, `pnpm typecheck`, `pnpm lint` (Biome, which also formats).

## How code is written here

- **Test first.** A failing test for the next behavior (red), the simplest
  code that passes (green), then refactor with the tests green. Tests at
  every level that applies: unit; integration against real tmux; contract
  (the real agent against the scripted fake API in `test/support/`); end to
  end (a browser through an example app).
- **Simple, not easy.** The design that is simple to read and extend, not the
  one quickest to type; no shortcut that leaves debt.
- **Clean code.** Clear names, small functions, one job each, no duplicated
  knowledge, no flag arguments.
- **Comments** explain why, never what. TSDoc on every export: what it does,
  its options, what it returns, the `CockpitError` codes it may throw.
- **Errors** are `CockpitError` with a kebab-case `code` and the fields of
  that code. "Nothing to do" is an action in a result, never an error.
- **TypeScript strict**, ESM, Node 22 or later; `tsc` builds, no bundler.
- **Runtime dependencies** are node-pty, `ws` and xterm.js (exact versions);
  zod 4 and Fastify are peers. Adding one needs a recorded reason.
- **Security checks are never weakened for a test**: tests go through the
  real request checks and tokens.
- **Tests and experiments never touch the person's own configuration**: a
  temporary `CLAUDE_CONFIG_DIR`, their own tmux socket, their own folders;
  nothing left running afterwards.

## Documents

`README.md`, `docs/*.md`, TSDoc and `CHANGELOG.md` say what the code does,
always: a change an app can see updates them in the same commit. Drift tests
compare the documented exports and error codes with the code.

## Commits and releases

- Conventional commits (`feat:`, `fix:`, `test:`, `refactor:`, `docs:`,
  `chore:`, `ci:`); work on `main`; a finished feature's last commit is
  tagged `feature/NN-<name>`.
- `CHANGELOG.md` keeps an "Unreleased" section current.
- A release is the maintainer's act: they push a `vX.Y.Z` tag, and CI
  publishes with provenance. Never publish to npm or push a `v…` tag
  otherwise.
