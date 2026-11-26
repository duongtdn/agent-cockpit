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
  unit/         no process, no terminal
  integration/  real tmux; the fake agent, the test doubles' own tests
  contract/     the real agent against the scripted API (below)
  pack/         what `npm pack` would ship
  support/      fake-api/ (a scripted Messages API), fake-agent/ (a program
                run in place of Claude Code), real-agent/ (the pinned
                agent's runner), hooks/ (a hook receiver, for both agents),
                parity/ (how the hooks of the two agents are compared),
                scripted-agent.ts (the examples' default agent, below)
examples/       example apps: the demos and the end-to-end fixtures
docs/           guide.md, api.md, security.md, machines.md
```

Import rules, checked by a test, as an allow-list: a folder imports only
what is named here. Folders: `server/` imports `channel-server/`, `channel/`
and `shared/` (no driver, no adapter); `fastify/` and `claude-code/` import
`server/` and `shared/`; `channel-server/` imports `channel/` and `shared/`,
and only `server/` imports it; `channel/` and `client/` import `shared/`;
`terminal/` imports `client/` and `shared/`; `shared/` imports nothing.
Packages: `server/` `node-pty`, `ws` and `zod`; `fastify/` `fastify`;
`channel-server/` and `channel/` `zod`; `terminal/` `@xterm/*`;
`claude-code/`, `client/` and `shared/` none. Node built-ins: `server/`, `fastify/`, `claude-code/` and `channel-server/` only.

## Commands

- `pnpm check` — typecheck, lint, unit, integration and contract tests,
  build, `npm pack --dry-run`, the end-to-end tests: what CI runs. Green before every commit that
  ends a piece of work.
- `pnpm test:coverage` — the unit and the integration tests in one run, with
  the coverage gate (90% of `src/`): only real tmux exercises the code that
  speaks to it, so the gate counts both.
- `pnpm test` (unit, quick), `pnpm test:integration` (real tmux),
  `pnpm test:contract` (the real agent, below), `pnpm test:pack` and
  `pnpm test:e2e` (both after a build). The live suite (`test/live/`: the
  real model, by hand only) is not written yet.
- `pnpm test:e2e` runs `test/e2e/`: Playwright's Chromium through an
  example app of `examples/`, started as its `DEMO.md` says
  (`test/support/example-app.ts`), on the built package, against the
  scripted API. Each example imports the package by its name (the package's
  self-reference), never `src/`, and is not in the package. An example's
  default agent is `test/support/scripted-agent.ts`: the pinned agent
  against the scripted API, through the contract suite's shim and guard
  (`agent.driver(claudeCode())`), so that every launch of a demo or of an
  end-to-end test is checked as the contract suite's are. It lives in
  `test/support/` with the guard it is built on, never copied into an
  example.
- `pnpm build`, `pnpm typecheck`, `pnpm lint` (Biome, which also formats).

## The contract suite

`pnpm test:contract` runs the real Claude Code TUI in tmux against the
scripted fake API of `test/support/fake-api/`: one test per behavior the
driver relies on, titled with the behavior's number. It takes a few seconds.

- **The agent is pinned**: `@anthropic-ai/claude-code`, a dev dependency at
  one exact version, allowed to run its install script in
  `pnpm-workspace.yaml` (without it the package holds no binary). The suite
  runs that binary, never the `claude` of the `PATH`. Moving to another
  version is a change of the pin, in a commit of its own:
  `pnpm add --save-dev --save-exact @anthropic-ai/claude-code@<version>`,
  then `pnpm test:contract` green on it, then `package.json` and
  `pnpm-lock.yaml` committed together.
- **It needs no login and no network**: every test gets a temporary `HOME`
  and `CLAUDE_CONFIG_DIR`, a fake API key, a fake API and a hook receiver on
  loopback ports of its own, and its own tmux socket
  (`test/support/real-agent/`). The runner refuses to launch an agent that
  could reach Anthropic or the person's configuration: every variable,
  argument and setting of a launch, in every settings file the agent would
  read, needs a rule that lets it pass. Two things are refused whatever
  they hold, since no rule could check them: a work folder in a git
  worktree (the agent would read the settings of the repository it belongs
  to, elsewhere), and a file that gives the agent MCP servers (`.mcp.json`
  in the work folder or above it, the machine's managed one). The rules are
  three tables in
  `test/support/real-agent/launch-rules.ts`; a feature that needs one more
  option or setting adds its rule there. One setting exists to keep tests
  off Anthropic: `skipWebFetchPreflight` passes only as `true` (WebFetch
  otherwise asks `api.anthropic.com` about each host before it fetches,
  whatever the API's address); a test whose agent fetches sets it in
  `personsSettings`, as row 54 (WebFetch forces HTTPS and sends no header
  of the caller's) does.
- **The driver's own launch** is tested with `test/contract/cockpit-harness.ts`:
  `startContractCockpit()` makes a cockpit with `claudeCode()`, whose
  `claude` is a shim first on the server's `PATH`
  (`test/support/real-agent/shim.ts`) that runs the pinned binary with the
  recipe's variables and no other. Every launch passes the same guard
  before the cockpit starts it: the command must resolve to the shim, and
  the driver's settings file is made read-only, then checked (a settings
  file passes only when nobody can write it).
- **A behavior that does not hold is a finding**: the test keeps stating the
  behavior and fails; it is never bent to pass.
- **A test is written with `test/contract/harness.ts`**:
  `startContractAgent()` gives it an API double to script, a hook receiver
  and a runner, and ends them with the test. Its title is the behavior's
  number, a dash between two spaces (`1 — …`), then the behavior: the results
  are read from the titles, and a test titled otherwise is left out of them.
- **A prompt typed into a session is submitted with `submitPrompt()`** (in
  the harness, for the contract and the parity tests alike), never with a
  bare Enter: it submits as the driver does, Enter, then a few seconds for
  the `UserPromptSubmit` that carries the prompt, Enter again while the
  prompt stays in the input box, up to three times. The agent has been seen
  to miss an Enter, more so under load; a submit is confirmed, never
  assumed. Text already in the box is submitted the same way with
  `submitInputBox()`. Only a test of what an Enter does (behavior 4: keys
  typed before `SessionStart` keep their text, not surely their Enter)
  presses it bare.
- **The confinement rows** (`confinement.test.ts`, `network-by-mode.test.ts`)
  run sessions with `claudeCode()`'s own lines; the sandbox is turned on as a
  person does, in the user's `settings.json` of the agent's configuration
  folder (`personsSettings`), with `failIfUnavailable`. They need bubblewrap
  and socat, and user namespaces (`bwrap --unshare-all --ro-bind / / true`
  must run). Where the sandbox cannot run, those rows fail saying why
  (`itInTheSandbox`); only CI may leave them out, by
  `COCKPIT_CONTRACT_SANDBOX_LACKING=<why>` with `CI=true`, and the results
  then say so. A mode's network is measured by `measureReach`: a person at
  the terminal approves each command `auto`'s server-side check would judge
  (the scripted API cannot stand in for it) and answers every network ask
  "No"; the driver counts a mode as confined only where rows 80–81 show
  no reach made: row 80 (`default`, `acceptEdits`) takes each as asked
  about or refused, the results recording which; row 81 (`dontAsk`) as
  refused.
- Each run writes `test-results/contract.json` (git-ignored; CI keeps it as
  an artifact): the agent's version, the date, each behavior's number, title
  and outcome, every Enter the agent lost in a submit (`lostEnters`: the
  test, the text, how many), which fails no test, whether the sandbox ran
  (`sandbox`: when not, why and the rows left out), and what a sandboxed
  command reached in each mode measured (`networkByMode`).

## The fake agent

The integration tests run `test/support/fake-agent/` as a session's command
in place of Claude Code, with Claude Code's command line: it fires the hooks
of its `--settings` file, takes keys and writes a transcript, playing the
script a test writes in the session's folder. It plays only what was observed
of Claude Code; asked for anything else it shows why and exits with status
70 — extend it from evidence, never from a guess. It is TypeScript that Node
runs as it is, so the integration tests need Node 22.18 or later.

The fake agent is held to the real one by
`test/contract/fake-agent-parity.test.ts`: each scenario is played once on
each, through tmux and a receiver of every hook event, and what the hooks
said must agree — their order, the kind of hook, every key of every payload,
and every value but the few that `test/support/parity/hook-comparison.ts`
lists as different by nature. To add a scenario, add an `agreeOn(title, …)`
there: its `script` (the fake agent's; the API's answers follow from it) and
its `play`, which drives either agent and awaits every hook it expects. A
difference is closed in the fake agent, which plays what the real one did or
refuses it; the comparison is never loosened for one.

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
