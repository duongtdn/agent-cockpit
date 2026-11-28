# CLAUDE.md — agent-cockpit

`@duongtdn/agent-cockpit` drives coding agents, in their real terminal UI,
from an app's own web UI. It is a library for the app's Node server and its
browser code; it ships no web UI. It works through drivers; Claude Code is
the first. Everything here is US English.

## Layout

```
src/
  server/       the entry `.`: core, handler and router, sessions and
                the units of work, their records, the jobs' checks,
                asks, the channel's MCP server, activity, the session
                host (tmux)
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
                run in place of Claude Code that fires recorded hooks),
                real-agent/ (the pinned agent's runner), hooks/ (a hook
                receiver, for both agents, and the recording of the real
                agent's payloads), recorded-hooks.ts (their reader),
                scripted-agent.ts (the examples' default agent, below)
  fixtures/     screens/ and input-box/ (the real agent's screens), hooks/
                (its recorded hook payloads), transcripts/
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
- `pnpm check:ci` — the same, then the contract suite again, in a container
  made like CI's runner (`ci/Dockerfile`: its Ubuntu and tmux, Node 22 and
  Node 24 side by side, the agent's sandbox, Playwright's Chromium), each
  Node on 2 CPUs of its own at `COCKPIT_TEST_SLOWNESS=2`, as CI runs: this
  machine is much faster than CI's runner and runs another tmux and one
  Node, so green here says little about CI. Green before every push. Each
  run's output, contract results and failed tests' timelines are kept in
  `test-results/ci/node<major>/`. `--node <major>` runs one Node;
  `--command '<shell>'` runs that on the same machine instead (a row run
  again and again); `CHECK_CI_CPUS` sets the CPUs of each run.
- `pnpm test:coverage` — the unit and integration tests in one run, then
  the contract suite alone, each keeping its coverage
  (`test-results/coverage-runs/`), then the gate on their sum: 90% of the
  lines and the branches of `src/`, one number. The agent's behavior is the
  contract suite's to test, and the code that follows it is counted there;
  no test is written at a level that does not own its criterion only to
  raise the number.
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
  driver's options, dialogs, failed turns, compaction, `/clear`, interruptions, interrupt and end, tasks, version, the app's sandbox
  and the settings files' denies run through it. `keysSent()` gives every
  write the cockpit made into its terminals (each tmux `send-keys`, logged
  by a `tmux` second on the server's `PATH`, `key-log.ts`); the test's own
  keys go through the real one and are not among them.
- **The rows, by file:** `starting` (1–3), `prompts` (4, 5, 7), `ending`
  (8; 30 SIGTERM idle or with a turn held, the conversation resumed; 32
  mid-turn: the prompt kept, no partial answer, no marker; 129 at the
  trust dialog, no hook, and on a launch command's panel), `driver` (14,
  29), `interrupting` (6, 22, 95 an interruption recorded before the next
  prompt; 23 an early Esc over an empty box withdraws the prompt into it;
  24 one Esc on an idle, empty box changes nothing, two open the rewind
  menu; 25 Ctrl+U; 28 a background subagent runs on past an Esc; 128 an
  early Esc over a draft interrupts, the draft kept alone),
  `interrupt-and-end` (130–136, through the cockpit's `interrupt` and
  `end`: 130 a streaming reply interrupted by one Esc, the marker; 131 a
  prompt of one, five and 24 lines withdrawn over an empty box, read on
  screen and cleared; 132 a person's Esc: idle by the withdrawn read, the
  prompt left in the box; 133 a draft kept exact, the marker; 134 `end`
  mid-reply keeping the partial answer and the marker, resumed with both;
  135 `end` at the trust dialog: no key, `app`, not `declined`; 136 a
  permission dialog shown in the terminal alone, in `plan`, interrupted, the
  tool not run),
  `clear` (93, `/clear`'s new
  conversation followed), `tasks` (15 a background
  subagent and its `<task-notification>` turn, 62 and 73 its hooks'
  `agent_id`), `compaction` (16, 94 an interrupted `/compact`, 123 one
  that fails: `StopFailure` with the compaction's own `agent_id`, 124 one
  interrupted: the `<local-command-caveat>` entry alone, 125 `/context`
  then `/compact` at once: only the Esc's caveat, recorded after the
  compaction began, ends it), `dialogs` (37, 69 the folder's trust; 68
  the trust dialog's answers; 70 the onboarding; 85 the warning of
  `bypassPermissions`; 88 the API key's question, a dialog of no name),
  `turn-failures` (64, `StopFailure`), `options` (72 `--setting-sources`,
  74 the variables stripped, 87 `--model` and `--plugin-dir`, 91 the
  person's `env`), `confinement` (50–55, 75–79), `network-by-mode`
  (80–83), `version` (84, `--version`), `start-up` (86 every hook off, 89
  a local command as the launch prompt, 121 one that ends by itself, read
  in the transcript, 122 each panel one opens, named, and its close read
  on screen), `sandbox-option` (90, the app's
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
  permission dialog drawn while a send types), `screen` (120: busy told
  from idle on screen, a draft in the box or none, in each mode the driver
  runs: the spinner's row above the box while a turn, a hook of it or a
  compaction runs; the footer's `esc to interrupt` over an empty box only;
  126 the exception: a reply streamed over a draft draws no spinner's row,
  and reads as the box free, as idle), `permission-dialog` (127 keys typed
  as `PermissionRequest` arrives, before the dialog shows: they answer
  nothing; after Esc the box holds them or nothing), `permissions` (the
  agent's half of 137, 138, 142, 144, 146, 147, through `startContractAgent`:
  137 a `PermissionRequest` of a `Bash` with a
  description, of a `Write`, of a background task's call, each after its
  `PreToolUse`, with no `tool_use_id`, the hook's `allow` running it; 138
  the hook's `deny`, with a message (the call's result) or bare
  (`Permission denied by hook`): no hook for the call, `PostToolBatch`; 142
  a Yes in the terminal whose command fails, `PostToolUseFailure`; 144 an
  amended "No": no hook for the call, then `PostToolBatch`; 146 three
  concurrent `Read`s, each ask after its own `PreToolUse`'s answer; 147
  `auto`'s ask in the terminal alone, told by `Notification`
  `agent_needs_input` then `permission_prompt`), `permission-asks` (the
  cockpit's half, 137–148, through the cockpit's `asks`, `interrupt`, `end`
  and `close`: 137 the app's allow, the dialog closed, the call run; 138 a
  deny with a message, then bare, the turn going on; 139 "remember" on
  `Bash`: an exact compound line, then `touch:*`, a compound line with
  another command still asking, and, `touch:*` remembered first, the exact
  compound line remembered then asked again; 140 on files: a `Write` remembered lets a
  `Write` and an `Edit` of the file run, a `Read` the file, siblings
  asking, no settings file written; 141 in one session, each settled
  `terminal`: a Yes by 1, 2 and 3 at `PostToolUse`, a Yes whose command
  fails (142's half) at `PostToolUseFailure`, an amended "No" (144's) at
  `PostToolBatch`, `busy`, then `idle`; no hook left open (the
  listener's side of the agent's connections, in `/proc/net/tcp`); 143 a
  plain "No" and Esc `cancelled`, `idle`; 145 `interrupt` on one held ask and on three, one marker
  each, and `end` with one held, its marker before the signal; 146 three
  `Read`s answered out of order, each answer its own call's, and three
  identical, one remembered, all settled; 147 each mode: `default`
  offered to the app, `acceptEdits` and `bypassPermissions` run,
  `dontAsk` denied, `auto`'s `python3` and `plan`'s `touch` asked in the
  terminal alone (from `Notification`), settled by a Yes or interrupted by
  the cockpit's Esc; 148 a Yes after `close` reaching a new listener at the
  same address as `PostToolUse`).
- **A behavior that does not hold is a finding**: the test keeps stating the
  behavior and fails; it is never bent to pass.
- **A test is written with `test/contract/harness.ts`**:
  `startContractAgent()` gives it an API double to script, a hook receiver
  and a runner, and ends them with the test. Its title is the behavior's
  number, a dash between two spaces (`1 — …`), then the behavior: the results
  are read from the titles, and a test titled otherwise is left out of them.
- **A prompt typed into a session is submitted with `submitPrompt()`** (in
  the harness), never with a
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
in place of Claude Code, with Claude Code's command line: a small program
that fires hooks as the script a test writes in the session's folder says
(`writeScript`), and takes their answers. It draws nothing, has no input
box, no dialog and no key: everything about the screen and the keys is
tested on the real agent (the contract suite) or by unit tests over its
real screens kept as fixtures (`test/fixtures/screens`,
`test/fixtures/input-box`). It is the pane's process itself (the shim
`exec`s it), so a test reads its environment in `/proc`. It refuses to run
without `CLAUDE_CONFIG_DIR` (it never writes the person's configuration).
It fires `SessionStart` once started; then a script's steps: `turn` (the
launch prompt's `UserPromptSubmit`, its `asks`, then `Stop` with the
reply; each ask a tool and input: `PreToolUse`, then `PermissionRequest`
held for its reply — `allow` fires `PostToolUse` then `PostToolBatch`,
`deny` the denied call's `PostToolBatch` (its message the call's result),
`deny` with `interrupt` ends the turn with the transcript's interruption
marker and no `Stop`; with no decision, or before one, the test answers as
the person in the terminal, `answerInTerminal`: `esc` closes the hook and
interrupts, `yes` fires `PostToolUse` then `PostToolBatch`, `amended-no`
the refused call's `PostToolBatch`, both leaving the hook open; every hook
of the turn carries its prompt's id),
`stay-busy` (`UserPromptSubmit`, then nothing until killed), `hold` (until
the test's `release`), `exit` (`SessionEnd` with the reason of the agent's
own exit, then status 0). On SIGTERM, as the cockpit ends a session, it
fires `SessionEnd` (`other`) and exits with 143. It writes a transcript of
what it played where the driver looks for one, so that an ended session
can resume. Asked for anything else (a second prompt, `--resume`, a hook
that fails), it says why on its error output and exits with status 70.
`--version` says the pinned agent's version, or `FAKE_AGENT_VERSION`'s. It
is TypeScript that Node runs as it is, so the integration tests need Node
22.18 or later.

Every payload it fires is the real agent's: `test/fixtures/hooks/claude-code.json`
holds, for each event, each shape the contract suite saw (its fields and
the values that tell variants apart: a `SessionEnd`'s `reason`, a
`StopFailure`'s `error`, an `agent_id`, the kinds of tasks a `Stop` lists,
whether a `PostToolBatch`'s calls ran, one was refused in the terminal or
denied by the hook with no message)
with one example, the run's own values made placeholders
(`{{session_id}}`, `{{transcript_path}}`, `{{cwd}}`, `{{root}}`). The fake
agent fills them with its session's, and puts in the prompt and the reply;
the unit tests of the driver's hook reading read the same payloads
(`recordedPayload(event, where?, values?)` in `test/support/recorded-hooks.ts`),
never one written by hand. A payload that was never recorded is not
invented: a contract test that makes the agent send it comes first. The
payloads are recorded by a run of the contract suite with
`RECORD_HOOK_PAYLOADS=1 pnpm test:contract`, which adds the shapes it saw
to the file (all of them anew when the agent's version changed); a unit
test fails while the file is not of the pinned version, so the commit that
moves the pin records them again.

One level owns each criterion: unit tests the decisions, state machines,
interleavings, refusals and edge cases; integration tests only what real
tmux, processes, files and sockets show; the contract suite the agent's
behavior; an end-to-end test one journey per feature. An integration test
whose assertion is made at its owning level is not written.

## How code is written here

- **Test first.** A failing test for the next behavior (red), the simplest
  code that passes (green), then refactor with the tests green.
- **One level owns each behavior**, and its test is written there only:
  unit — decisions, state machines and their interleavings, refusal tables,
  every edge case; integration — what only real tmux, processes, files and
  sockets show; contract — everything about how the agent behaves (the real
  agent against the scripted fake API); end to end — one journey per
  feature, a browser through an example app. A level above the owner adds a
  test only for what the owner cannot show; the same assertion is not
  repeated up the levels. New lifecycle events of a session join the
  generated test of interleavings (`test/unit/session-interleavings.test.ts`,
  its one list of commands).
- **A test waits for the effect it needs, never for a time.** Every bound a
  test waits under comes from `test/support/patience.ts` (`PATIENCE`),
  multiplied by `COCKPIT_TEST_SLOWNESS` (1 here, 2 in `check:ci` and on CI);
  no bound is a literal in a test. Where the agent drops a key (a dialog as
  it shows, an Enter now and then), the key is pressed again only once a
  whole scaled patience passed with no effect, at most three times, then the
  test fails saying what the terminal shows. A failed test's hooks, keys,
  screens and states are written under `test-results/timelines/` (CI keeps
  them).
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
  `chore:`, `ci:`). Work goes on `next`, pushed after `pnpm check:ci` is
  green; CI runs on every push to it, and a red there is fixed before more
  is added. `main` moves only by fast-forward to a commit of `next` CI
  passed; a finished feature's last commit is tagged `feature/NN-<name>`
  once `main` is on it.
- `CHANGELOG.md` keeps an "Unreleased" section current.
- A release is the maintainer's act: they push a `vX.Y.Z` tag, and CI
  publishes with provenance. Never publish to npm or push a `v…` tag
  otherwise.
