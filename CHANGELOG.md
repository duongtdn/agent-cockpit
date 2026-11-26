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
  agentPort? })` from `.`, with the types `Cockpit`, `CockpitOptions`,
  `Job`, `RunResult`, `Session` and `EndReason`: checks its options
  (`invalid-options`, any other option refused) and the machine
  (`unsupported-machine`), takes the app's lock (`cockpit-locked`), opens
  the state folder, the app's token and the agent-facing listener. The
  cockpit runs a job on a key with no session (`run`), lists and follows
  the sessions, gives the page's link with the token in its fragment
  (`link`), serves the browser on the mounted handler (`handle`,
  `upgrade`: running a job, listing and following the sessions, and each
  session's terminal over a WebSocket), and `close()`s.
- The handler's request checks, for every request and upgrade: refused
  (`refused`) from beyond the loopback, through a forwarding header, to a
  local address other than `127.0.0.1` or `::1`, or with a `Host` or
  `Origin` other than `127.0.0.1` or `localhost`; then `no-token` without
  the app's token.
- `cockpitFastify(cockpit)` from `./fastify`: mounts the cockpit under the
  prefix it is registered with, its WebSocket upgrades included.
- `CockpitError` and `isCockpitError`, from `.` and `./client`, with the types
  `CockpitErrorCode`, `CockpitErrorFields` and `Issue`: one error class, a
  kebab-case `code`, and the fields of each code. `JSON.stringify` keeps an
  error's `name`, `code`, `message` and fields.
- The types `SessionState`, `Pending` and `StartupDialog`, from `.` and
  `./client`: what the errors' fields are made of.
- `claudeCode({ permissionMode?, permissions? })` from `./claude-code`, with
  the types `ClaudeCodeOptions`, `PermissionMode` and `PermissionRules`: the
  Claude Code driver, which launches `claude` with settings of its own in the
  cockpit's state folder and without the inherited `CLAUDE_CODE_*` and
  `CLAUDECODE` variables. Any other option is refused with
  `invalid-options`.
- `mountTerminal(element, key, { baseUrl, theme?, fontFamily?, fontSize? })`
  from `./terminal`: a session's terminal (xterm.js) in the app's element,
  fitted to it, attached over a WebSocket with the app's token, reconnecting
  after a drop, `ended` once the session is gone; the driver's key rules;
  copy through OSC 52 and Ctrl+C on the terminal's own selection; status
  events, `focus()` and `dispose()`.
