# Changelog

What changes for an app that uses `@duongtdn/agent-cockpit`, release by
release. The versions follow semantic versioning; before 1.0, a minor release
may break.

## Unreleased

Nothing is published yet.

### Added

- The package's six entry points: `.`, `./fastify`, `./claude-code`,
  `./channel`, `./client`, `./terminal`. Only `.`, `./client` and
  `./terminal` export anything so far; nothing runs a session yet.
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
  `invalid-options`. No cockpit takes it yet.
- `mountTerminal(element, key, { baseUrl, theme?, fontFamily?, fontSize? })`
  from `./terminal`: a session's terminal (xterm.js) in the app's element,
  fitted to it, attached over a WebSocket with the app's token, reconnecting
  after a drop, `ended` once the session is gone; the driver's key rules;
  copy through OSC 52 and Ctrl+C on the terminal's own selection; status
  events, `focus()` and `dispose()`.
