# API reference

Every entry point of `@duongtdn/agent-cockpit`, with its exports, options,
operations and events, and every `CockpitError` code. For the concepts behind
them, read the [guide](guide.md).

**Status:** the first operations are built: creating and mounting a cockpit,
running a job on a key with no session, following the sessions, and the
browser's client and terminal. This reference lists exactly what the package
exports today; a test compares the export tables and the error
table below with the code, so they cannot drift apart.

## Entry points

One package, six entry points, one version: an app's server code and browser
code always match. The browser entries never pull server code into a bundle,
and the channel entry is safe to import on both sides.

Each entry's table lists every export. The kind is `class`, `function`,
`constant` or `type`.

### `@duongtdn/agent-cockpit`

Runs in Node, in the app's server: the server library and its handler.

| Export               | Kind     | What it is                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createCockpit`      | function | `await createCockpit({ name, directory, driver, jobs, stateDirectory?, agentPort? })` checks the options and the machine, opens the state folder, takes the app's lock (waiting a few seconds for a predecessor to exit), opens the app's token and the agent-facing listener, and resolves with the `Cockpit`. Any other option is refused, never ignored. Rejects with `invalid-options`, `unsupported-machine` or `cockpit-locked`. |
| `Cockpit`            | type     | The cockpit: `run(jobId, args)`; `sessions.list()` and `sessions.follow(handler)`; `link(pageUrl)` gives the page's URL with the token in its fragment (`#cockpit=…`); `handle(req, res)` and `upgrade(req, socket, head)`, mounted (the app gives them the requests under its prefix, the prefix removed from `req.url`); `close()` closes every connection and releases the lock, the sessions going on in tmux.                     |
| `CockpitOptions`     | type     | `{ name, directory, driver, jobs, stateDirectory?, agentPort? }`.                                                                                                                                                                                                                                                                                                                                                                      |
| `Job`                | type     | `{ id, title, description?, args, key, prompt? }`: `args` a zod 4 schema; `key(args)` names the unit of work (`[a-z0-9-]+`); `prompt(args)` the first prompt, or none for a job for typing. Any other field is refused.                                                                                                                                                                                                                |
| `RunResult`          | type     | `{ action, reason?, state }`: what a run did and the state it left the session in.                                                                                                                                                                                                                                                                                                                                                     |
| `Session`            | type     | A session: `{ key, state, since }` and what its state carries.                                                                                                                                                                                                                                                                                                                                                                         |
| `EndReason`          | type     | Why a session ended: `'app' \| 'idle-timeout' \| 'session-cap' \| 'restarted' \| 'agent-exit' \| 'declined' \| 'unobservable' \| 'lost'`.                                                                                                                                                                                                                                                                                              |
| `CockpitError`       | class    | Every error the cockpit throws or rejects with; see [Errors](#errors).                                                                                                                                                                                                                                                                                                                                                                 |
| `isCockpitError`     | function | `isCockpitError(value, code?)` tells whether a value is a `CockpitError` (of that code, when one is given) and narrows its type.                                                                                                                                                                                                                                                                                                       |
| `CockpitErrorCode`   | type     | The union of every error code.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `CockpitErrorFields` | type     | The fields each code carries, by code.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `Issue`              | type     | `{ path, message }`: one way a value does not fit what was expected.                                                                                                                                                                                                                                                                                                                                                                   |
| `SessionState`       | type     | `'starting' \| 'idle' \| 'busy' \| 'waiting' \| 'ended'`.                                                                                                                                                                                                                                                                                                                                                                              |
| `Pending`            | type     | `{ kind, id?, dialog? }`: one thing a `waiting` session waits for.                                                                                                                                                                                                                                                                                                                                                                     |
| `StartupDialog`      | type     | `'trust-folder' \| 'bypass-permissions' \| 'onboarding' \| 'login'`: a dialog the agent shows in its terminal before a first prompt.                                                                                                                                                                                                                                                                                                   |

Every browser request and WebSocket upgrade the handler is given passes the
request checks before anything else: it is refused with `refused` when it
comes from beyond the loopback (`remote`), carries `Forwarded`,
`X-Forwarded-For` or `X-Real-IP` (`forwarded`), reaches a local address other
than `127.0.0.1` or `::1` (`local-address`), or names a `Host` or an `Origin`
other than `127.0.0.1` or `localhost`, any port (`host`, `origin`); then
with `no-token` when it does not carry the app's token. A path under the
mount the cockpit does not know is answered 404; an upgrade to one is
refused and its socket ended.

### `@duongtdn/agent-cockpit/fastify`

Runs in Node, in the app's server: the Fastify adapter.

| Export           | Kind     | What it is                                                                                                                                                                                                                      |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cockpitFastify` | function | `app.register(cockpitFastify(cockpit), { prefix: '/cockpit' })` mounts the cockpit under the prefix: its requests, their bodies unread by Fastify, and its WebSocket upgrades. Upgrades outside the prefix are left to the app. |

### `@duongtdn/agent-cockpit/claude-code`

Runs in Node, in the app's server: the Claude Code driver.

| Export              | Kind     | What it is                                                                                                               |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `claudeCode`        | function | `claudeCode(options?)` creates the driver `createCockpit` takes; see [Options](#options). Throws `invalid-options`.      |
| `ClaudeCodeOptions` | type     | `{ permissionMode?, permissions? }`: the driver's options.                                                               |
| `PermissionMode`    | type     | `'default' \| 'acceptEdits' \| 'plan' \| 'auto' \| 'dontAsk' \| 'bypassPermissions'`: the mode a session is launched in. |
| `PermissionRules`   | type     | `{ allow?, ask?, deny? }`: permission rules, as Claude Code's settings write them (`Read`, `Bash(git push:*)`).          |

### `@duongtdn/agent-cockpit/channel`

Runs on both sides: the channel declaration and its types. It exports nothing
yet.

### `@duongtdn/agent-cockpit/client`

Runs in the browser: the framework-free client. It takes the app's token from
the page's link (`#cockpit=…`), removes it from the address bar and keeps it
in the origin's local storage, then sends it with every request (in the
`cockpit-token` header) and every WebSocket (as a subprotocol), never in a
URL. Without a valid token the server refuses every call with `no-token`.

| Export                 | Kind     | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createCockpitClient`  | function | `createCockpitClient({ baseUrl })` creates the client; `baseUrl` is where the app mounted the cockpit (a path or an HTTP URL). Throws `invalid-options` for any other `baseUrl`.                                                                                                                                                                                                                                                                                                                                                                                    |
| `CockpitClient`        | type     | The client: `run(jobId, args)` resolves with the `RunResult` or rejects with the server's `CockpitError` (`unreachable` when the server cannot be reached); `sessions.follow(handler)` delivers the list at once, then at every change, reconnects by itself after a drop (waiting 0.5 s, doubling up to 10 s), and returns a function that stops; `on('error', handler)` tells why a stream could not connect (`no-token`, `refused` or `unreachable`, once per failed attempt, never for a drop that reconnects) and returns a function that removes the handler. |
| `CockpitClientOptions` | type     | `{ baseUrl }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `RunResult`            | type     | `{ action, reason?, state }`: what a run did and the state it left the session in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `Session`              | type     | A session: `{ key, state, since }` and what its state carries (`pending` when `waiting`, `lastMessage?` when `idle`, `canResume` and `reason` when `ended`).                                                                                                                                                                                                                                                                                                                                                                                                        |
| `EndReason`            | type     | Why a session ended: `'app' \| 'idle-timeout' \| 'session-cap' \| 'restarted' \| 'agent-exit' \| 'declined' \| 'unobservable' \| 'lost'`.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `CockpitError`         | class    | The same class the server entry exports: the client rejects with the same codes and fields.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `isCockpitError`       | function | The same function the server entry exports.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `CockpitErrorCode`     | type     | The union of every error code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `CockpitErrorFields`   | type     | The fields each code carries, by code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `Issue`                | type     | `{ path, message }`: one way a value does not fit what was expected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `SessionState`         | type     | `'starting' \| 'idle' \| 'busy' \| 'waiting' \| 'ended'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `Pending`              | type     | `{ kind, id?, dialog? }`: one thing a `waiting` session waits for.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `StartupDialog`        | type     | `'trust-folder' \| 'bypass-permissions' \| 'onboarding' \| 'login'`: a dialog the agent shows in its terminal before a first prompt.                                                                                                                                                                                                                                                                                                                                                                                                                                |

### `@duongtdn/agent-cockpit/terminal`

Runs in the browser: the mounted terminal, an xterm.js terminal of the
cockpit's own in an element of the app's. It reaches the server with the
app's token as the client keeps it. The page links xterm.js's style sheet,
`@xterm/xterm/css/xterm.css`.

| Export                 | Kind     | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mountTerminal`        | function | `mountTerminal(element, key, { baseUrl, theme?, fontFamily?, fontSize? })` mounts the session's terminal in the element, fitted to it and following its size, and attaches it to the session. Keys: the session's driver sends its key rules (for Claude Code, Shift+Enter types a new line). Copy: text the session copies (the agent's selection, tmux's) reaches the clipboard; a selection of the terminal's own (Shift+drag, Option+drag on macOS) is copied by Ctrl+C, which then sends nothing to the session. Throws `invalid-options` for a `key` that is no session key or a `baseUrl` that is not a path or an HTTP URL. |
| `MountedTerminal`      | type     | The mounted terminal: `on('status', handler)` gives the status at once, then each change (`connecting`, `open`, `closed`, `ended`), and returns a function that removes the handler; after a drop the terminal reconnects by itself (waiting 0.5 s, doubling up to 10 s), and once the session has ended it stays `ended`; `focus()`; `dispose()` closes the connection and removes the terminal, the session goes on.                                                                                                                                                                                                              |
| `MountTerminalOptions` | type     | `{ baseUrl, theme?, fontFamily?, fontSize? }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `TerminalStatus`       | type     | `'connecting' \| 'open' \| 'closed' \| 'ended'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `CockpitError`         | class    | The same class the server entry exports.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `isCockpitError`       | function | The same function the server entry exports.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `CockpitErrorCode`     | type     | The union of every error code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `CockpitErrorFields`   | type     | The fields each code carries, by code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `Issue`                | type     | `{ path, message }`: one way a value does not fit what was expected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## Options

### `claudeCode(options?)`

| Option           | Default     | What it does                                                                                                                                                                                    |
| ---------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `permissionMode` | `'default'` | The mode every session is launched in (`--permission-mode`). It is always passed, so the person's own `defaultMode` never applies by accident.                                                  |
| `permissions`    | none        | Rules to allow, ask and deny, written in every session's settings, above the person's and the project's. Claude Code weighs deny, then ask, then allow: an allow never lifts their deny or ask. |

Any other option is refused with `invalid-options`, never ignored. The driver
launches `claude` from the `PATH` of the server's environment, without the
variables Claude Code sets for the programs it runs (`CLAUDE_CODE_*`,
`CLAUDECODE`), so a server started from a Claude Code terminal does not hand
that session's to its agents. Each session's settings and its token are
written in the cockpit's state folder, readable by the app's user alone;
the token is never on a command line or in the environment.

## Operations

`cockpit.run(jobId, args)`, in the app's server and in the browser's client
alike, checks the arguments against the job's schema (`unknown-job`,
`invalid-arguments`), derives the key, launches the agent on a key with no
session and resolves once the session leaves `starting`: `{ action:
'started', state: 'busy' }` once the agent took the prompt, `state: 'idle'`
for a job without one. In this version a run on a key that has a session,
whatever its state, is refused with `wrong-state`; one whose agent reports
nothing within 30 seconds is ended and refused with `unobservable`.
`cockpit.sessions.list()` and `cockpit.sessions.follow(handler)` give each
session's key, state, `since` and what its state carries.

## Events

No event is built yet.

## Errors

Every error the cockpit throws or rejects with, on the server and in the
client alike, is a `CockpitError`: an `Error` with a kebab-case `code`, a
`message` in English for logs and developers (the app words its own for the
person), and the fields of its code. The code decides the fields, so
`switch (error.code)` narrows them in TypeScript. "Nothing to do" is never an
error: an operation says so in its result.

The table below says what each code is for; some belong to operations not
built yet.

```ts
import { isCockpitError } from '@duongtdn/agent-cockpit/client';

try {
  await somethingThatMayReject();
} catch (error) {
  if (!isCockpitError(error)) throw error;
  switch (error.code) {
    case 'wrong-state':
      showState(error.state, error.pending);
      break;
    case 'invalid-arguments':
      showIssues(error.issues);
      break;
    default:
      showFailure(error.message);
  }
}
```

`new CockpitError(code, message, fields)` creates one; an app rarely needs
to. Any error may also carry `cause`, the error that lies under it; on
`unobservable` and `refused`, `cause` is a field of the code instead.

The fields are properties of the error itself. `JSON.stringify(error)` keeps
its `name` (`'CockpitError'`), `code`, `message` and the fields of its code;
it leaves out the stack and the error that lies under it.

A field marked `?` is optional. "A launch" is anything that starts the
agent: a run, an open, or a send to an ended session.

| Code                    | Fields                      | When                                                                                                                                                                                                                            |
| ----------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid-options`       | `issues`                    | The options given to a factory do not fit. `issues` is a list of `{ path, message }`.                                                                                                                                           |
| `unsupported-machine`   | `what`, `found`, `required` | The machine lacks something the cockpit needs. `what` is `'platform'`, `'tmux'` or `'node'`; `found` and `required` say what it has and what is needed.                                                                         |
| `cockpit-locked`        | `holder`                    | Another process of the app already runs a cockpit with sessions. `holder` is its process id, as the system tells it, or `'another-user'` when the lock is held by a process of another user, whose id the cockpit cannot learn. |
| `unknown-job`           | `jobId`                     | The app has no job of that id, or no longer has the job a unit of work last ran.                                                                                                                                                |
| `invalid-arguments`     | `issues`                    | The arguments do not fit the job's schema. `issues` is a list of `{ path, message }`.                                                                                                                                           |
| `not-a-choice`          | `field`, `value`            | A value is not among the choices its field offers.                                                                                                                                                                              |
| `folder-outside-app`    | `folder`                    | The job's folder lies outside the app's.                                                                                                                                                                                        |
| `folder-changed`        | `recorded`, `computed`      | The job's folder (`computed`) differs from the one its unit of work started in (`recorded`).                                                                                                                                    |
| `unknown-key`           | `key`                       | No unit of work has that key: a unit of work begins with a run.                                                                                                                                                                 |
| `wrong-state`           | `key`, `state`, `pending?`  | The session's state refuses the operation. On a `waiting` session, `pending` lists everything it waits for: `{ kind: 'ask' \| 'request' \| 'terminal', id?, dialog? }`.                                                         |
| `prompt-not-taken`      | `key`, `state`              | The agent did not take the prompt.                                                                                                                                                                                              |
| `prompt-too-long`       | `length`, `max`             | The prompt is longer than the cockpit types.                                                                                                                                                                                    |
| `interrupt-unconfirmed` | `key`, `state`              | The turn was interrupted, but the session was not seen idle in time. `state` is the last one known.                                                                                                                             |
| `agent-not-found`       | `command`                   | A launch: the agent's command cannot be run.                                                                                                                                                                                    |
| `agent-too-old`         | `found`, `oldestTested`     | A launch: the agent is older than the oldest version the driver was tested on.                                                                                                                                                  |
| `unobservable`          | `key`, `cause`              | A launch: the agent's signals do not arrive, and the session was ended. `cause` is what the driver could tell of the reason.                                                                                                    |
| `session-cap-reached`   | `cap`, `live`               | A launch: the cap on live sessions is reached and no idle one can be ended. `live` lists their keys.                                                                                                                            |
| `unknown-id`            | `id`                        | No ask or channel request has that id.                                                                                                                                                                                          |
| `already-settled`       | `id`, `by`                  | The ask or channel request was settled before this answer. `by` is `'app'`, `'terminal'`, `'cancelled'` or `'lost'`.                                                                                                            |
| `terminal-only`         | `id`                        | The ask can only be answered in the terminal.                                                                                                                                                                                   |
| `invalid-answer`        | `id`, `issues`              | The answer does not fit what the ask or the channel request expects.                                                                                                                                                            |
| `not-logged-in`         | —                           | A one-shot call: the agent is not logged in.                                                                                                                                                                                    |
| `model-unavailable`     | `model`                     | A one-shot call: the model asked for cannot be used.                                                                                                                                                                            |
| `invalid-output`        | `issues`, `raw`             | A one-shot call: the result (`raw`) does not fit the output schema.                                                                                                                                                             |
| `api-error`             | `status?`, `detail`         | A one-shot call: the model's API answered with an error.                                                                                                                                                                        |
| `refused`               | `cause`                     | The request checks refused a request. `cause` is `'remote'`, `'forwarded'`, `'origin'`, `'host'`, `'local-address'` or `'terminal-off'`.                                                                                        |
| `no-token`              | —                           | A browser request carries no valid token: the person must open the app's link.                                                                                                                                                  |
| `unreachable`           | —                           | The client cannot reach the server.                                                                                                                                                                                             |
