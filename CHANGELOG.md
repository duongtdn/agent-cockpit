# Changelog

What changes for an app that uses `@duongtdn/agent-cockpit`, release by
release. The versions follow semantic versioning; before 1.0, a minor release
may break.

## Unreleased

Nothing is published yet.

### Added

- The package's six entry points: `.`, `./fastify`, `./claude-code`,
  `./channel`, `./client`, `./terminal`. `./channel` exports nothing yet.
- `createCockpit({ name, directory, driver, jobs, hiddenEnv?, stateDirectory?,
  agentPort?, authorize?, origins?, terminal?, port? })` from `.`, with the types `Cockpit`, `CockpitOptions`,
  `Job`, `RunResult`, `Session` and `EndReason`: checks its options
  (`invalid-options`, any other option refused) and the machine
  (`unsupported-machine`), takes the app's lock (`cockpit-locked`), opens
  the state folder, the app's token and the agent-facing listener. The
  cockpit runs a job (`run`; the units of work below), lists and follows
  the sessions, gives the page's link with the token in its fragment
  (`link`), serves the browser on the mounted handler (`handle`,
  `upgrade`: running a job, listing and following the sessions, and each
  session's terminal over a WebSocket), and `close()`s, the sessions going
  on in tmux: a call still waiting for its key's turn is rejected and never
  runs, and nothing is ended or killed after `close()`. The state folder (`$XDG_STATE_HOME/agent-cockpit/<name>` by
  default) and the app's token are readable by the app's user alone; the
  token and the agent-facing port stay the same from one start to the next.
  The state folder is the cockpit's own: one that exists must be the user's
  and is narrowed to the user alone, and each file read in it must be a
  regular file of the user's (never a symbolic link), else `invalid-options`;
  a token's file others could read gives way to a new token. Every folder
  above it must be the user's or root's, writable by others only with the
  sticky bit, by its group only so or when it is the user's private group (its
  only member in `/etc/group`, nobody else's primary group in `/etc/passwd`),
  else `invalid-options` with nothing created; the missing ones are created
  `0755` whatever the umask. On WSL2, a state folder on a Windows drive is
  refused. A state root (the default one, or `stateDirectory`, as given or
  resolved) whose path holds `*`, `?`, `[`, `]`, `{`, `}`, `(`, `)`, `\` or
  a control character is refused (`invalid-options`): a permission rule
  would read it as its own.
- The app's lock: a Linux abstract unix socket named from an id in the state
  folder. A second process of the app waits 5 seconds, then rejects with
  `cockpit-locked`, whose `holder` is the holding process's id or
  `'another-user'` (its message says how to replace the lock's id).
- The handler is mounted: it is given the requests under the app's prefix,
  the prefix removed from the URL. A path under the mount it does not know
  is answered 404, and an upgrade to one is refused; a `CockpitError` is
  answered with an HTTP status of its code and the error as JSON.
- The handler's request checks, for every request and upgrade: refused
  (`refused`) from beyond the loopback, through a forwarding header, to a
  local address other than `127.0.0.1` or `::1`, or with a `Host` or
  `Origin` other than `127.0.0.1`, `localhost` or one of the app's
  `origins`; then `no-token` without the app's token.
- Opening beyond loopback: `authorize(request)` alone admits a remote
  request (from another address, or with a forwarding header), with no
  token; a throw or a rejection refuses it and is reported. It must settle:
  the cockpit sets no time limit on it, and answers 503 a request still
  waiting on it when the cockpit closes. It is asked once a request.
  `origins` lists
  the origins allowed beyond `127.0.0.1` and `localhost`. `terminal: 'on' |
  'loopback' | 'off'` switches the terminal (`refused`, `'terminal-off'`).
  `createCockpit` refuses `authorize` with a driver whose sessions are open
  (their network, or their file tools' unasked writes) and the app did not
  accept it.
- `cockpit.verify(request)`, for the app's own API routes, and
  `cockpitHeaders()` from `./client`, the header a page sends them.
- `cockpit.renewToken()`: a new token in force, the old one refused at once,
  every browser-facing WebSocket closed; a request or a handshake whose
  admission overlapped the renewal is refused with a retryable 503 and
  made again as a new request, `authorize` asked once for each: the
  client makes a run again once, a second later, and its streams and
  terminals reconnect, none of them reporting it as an error.
- `cockpit.on('error', handler)` and the code `internal-failure` (`where`:
  `'handler'`, `'authorize'` or `'agent-listener'`; `cause`): the
  failures the cockpit answered with a bare 500, and an `authorize` that
  threw. Never on the wire; `console.error` while there is no handler.
- The confinement lines, written into every Claude Code session: a `Read`
  and an `Edit` deny on each state root; the app's ports denied to the
  sandbox's network on every local address and loopback name; the
  agent-facing listener allowed; `allowUnsandboxedCommands: false`. They do
  not turn the sandbox on. The app's ports: `port` (one or several), or
  read by `cockpitFastify` from the server at each launch; a launch with
  none known is refused with `no-app-port` (503).
- The agent-facing listener refuses 403 a request that looks like a
  browser's (an `Origin`, or a `Host` other than exactly
  `127.0.0.1:<port>`) before its token is read.
- `cockpitFastify(cockpit)` from `./fastify`: mounts the cockpit under the
  prefix it is registered with, its WebSocket upgrades included, and tells
  it the ports the server listens on.
- `CockpitError` and `isCockpitError`, from `.`, `./client` and
  `./terminal`, with the types `CockpitErrorCode`, `CockpitErrorFields` and
  `Issue`: one error class, a
  kebab-case `code`, and the fields of each code. `JSON.stringify` keeps an
  error's `name`, `code`, `message` and fields.
- The types `SessionState`, `Pending` and `StartupDialog`, from `.` and
  `./client`: what the errors' fields are made of.
- `createCockpitClient({ baseUrl })` from `./client`, with the types
  `CockpitClient`, `CockpitClientOptions`, `RunResult`, `Session` and
  `EndReason`: takes the app's token from the link's fragment, removes it
  from the address bar and keeps it in the origin's local storage, and sends
  it in a header and a WebSocket subprotocol, never in a URL; a link
  opened later in the same tab (`hashchange`) is taken the same way.
  `run(jobId, args)` rejects with the server's `CockpitError`, or
  `unreachable` (an answer that breaks off included);
  `sessions.follow(handler)` reconnects by itself after a drop (0.5 s,
  doubling up to 10 s), and at once with a new link's token;
  `on('error', handler)` tells why a stream could not connect (`no-token`,
  `refused`, `unreachable`). A handler that throws stops neither the other
  handlers nor the stream: what it threw goes to `console.error`.
  `invalid-options` for a `baseUrl` that is not a path or an HTTP URL.
- `claudeCode({ permissionMode?, permissions?, acceptOpenNetwork?, model?,
  pluginDir?, settingSources?, otherMcpServers?, sandbox? })` from
  `./claude-code`, with the types `ClaudeCodeOptions`, `PermissionMode` and
  `PermissionRules`: the Claude Code driver, which launches `claude` with settings of its own in the
  cockpit's state folder and without the inherited `CLAUDE_CODE_*` and
  `CLAUDECODE` variables. A session in `default` or `dontAsk` counts as
  confined; one in `plan`, `auto` or `bypassPermissions` as open for its
  network (a sandboxed command reaches beyond the cockpit's allow-list
  unasked), and one in `acceptEdits`, `auto` or `bypassPermissions` for its
  writes (the file tools write files unasked, outside the sandbox, which a
  hook may run): an app opened beyond loopback accepts an open mode with
  `acceptOpenNetwork: true`, and the refusal's reason says which. `model` is the
  sessions' model (`--model`); `pluginDir` the app's plugin
  (`--plugin-dir`, an existing folder); `settingSources` the only sources
  of settings read below the session's own (`--setting-sources`);
  `otherMcpServers: false` keeps every other MCP server out
  (`--strict-mcp-config`). Any other option is refused with
  `invalid-options`.
- Every session's settings carry an `Edit` deny on the files the cockpit
  can name that start code at the agent's next launch:
  `.claude/settings.json`, `.claude/settings.local.json` and `.mcp.json`
  wherever they are, and every file of a `.claude/hooks`, `.claude/agents`
  or `.claude/skills` folder; the person's own `settings.json`, the legacy
  `.config.json` and every `.claude*.json` in the agent's configuration
  folder, every `.claude*.json` in the home, and their `plugins`, `agents`
  and `skills` folders. In a cockpit session the agent can never edit one,
  even when asked, so that it cannot plant a hook, an MCP server or a
  plugin that would run outside the sandbox at the next start (a project's
  `.mcp.json` runs with no one asked in `bypassPermissions`). In
  `acceptEdits` (inside the work folder), `auto` and `bypassPermissions`
  the agent's file tools write unasked and act as the person: the denies
  are defense in depth, not a boundary. A `CLAUDE_CONFIG_DIR` or
  a `HOME` those denies could miss (relative, or holding a character a
  permission rule reads as its own) is refused with `invalid-options`
  (issues with an empty path), by `createCockpit` and again by each launch.
- `claudeCode({ sandbox: true | { excludedCommands?,
  allowUnsandboxedCommands? } })` turns the agent's sandbox on for every
  session, with `failIfUnavailable`; it only turns it on (`false` is
  refused). A launch whose agent's `PATH` lacks `bwrap` or `socat`, or
  whose `bwrap` cannot make the nested user namespace the agent's sandbox
  makes (an AppArmor-confined one; probed once per `bwrap` while it
  passes, bounded to 10 seconds), is refused with `sandbox-unavailable`;
  an agent that stops for want of the sandbox otherwise ends its session
  `lost`.
- `mountTerminal(element, key, { baseUrl, theme?, fontFamily?, fontSize? })`
  from `./terminal`: a session's terminal (xterm.js) in the app's element,
  fitted to it, attached over a WebSocket with the app's token, reconnecting
  after a drop and at once with a new link's token, `ended` once the
  session is gone; the driver's key rules;
  copy through OSC 52 and Ctrl+C on the terminal's own selection; status
  events; `on('error', handler)`, which tells why it could not connect
  (`no-token`, `refused`, `unreachable`), and stops it on `terminal-off`;
  a `status` or `error` handler that throws stops neither the others nor
  the terminal, and goes to `console.error`;
  `focus()` and `dispose()`, with the types `MountedTerminal`,
  `MountTerminalOptions` and `TerminalStatus`. Any program in a session can
  write the person's clipboard through OSC 52; none can read it.

- `cockpit.status()` (`CockpitStatus`: `{ agentVersion?, tested,
  testedRange }`) and `cockpit.on('untested-version', handler)`
  (`UntestedVersion`), with `TestedRange`, from `.`. `cockpit.on` throws `TypeError` for an event it does not have.
- `claudeCode.job({ permissionMode?, permissions?, model? })` from
  `./claude-code`, with the type `ClaudeCodeJobPart`: builds a job's driver
  part, `invalid-options` when it does not fit. The types
  `ClaudeCodeSandbox` and `ClaudeCodeOptions.sandbox`.
- The types `TurnError` and `BackgroundTask`, from `.` and `./client`; an
  `idle` session's `error` and `backgroundTasks`, an `ended` one's
  `dialog`.
- Sessions follow more of Claude Code: a turn that fails on an API error is
  `idle` with its `error` (`server`, overloads included; `rate-limit`;
  `other`) until a later turn; `idle` lists the `backgroundTasks` still
  running, each gone when it finishes, and a task's own work never moves
  the state; a compaction begun while `idle` is `busy`, then the same
  `idle`, its `since` kept, and changes nothing inside a turn; a turn the
  person interrupts in the terminal ends `idle`. The driver's settings
  carry the hooks `StopFailure`, `PreCompact`, `PostCompact`,
  `SubagentStart` and `SubagentStop`.
- The error code `sandbox-unavailable` (`cause`, 503).
- `createCockpit({ hiddenEnv })`: the names of the server's variables no
  session's agent gets, nor the app's tmux server (each launch removes
  them from a server's global environment that had them). Hygiene, not a
  boundary: a process of the app's user can read the server's own
  environment. A job's `driver` part (`claudeCode.job(…)`),
  checked at `createCockpit` and again at each run (`invalid-options`),
  its mode, rules and model laid over the driver's at launch; a part that
  opens the network of a cockpit opened beyond loopback, unaccepted, is
  refused naming the job.
- The agent's version is read at `createCockpit` (for `status()`; no agent
  is no failure there) and before each launch: no agent, or one that
  fails, hangs (10 seconds) or prints no version to `--version` →
  `agent-not-found` (the message says why, `cause` what it printed);
  older than the tested range → `agent-too-old`, nothing listed; newer, or
  a build with a suffix (`2.1.340-beta`) not older than the range → the
  session runs and `on('untested-version')` tells it once per version.
  The agent's version is asked once per executable (its real path and
  time of change); a failure is not kept.
- Until its first hook, the cockpit reads the agent's screen: a run
  resolves `waiting` at a start-up dialog (`pending: [{ kind: 'terminal',
  dialog }]`; a dialog of no known name, such as the question about a
  custom API key, has no `dialog`), `starting` again once the person
  answers it in the terminal, and a session left at one ends `declined`
  with its `dialog`. With no dialog on screen, an agent that sends no hook
  within 10 seconds of its launch (or of a dialog leaving the screen), or
  within 5 seconds of showing its input box (every hook turned off), is
  ended and refused with `unobservable`.
- A launch prompt the agent takes without a turn (a local command such as
  `/help` or `/clear`) is read from the screen from 5 seconds after the
  first hook until the screen or a hook tells: the input box back is
  `idle`, a panel waiting for a key is `waiting` (`kind: 'terminal'`)
  until it closes; anything else leaves the session `starting` until the
  next hook, never guessed `busy`.
- A session follows the conversation the agent moves to: Claude Code's
  `/clear` starts one under a new id, and what the cockpit reads outside
  the hooks, and an ended session's `canResume`, follow it (an
  interruption recorded in the conversation left just before the move
  still ends the turn open then). A compaction begun `idle` that fails or
  is interrupted (no hook ends it) is read on the screen and returns the
  session to the `idle` it left; an
  interruption the agent recorded before the next prompt was taken leaves
  the new turn `busy`.
- Units of work. A job may carry `options` (option sources, `{ choices,
  suggestions: true }` for one that only suggests), `directory(args)` and
  `fresh`, checked at `createCockpit` (`invalid-options`: `args` an object
  schema JSON Schema can describe, each source for a field of it); the
  types `Choice`, `JobDescription`, `SessionRecord`, `HistoryEntry`,
  `RunOptions`, `OpenOptions`, `SendResult` and `OpenResult` (from `.` and
  `./client`). `run(jobId, args, { fresh? })` acts by the state of the
  key's unit of work: no record → `started`; `ended` → `resumed` with the
  prompt, or `started` (`fresh` for a fresh job, `conversation-gone` when
  the agent no longer keeps the conversation); `idle` → `sent` (typed, the
  person's draft kept), or, launched with other settings, ended
  (`restarted`) and `resumed` with `settings-changed`; `starting`, `busy`,
  `waiting` → `wrong-state`; a job with no prompt starts or resumes at
  `idle`, and on a live session has `nothing-to-send`. With `fresh`, a new
  conversation (`fresh-on-request`), a live session ended first, its
  stopped background tasks listed in `stoppedTasks`. `send(key, prompt)`
  types into `idle`, resumes `ended` with the settings of the key's last
  run, `unknown-key` with no record. `open(key, { fresh? })` resumes
  `ended` with no prompt, `nothing-to-open` on a live session or no
  record. An open or a send to an `ended` session re-checks the last run's
  job as defined now (`unknown-job` when it is gone) with its recorded
  arguments, its driver part included (`invalid-options`, an open mode
  refused beyond loopback without `acceptOpenNetwork`). A value not
  among its field's choices is refused `not-a-choice`; a folder outside
  the app's `folder-outside-app` (`folder` as the job gave it, no path of
  the server in its message), created when missing, the agent launched
  in its real path; another folder than the one the key's record keeps
  `folder-changed` (but for a start of a new conversation, which records
  the job's folder anew); a prompt that is empty or only whitespace
  `invalid-arguments` (its issue at `prompt`), one over 100,000 characters
  `prompt-too-long`. A job's `key` gives `[a-z0-9-]+` of 100 characters at
  most (a key names a tmux session, a folder and a file of the state
  folder), else the run is refused `invalid-options`. A job with no prompt restarts an `idle` session
  launched with other settings (`resumed`, `settings-changed`). A session
  is ended for a fresh start or a restart by SIGTERM (a kill after 5
  seconds), its turn not interrupted first. A first prompt over 120,000
  UTF-8 bytes, too long for the agent's command line, is typed once the
  agent started and drew its input box, the page's terminals' keys held
  from the agent's start (let through while a start-up dialog waits for
  the person): the session stays `starting` until the agent takes it, and
  the call settles then, pending while a dialog waits; not taken, it is
  `idle`, the call rejects as a send does, and the unit of work is
  recorded, the run kept out of the key's history. Calls on one key run
  one at a time. A session the cap is ending takes no send and no run
  until it is gone (`wrong-state`). `jobs()` describes the jobs (their
  schema as JSON Schema, which fields have choices, whether there is a
  prompt; never a key, prompt, folder or driver part); `options(jobId,
  field, argsSoFar?)` reads a field's choices. The handler serves `POST
  /send`, `POST /open`, `GET /jobs` and `POST /options`, and `run`'s
  `fresh`.
- Records per key in the state folder (`records/<key>.json`, 0600),
  loaded at `createCockpit`: each listed session carries its `record` (its
  conversation, the earlier ones, the history of its runs and opens, a run
  typed into a live session among them as `sent`, each run's arguments as
  the run was given them, read through the job's schema again at an open
  or a send; a send is not kept); a
  recorded key with no live session is listed `ended` (`lost` when it was
  recorded before the server started). A record that is not the cockpit's
  own (a link, another user's, torn) is refused `invalid-options`.
- `createCockpit({ maxSessions })`: a cap on live sessions, off by
  default. At the cap a launch ends the `idle` session idle longest with
  no background task, no terminal attached and no call of its key under
  way (`ended`, `session-cap`),
  else is refused `session-cap-reached` (`cap`, `live`).
- A prompt is typed keeping the person's draft: stashed in the input
  box's kill ring, put back after. A send stopped by anything but the
  input box (a turn the agent began by itself, a dialog) fails
  `wrong-state`; what was typed is cleared and the draft put back while
  the box still shows and the agent has used no tool (one may ask, its
  dialog drawn over the box a moment later); otherwise nothing more is
  typed (a key could answer the dialog) and the error's message says the draft is in the kill ring
  and which keys bring it back. A box showing an entry recalled from the
  prompt history (`History n/m`) is not typed over: the send fails
  `wrong-state`, nothing typed. Control characters but the tab and the
  line break are left out of a typed prompt.
- Every Claude Code session's settings set the input box's editor to the
  standard one (`editorMode: "normal"`): the person's vim mode is off in the
  cockpit's sessions, where the cockpit types prompts.
- `CockpitClient` gains `send`, `open`, `jobs` and `options`, and `run`'s
  `fresh`, each made again once when a renewal of the token overlapped it.
- `TerminalStatus` gains `held`: while the cockpit types a prompt into a
  session, the page's terminals attached to it keep sending what the
  person types, and the server keeps it, then passes it to the session
  once the send is over, in order, each key as it was sent (at most 50 ms
  apart), and the status is `open` again. A terminal that keeps over a
  megabyte of keys is closed with 1008. A person's own `tmux attach` is not
  held.

### Not yet: refused or missing in this version

- `createCockpit` refuses every option but `name`, `directory`, `driver`,
  `jobs`, `hiddenEnv`, `stateDirectory`, `agentPort`, `authorize`,
  `origins`, `terminal`, `port` and `maxSessions`, and every job field but
  `id`, `title`, `description`, `args`, `key`, `prompt`, `driver`,
  `options`, `directory` and `fresh`, with `invalid-options`.
- There is no interrupt, end or remove, and no idle timeout.
- A key whose tmux session an earlier process of the app left cannot be run:
  the run rejects with an error that is not a `CockpitError` (500 on the
  wire, `unreachable` in the client). Such sessions are not listed as
  live: a restarted server lists the recorded keys `ended`.
- `createCockpit` checks the platform and tmux, not Node's version.
- The client has no `sessions.list()`; no events are built.
