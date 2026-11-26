# Changelog

What changes for an app that uses `@duongtdn/agent-cockpit`, release by
release. The versions follow semantic versioning; before 1.0, a minor release
may break.

## Unreleased

Nothing is published yet.

### Added

- The package's six entry points: `.`, `./fastify`, `./claude-code`,
  `./channel`, `./client`, `./terminal`. `./channel` exports nothing yet.
- `createCockpit({ name, directory, driver, jobs, stateDirectory?,
  agentPort?, authorize?, origins?, terminal?, port? })` from `.`, with the types `Cockpit`, `CockpitOptions`,
  `Job`, `RunResult`, `Session` and `EndReason`: checks its options
  (`invalid-options`, any other option refused) and the machine
  (`unsupported-machine`), takes the app's lock (`cockpit-locked`), opens
  the state folder, the app's token and the agent-facing listener. The
  cockpit runs a job on a key with no session (`run`), lists and follows
  the sessions, gives the page's link with the token in its fragment
  (`link`), serves the browser on the mounted handler (`handle`,
  `upgrade`: running a job, listing and following the sessions, and each
  session's terminal over a WebSocket), and `close()`s, the sessions going
  on in tmux. The state folder (`$XDG_STATE_HOME/agent-cockpit/<name>` by
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
  `createCockpit` refuses `authorize` with a driver whose sessions reach an
  open network the app did not accept.
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
- `claudeCode({ permissionMode?, permissions?, acceptOpenNetwork? })` from
  `./claude-code`, with the types `ClaudeCodeOptions`, `PermissionMode` and
  `PermissionRules`: the Claude Code driver, which launches `claude` with settings of its own in the
  cockpit's state folder and without the inherited `CLAUDE_CODE_*` and
  `CLAUDECODE` variables. A session in `default`, `acceptEdits` or
  `dontAsk` counts as keeping its network to the cockpit's allow-list; one
  in `plan`, `auto` or `bypassPermissions` as open, which an app opened
  beyond loopback accepts with `acceptOpenNetwork: true`. Any other option
  is refused with `invalid-options`.
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

### Not yet: refused or missing in this version

- `createCockpit` refuses every option but `name`, `directory`, `driver`,
  `jobs`, `stateDirectory`, `agentPort`, `authorize`, `origins`, `terminal`
  and `port`, and every job field but `id`,
  `title`, `description`, `args`, `key` and `prompt`, with
  `invalid-options`.
- A run on a key that has a session, whatever its state, is refused with
  `wrong-state`: there is no resume, send, open, interrupt, end or remove.
- A run whose agent reports nothing within 30 seconds is ended and refused
  with `unobservable`; start-up dialogs (trusting a folder, logging in) are
  not read, so a session held behind one ends this way.
- An agent that cannot be run is not reported as `agent-not-found`: the run
  resolves with `state: 'ended'`. The agent's version is not checked.
- A key whose tmux session an earlier process of the app left cannot be run:
  the run rejects with an error that is not a `CockpitError` (500 on the
  wire, `unreachable` in the client). Such sessions are not listed, and a
  restarted server lists none of the earlier ones.
- `createCockpit` checks the platform and tmux, not Node's version.
- The client has no `sessions.list()`; no events are built.
