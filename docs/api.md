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

| Export               | Kind     | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createCockpit`      | function | `await createCockpit({ name, directory, driver, jobs, stateDirectory?, agentPort? })` checks the options (see [Options](#options)) and the machine (Linux, tmux), opens the state folder, takes the app's lock (waiting 5 seconds for a predecessor to exit), opens the app's token and the agent-facing listener, and resolves with the `Cockpit`. Rejects with `invalid-options`, `unsupported-machine` (`what: 'platform'` or `'tmux'`) or `cockpit-locked`.                                                                                                                                                      |
| `Cockpit`            | type     | The cockpit: `run(jobId, args)`; `sessions.list()` and `sessions.follow(handler)`; `link(pageUrl)` gives the page's URL (`http:` or `https:`, else `invalid-options`) with the token in its fragment (`#cockpit=…`); `handle(req, res)` and `upgrade(req, socket, head)`, mounted (see [Mounting](#mounting)); `close()` closes every WebSocket, detaches every terminal, stops the agent-facing listener and releases the lock, the sessions going on in tmux, nothing killed; a run still pending rejects (an error with no code, 500 on the wire), and so does a later one; the handler answers 503 from then on. |
| `CockpitOptions`     | type     | `{ name, directory, driver, jobs, stateDirectory?, agentPort? }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `Job`                | type     | `{ id, title, description?, args, key, prompt? }`: `args` a zod 4 schema; `key(args)` names the unit of work (`[a-z0-9-]+`); `prompt(args)` the first prompt, or none for a job for typing. Any other field is refused.                                                                                                                                                                                                                                                                                                                                                                                              |
| `RunResult`          | type     | `{ action, reason?, state }`: what a run did and the state it left the session in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `Session`            | type     | A session: `{ key, state, since }` and what its state carries.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `EndReason`          | type     | Why a session ended: `'app' \| 'idle-timeout' \| 'session-cap' \| 'restarted' \| 'agent-exit' \| 'declined' \| 'unobservable' \| 'lost'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `CockpitError`       | class    | Every error the cockpit throws or rejects with; see [Errors](#errors).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `isCockpitError`     | function | `isCockpitError(value, code?)` tells whether a value is a `CockpitError` (of that code, when one is given) and narrows its type.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `CockpitErrorCode`   | type     | The union of every error code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `CockpitErrorFields` | type     | The fields each code carries, by code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `Issue`              | type     | `{ path, message }`: one way a value does not fit what was expected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `SessionState`       | type     | `'starting' \| 'idle' \| 'busy' \| 'waiting' \| 'ended'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `Pending`            | type     | `{ kind, id?, dialog? }`: one thing a `waiting` session waits for.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `StartupDialog`      | type     | `'trust-folder' \| 'bypass-permissions' \| 'onboarding' \| 'login'`: a dialog the agent shows in its terminal before a first prompt.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### `@duongtdn/agent-cockpit/fastify`

Runs in Node, in the app's server: the Fastify adapter.

| Export           | Kind     | What it is                                                                                                                                                                                                                                                                                            |
| ---------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cockpitFastify` | function | `app.register(cockpitFastify(cockpit), { prefix: '/cockpit' })` mounts the cockpit under the prefix: its requests, their bodies unread by Fastify, and its WebSocket upgrades. Upgrades outside the prefix are left to the app's own upgrade listeners; with none, they are ended, as Node ends them. |

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
URL. The token is the page's: every client and terminal of the page has it,
whichever took it from the link, and keeps it in memory when the browser
refuses the page its storage. Without a valid token the server refuses every
call with `no-token`.

| Export                 | Kind     | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createCockpitClient`  | function | `createCockpitClient({ baseUrl })` creates the client; `baseUrl` is where the app mounted the cockpit (a path or an HTTP URL). Throws `invalid-options` for any other `baseUrl`.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `CockpitClient`        | type     | The client: `run(jobId, args)` resolves with the `RunResult` or rejects with the server's `CockpitError` (`unreachable` when the server cannot be reached or what answers is not the cockpit); `sessions.follow(handler)` delivers the list at once, then at every change, reconnects by itself after a drop (waiting 0.5 s, doubling up to 10 s), and returns a function that stops; `on('error', handler)` tells why a stream could not connect (`no-token`, `refused` or `unreachable`, once per failed attempt, never for a drop that reconnects) and returns a function that removes the handler. |
| `CockpitClientOptions` | type     | `{ baseUrl }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `RunResult`            | type     | `{ action, reason?, state }`: what a run did and the state it left the session in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `Session`              | type     | A session: `{ key, state, since }` and what its state carries (`pending` when `waiting`, `lastMessage?` when `idle`, `canResume` and `reason` when `ended`).                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `EndReason`            | type     | Why a session ended: `'app' \| 'idle-timeout' \| 'session-cap' \| 'restarted' \| 'agent-exit' \| 'declined' \| 'unobservable' \| 'lost'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `CockpitError`         | class    | The same class the server entry exports: the client rejects with the same codes and fields.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `isCockpitError`       | function | The same function the server entry exports.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `CockpitErrorCode`     | type     | The union of every error code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `CockpitErrorFields`   | type     | The fields each code carries, by code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `Issue`                | type     | `{ path, message }`: one way a value does not fit what was expected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `SessionState`         | type     | `'starting' \| 'idle' \| 'busy' \| 'waiting' \| 'ended'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `Pending`              | type     | `{ kind, id?, dialog? }`: one thing a `waiting` session waits for.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `StartupDialog`        | type     | `'trust-folder' \| 'bypass-permissions' \| 'onboarding' \| 'login'`: a dialog the agent shows in its terminal before a first prompt.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### `@duongtdn/agent-cockpit/terminal`

Runs in the browser: the mounted terminal, an xterm.js terminal of the
cockpit's own in an element of the app's. It reaches the server with the
app's token as the client keeps it. The page links xterm.js's style sheet,
`@xterm/xterm/css/xterm.css`.

| Export                 | Kind     | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mountTerminal`        | function | `mountTerminal(element, key, { baseUrl, theme?, fontFamily?, fontSize? })` mounts the session's terminal in the element, fitted to it and following its size, and attaches it to the session. Keys: the session's driver sends its key rules (for Claude Code, Shift+Enter types a new line). Copy: text the session copies (the agent's selection, tmux's) reaches the clipboard; a selection of the terminal's own (Shift+drag, Option+drag on macOS) is copied by Ctrl+C, which then sends nothing to the session. Throws `invalid-options` for a `key` that is no session key or a `baseUrl` that is not a path or an HTTP URL. |
| `MountedTerminal`      | type     | The mounted terminal: `on('status', handler)` gives the status at once, then each change, and returns a function that removes the handler: `connecting`, `open`, `closed` (the connection dropped or was refused; the terminal reconnects by itself, waiting 0.5 s, doubling up to 10 s), `ended` (no session of the key lives, or it has ended: it stays `ended`). The terminal does not say why a connection failed; the client's `on('error')` does, for the same token and checks; `focus()`; `dispose()` closes the connection and removes the terminal, the session goes on.                                                  |
| `MountTerminalOptions` | type     | `{ baseUrl, theme?, fontFamily?, fontSize? }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `TerminalStatus`       | type     | `'connecting' \| 'open' \| 'closed' \| 'ended'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `CockpitError`         | class    | The same class the server entry exports.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `isCockpitError`       | function | The same function the server entry exports.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `CockpitErrorCode`     | type     | The union of every error code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `CockpitErrorFields`   | type     | The fields each code carries, by code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `Issue`                | type     | `{ path, message }`: one way a value does not fit what was expected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## Mounting

`cockpit.handle(req, res)` and `cockpit.upgrade(req, socket, head)` take
`node:http` objects. They are mounted: the app gives them only the requests
under its prefix, with the prefix removed from `req.url`, and every path they
are given is the cockpit's. `cockpitFastify` does that for Fastify; on a
plain `node:http` server the app tests the prefix and removes it itself (the
[guide](guide.md#getting-started) shows how). The client's and the
terminal's `baseUrl` is that prefix. There is no `prefix` option.

Every request and WebSocket upgrade the handler is given passes the request
checks before anything else. It is refused with `refused` when it comes from
beyond the loopback (`cause: 'remote'`), carries `Forwarded`,
`X-Forwarded-For` or `X-Real-IP` (`'forwarded'`), reaches a local address
other than `127.0.0.1` or `::1` (`'local-address'`), or names a `Host` or an
`Origin` other than `127.0.0.1` or `localhost`, any port (`'host'`,
`'origin'`); then with `no-token` when it does not carry the app's token. In
this version nothing opens the cockpit beyond the loopback.

Under the mount the cockpit serves its own wire, which the client and the
terminal speak; an app never calls it, and it may change from one version to
the next. Its paths, for the app's logs and proxy:

| Path               | Method    | What it is                             |
| ------------------ | --------- | -------------------------------------- |
| `/run`             | `POST`    | Runs a job: the client's `run`.        |
| `/sessions`        | `GET`     | Lists the sessions.                    |
| `/follow/sessions` | WebSocket | Follows the sessions.                  |
| `/terminal/<key>`  | WebSocket | A session's terminal (the pty bridge). |

A path the cockpit does not know is answered 404, and an upgrade to one is
refused and its socket ended; it never falls through to the app. A known
path asked with another method is answered 405 (with `Allow`), a WebSocket's
path asked as a plain request 426, a body over 1 MiB 413. A `CockpitError`
is answered with the HTTP status of its code (see [Errors](#errors)) and the
error as JSON, `{ "error": { "name", "code", "message", …fields } }`; any
other failure with 500 and no body, which the client reports as
`unreachable`. No answer may be cached (`Cache-Control: no-store`). The
token travels in the `cockpit-token` header and, on a WebSocket, in a
subprotocol; never in a URL.

## Options

### `createCockpit(options)`

| Option           | Default                                | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`           | required                               | The app's name, any non-empty text: its tmux socket (`agent-cockpit-<name>`), its state folder and its lock are named after it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `directory`      | required                               | The app's folder, where its sessions run: an existing folder, absolute or relative to the server's working folder.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `driver`         | required                               | The agent's driver: `claudeCode(…)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `jobs`           | required                               | The jobs the app offers, each with an id of its own: `{ id, title, description?, args, key, prompt? }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `stateDirectory` | `$XDG_STATE_HOME/agent-cockpit/<name>` | The folder the cockpit keeps its own files in, itself, not a parent (`~/.local/state` when `XDG_STATE_HOME` is unset): the cockpit's own, so private: created readable by the app's user alone when missing (missing parents `0755`, whatever the umask, once the existing ones are checked); one that exists must be a folder of the user's, never a symbolic link, and is narrowed to the user alone. Every folder above it, a symbolic link by its own owner and by where it leads, must be the user's or root's, writable by others only with the sticky bit (as `/tmp`), and by its group only so or when the group is the user's private one (listed once in `/etc/group`, named after the user, no other member there, and no other user's primary group in `/etc/passwd`); so not a Windows drive under WSL2 (`/mnt/c`). A file the cockpit reads in it must be a regular file of the user's: one others could read is narrowed, the app's token minted anew. Otherwise `invalid-options`, its issue on `stateDirectory` (on the options as a whole, naming the folder, for the default folder). |
| `agentPort`      | one the system chooses, then kept      | The port of the agent-facing listener, on `127.0.0.1`. Left out, the port chosen at the first start is kept in the state folder and taken again at each start.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Any other option, and any other field of a job, is refused with
`invalid-options`, never ignored: this version takes no `hiddenEnv`,
`idleTimeout`, `maxSessions`, `authorize`, `origins`, `terminal`, `port`,
`channel` or `elicitations`, and no job's `options`, `directory`, `fresh` or
`driver`. Two jobs with one id, or a `directory` that is no folder, are
refused too.

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
for a job without one, `state: 'ended'` when the agent exited before it
reported (a `claude` that cannot run is seen this way in this version).

What this version refuses, for now:

- A run on a key that has a session, whatever its state (`ended`
  included), is refused with `wrong-state`; there is no resume, send, open,
  interrupt, end or remove yet.
- A run whose agent reports nothing within 30 seconds is ended and refused
  with `unobservable`. A start-up dialog (trusting a folder, logging in) is
  not read yet, so a session held behind one ends this way: the app's
  folder must be one the person has trusted in Claude Code.
- A key whose tmux session was left by an earlier process of the app (the
  sessions go on when the server stops) cannot be run: the run rejects with
  an error that is not a `CockpitError`, answered 500 on the wire, which the
  client reports as `unreachable`. Such sessions are not listed.
- Sessions are kept in memory: a restarted server lists none of the earlier
  ones.

`cockpit.sessions.list()` gives each session's key, state, `since` and what
its state carries, in the order their keys were first run;
`cockpit.sessions.follow(handler)` gives that list at once, then at every
change, and returns a function that stops. A session that ends is seen
within a second. The client's `sessions.follow` gives the same list.

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
agent: a run, an open, or a send to an ended session. "HTTP" is the status
the handler answers the code with, for logs, proxies and a network panel;
the client reads the error from the answer's body alone. The codes of
creating the cockpit, of the one-shot call and the client's own
`unreachable` are never raised by a request; the table gives the status
they would have.

| Code                    | Fields                      | HTTP | When                                                                                                                                                                                                                            |
| ----------------------- | --------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid-options`       | `issues`                    | 500  | The options given to a factory do not fit. `issues` is a list of `{ path, message }`.                                                                                                                                           |
| `unsupported-machine`   | `what`, `found`, `required` | 500  | The machine lacks something the cockpit needs. `what` is `'platform'`, `'tmux'` or `'node'`; `found` and `required` say what it has and what is needed.                                                                         |
| `cockpit-locked`        | `holder`                    | 500  | Another process of the app already runs a cockpit with sessions. `holder` is its process id, as the system tells it, or `'another-user'` when the lock is held by a process of another user, whose id the cockpit cannot learn. |
| `unknown-job`           | `jobId`                     | 404  | The app has no job of that id, or no longer has the job a unit of work last ran.                                                                                                                                                |
| `invalid-arguments`     | `issues`                    | 400  | The arguments do not fit the job's schema. `issues` is a list of `{ path, message }`.                                                                                                                                           |
| `not-a-choice`          | `field`, `value`            | 400  | A value is not among the choices its field offers.                                                                                                                                                                              |
| `folder-outside-app`    | `folder`                    | 400  | The job's folder lies outside the app's.                                                                                                                                                                                        |
| `folder-changed`        | `recorded`, `computed`      | 409  | The job's folder (`computed`) differs from the one its unit of work started in (`recorded`).                                                                                                                                    |
| `unknown-key`           | `key`                       | 404  | No unit of work has that key: a unit of work begins with a run.                                                                                                                                                                 |
| `wrong-state`           | `key`, `state`, `pending?`  | 409  | The session's state refuses the operation. On a `waiting` session, `pending` lists everything it waits for: `{ kind: 'ask' \| 'request' \| 'terminal', id?, dialog? }`.                                                         |
| `prompt-not-taken`      | `key`, `state`              | 409  | The agent did not take the prompt.                                                                                                                                                                                              |
| `prompt-too-long`       | `length`, `max`             | 400  | The prompt is longer than the cockpit types.                                                                                                                                                                                    |
| `interrupt-unconfirmed` | `key`, `state`              | 504  | The turn was interrupted, but the session was not seen idle in time. `state` is the last one known.                                                                                                                             |
| `agent-not-found`       | `command`                   | 503  | A launch: the agent's command cannot be run.                                                                                                                                                                                    |
| `agent-too-old`         | `found`, `oldestTested`     | 503  | A launch: the agent is older than the oldest version the driver was tested on.                                                                                                                                                  |
| `unobservable`          | `key`, `cause`              | 502  | A launch: the agent's signals do not arrive, and the session was ended. `cause` is what the driver could tell of the reason.                                                                                                    |
| `session-cap-reached`   | `cap`, `live`               | 503  | A launch: the cap on live sessions is reached and no idle one can be ended. `live` lists their keys.                                                                                                                            |
| `unknown-id`            | `id`                        | 404  | No ask or channel request has that id.                                                                                                                                                                                          |
| `already-settled`       | `id`, `by`                  | 409  | The ask or channel request was settled before this answer. `by` is `'app'`, `'terminal'`, `'cancelled'` or `'lost'`.                                                                                                            |
| `terminal-only`         | `id`                        | 409  | The ask can only be answered in the terminal.                                                                                                                                                                                   |
| `invalid-answer`        | `id`, `issues`              | 400  | The answer does not fit what the ask or the channel request expects.                                                                                                                                                            |
| `not-logged-in`         | —                           | 502  | A one-shot call: the agent is not logged in.                                                                                                                                                                                    |
| `model-unavailable`     | `model`                     | 502  | A one-shot call: the model asked for cannot be used.                                                                                                                                                                            |
| `invalid-output`        | `issues`, `raw`             | 502  | A one-shot call: the result (`raw`) does not fit the output schema.                                                                                                                                                             |
| `api-error`             | `status?`, `detail`         | 502  | A one-shot call: the model's API answered with an error.                                                                                                                                                                        |
| `refused`               | `cause`                     | 403  | The request checks refused a request. `cause` is `'remote'`, `'forwarded'`, `'origin'`, `'host'`, `'local-address'` or `'terminal-off'`.                                                                                        |
| `no-token`              | —                           | 401  | A browser request carries no valid token: the person must open the app's link.                                                                                                                                                  |
| `unreachable`           | —                           | 500  | The client cannot reach the server.                                                                                                                                                                                             |
