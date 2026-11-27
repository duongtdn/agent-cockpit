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
  to, elsewhere), and the machine's managed MCP servers (an
  organization's). The MCP servers of a `.mcp.json` in the work folder or
  above it and of the agent's configuration file under any of its names
  (`.claude*.json`, in the configuration folder and in the home, the
  person's and each project's) and of the legacy `.config.json` of the
  configuration folder pass when each is a program the agent starts
  (`type` `stdio` or none, `command`, `args`, nothing else), as a command
  hook is. The person's plugins (`plugins` in the configuration folder)
  pass when each marketplace is a real folder inside the run's root, kept
  in one too, each plugin installed (`installed_plugins.json`'s
  `installPath`) is a real folder inside the plugins folder, each
  marketplace list says only who a plugin is and where (a real folder
  inside the marketplace: no repository, no address), and each plugin, in
  the plugins folder or in a marketplace elsewhere in the root, holds only
  its manifest, `commands/*.md` and hooks that stay local (no `.mcp.json`).
  The rules are
  the tables of `test/support/real-agent/launch-rules.ts` (variables,
  options with a value, flags, settings); a settings file's `env` passes
  only when each variable passes the rule a launch's would, and never sets
  `HOME`, `CLAUDE_CONFIG_DIR` or `TMPDIR` (it would move the agent to
  files the guard never checked). `enabledPlugins` passes as an object of
  `true` and `false`. Among them:
  `CLAUDE_CODE_MAX_RETRIES` (three digits at most, for a failed turn's
  test); `disableAllHooks` only as `true`; `--setting-sources` naming only
  `user`, `project` and `local`; `--strict-mcp-config`, the one flag (an
  option with no value) in `FLAG_RULES`; `--plugin-dir` only for a plugin
  of commands, the run's own (a real folder inside the run's root holding
  `.claude-plugin/plugin.json`, which says only `name`, `description` and
  `version`, and `commands/*.md`: no hooks, MCP servers or agents). A work
  folder may be a link inside the root to a real folder inside it, and is
  then checked by both its paths, since the agent reads settings above
  either. A feature that needs one more option or setting adds its rule
  there. One setting exists to keep tests
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
  file passes only when nobody can write it). The shim drops every variable
  of the launch but those a test names in `passedOn`, which then reach the
  agent and are checked as the launch's: what the driver strips is seen
  stripped at the agent (row 74). `startContractCockpit({ driver, shim,
  personsSettings, directory, appAddress, jobs })` takes the driver's options
  (or a function of the run's folders, for a plugin's), the shim's
  `leftOutOfRecipe` (`onboarding`, `folder-trust`, `key-approval`: each a
  piece of the agent's `.claude.json` left out, for a test of the start-up
  dialog it spares), its `variables` and `passedOn`, the person's own
  settings, and the app's jobs beside `say` (run, sent to and opened
  through the cockpit's `run`, `send` and `open`). The rows of the
  driver's options, dialogs, failed turns, compaction, `/clear`, interruptions, tasks, version, the app's sandbox
  and the settings files' denies run through it.
- **The rows, by file:** `starting` (1–3), `prompts` (4, 5, 7), `ending`
  (8), `driver` (14, 29), `interrupting` (6, 22, 95 an interruption
  recorded before the next prompt), `clear` (93, `/clear`'s new
  conversation followed), `tasks` (15 a background
  subagent and its `<task-notification>` turn, 62 and 73 its hooks'
  `agent_id`), `compaction` (16, 94 an interrupted `/compact` read on
  screen), `dialogs` (37, 69 the folder's trust; 68
  the trust dialog's answers; 70 the onboarding; 85 the warning of
  `bypassPermissions`; 88 the API key's question, a dialog of no name),
  `turn-failures` (64, `StopFailure`), `options` (72 `--setting-sources`,
  74 the variables stripped, 87 `--model` and `--plugin-dir`, 91 the
  person's `env`), `confinement` (50–55, 75–79), `network-by-mode`
  (80–83), `version` (84, `--version`), `start-up` (86 every hook off, 89
  a local command as the launch prompt), `sandbox-option` (90, the app's
  sandbox and `sandbox-unavailable`), `settings-files` (92 the `Edit`
  denies on every Claude settings file, 96 on every file that gives MCP
  servers, 97 on the person's plugins, 98 on the configuration file under
  every name, the legacy `.config.json` among them, 99 on agents, skills
  and hooks' scripts, in `bypassPermissions`), `typing` (103–112: the
  driver's `typePrompt` over a long or wrapped draft, an empty box after a
  kill, a recalled history entry, an open menu, shell mode, the person's
  vim mode, a permission dialog, 100,000 multi-byte characters, a running
  background shell, Enters lost; through `typing-terminal.ts`, which
  checks the box before each write as the core does), `units-of-work`
  (113–119, through the cockpit's `run`, `send` and `open`: 113 an ended
  unit of work resumed, 114 a conversation the agent no longer keeps started anew,
  115 `fresh` ending an idle or busy session gracefully, 116 a restart on
  other settings, 117 a first prompt over the command line's bound typed
  once the agent started, 118 a send over a draft of several lines, 119 a
  permission dialog drawn while a send types).
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
  (`itInTheSandbox`), on every platform: they are never left out. A mode's network is measured by `measureReach`: a person at
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
  (`sandbox`: when not, why), and what a sandboxed
  command reached in each mode measured (`networkByMode`).

## The fake agent

The integration tests run `test/support/fake-agent/` as a session's command
in place of Claude Code, with Claude Code's command line: it fires the hooks
of its `--settings` file, takes keys and writes a transcript, playing the
script a test writes in the session's folder. It plays only what was observed
of Claude Code; asked for anything else it shows why and exits with status
70 — extend it from evidence, never from a guess. It is TypeScript that Node
runs as it is, so the integration tests need Node 22.18 or later. It reads
its configuration folder as Claude Code does: the start-up dialogs of a
`.claude.json` (none when the folder has no such file) and the person's
`settings.json` (the warning of `bypassPermissions` accepted, hooks off);
`--version` says the pinned agent's version, or `FAKE_AGENT_VERSION`'s.
Beside a turn's tool calls and replies, a script's steps play a turn that
fails on an API error (`fail`, with its status: `StopFailure`, as the
agent ends a turn once its retries are spent), a compaction (`compact`, the
person's `/compact`, a turn of its own: the only local command it plays),
and a background subagent (`task`: its work runs once the turn ended and
the test released tasks, then its end starts the next turn by itself with
a `<task-notification>` prompt). A script's tool call on a path a deny
rule of its settings names (the state roots, the files the cockpit names
that start code at the next launch) is not played: nothing tells what Claude Code answers there.
Its input box is drawn and edited as Claude Code's was seen at 120×40 (a
box of several rows at another size is refused): the sign `❯` (`!` in shell
mode) and a no-break space, words wrapped at 116 columns as `wrap-ansi`
wraps them, at most 15 rows around the cursor with `↑ N more` and `↓ N more`
on the rules, `History n/m` while a past prompt shows; Up and Down by
screen row (Up from the first into the history of its own prompts, Down
back to the draft), Ctrl+E to the end of the line, Ctrl+U back to the start
of the screen row (or the line break), Ctrl+Y what kills in a row killed
and Alt+Y right after it the kill before, Backspace, ESC CR; the terminal's
cursor put on the box's; a `!` into an empty box turns shell mode on, Backspace or
Ctrl+U on the empty box off. A prompt taken is trimmed of blanks and line
breaks at its end and of U+2063 at its ends; a tab typed is dropped. A
permission dialog is drawn 400 ms after its `PermissionRequest` (the keys
typed meanwhile reach the box) and takes the box's place: text on it does
nothing, Enter answers Yes. `--resume` of a conversation with no transcript
(gone, or never prompted) fires `SessionEnd` (`other`) and exits with 1.
It refuses Enter in shell mode, Down past the box while a background task
runs (Claude Code moves to the task), Up into a history it did not make
alone (a resume, another conversation of the project, after a command, a
withdrawn prompt or a task's turn), any key on a dialog but text, Enter and
Esc, Alt+Y but right after a yank or past the oldest kill, and characters
of other scripts than Latin.

The fake agent is held to the real one by
`test/contract/fake-agent-parity.test.ts`: each scenario is played once on
each, through tmux and a receiver of every hook event, and what the hooks
said must agree — their order, the kind of hook, every key of every payload,
and every value but the few that `test/support/parity/hook-comparison.ts`
lists as different by nature (named or masked inside a text too). To add a scenario, add an `agreeOn(title, …)`
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
