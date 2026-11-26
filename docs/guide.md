# Guide

The concepts an app meets when it uses `@duongtdn/agent-cockpit`. For the
exact names and types, read the [API reference](api.md).

**Status:** the first path is built: a cockpit mounted in the app's server,
a job run on a key with no session, the sessions followed live, a
session's terminal in the page, access (the app's own API routes,
opening beyond loopback, and renewing the token), and the Claude Code
driver: its options, a job's driver part, the sandbox and the agent's
version. The sections after "Getting started" are
written as the parts they describe are built; until then they only say what
they will cover. [examples/jobs-console](../examples/jobs-console/DEMO.md) is
a whole app that does what this guide shows;
[examples/translate-and-access](../examples/translate-and-access/DEMO.md)
shows access.

## Getting started

### The server

The app creates one cockpit in its server, with its name, its folder, the
driver and its jobs, mounts it under a prefix, and prints the link a person
opens. On Fastify:

```js
import { createCockpit } from '@duongtdn/agent-cockpit';
import { claudeCode } from '@duongtdn/agent-cockpit/claude-code';
import { cockpitFastify } from '@duongtdn/agent-cockpit/fastify';
import Fastify from 'fastify';
import { z } from 'zod';

const cockpit = await createCockpit({
  name: 'my-app',
  directory: process.cwd(),
  driver: claudeCode(),
  jobs: [
    {
      id: 'explain',
      title: 'Explain a file',
      args: z.object({ file: z.string() }),
      key: ({ file }) => `explain-${file.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      prompt: ({ file }) => `Explain the file ${file} in a few sentences.`,
    },
  ],
});

const app = Fastify();
await app.register(cockpitFastify(cockpit), { prefix: '/cockpit' });
// … the app's own routes, its page among them …
await app.listen({ host: '127.0.0.1', port: 4310 });
console.log(`Open ${cockpit.link('http://127.0.0.1:4310/')}`);
```

`createCockpit` takes the app's lock: a second process of the same app
waits 5 seconds for the first to exit, then rejects with `cockpit-locked`.
On a stop, `await cockpit.close()` before closing the server: it closes the
page's WebSockets, which would hold the server open. The sessions go on in
tmux.

Listen on `127.0.0.1` (or `::1`): by default the cockpit serves the
loopback only, and refuses what reaches it otherwise
([security](security.md)). The Fastify adapter tells the cockpit the ports
the server listens on, so that the agent's sandbox is kept from them; a run
before the server listens is refused with `no-app-port`.

On a plain `node:http` server, the app gives the cockpit only the requests
under its prefix, the prefix removed from the URL, and keeps the rest. It
gives the cockpit its port too, which the cockpit cannot read from the
server (`port`; a list for several), or every run is refused with
`no-app-port`:

```js
import { createServer } from 'node:http';

const PORT = 4310;
const PREFIX = '/cockpit';

const cockpit = await createCockpit({
  name: 'my-app',
  directory: process.cwd(),
  driver: claudeCode(),
  jobs,
  port: PORT, // the port the server listens on, below
});

/** Removes the prefix from the request's URL; false when the request is not under it. */
function underPrefix(request) {
  const url = request.url ?? '/';
  const rest = url.slice(PREFIX.length);
  if (!url.startsWith(PREFIX) || !(rest === '' || rest.startsWith('/') || rest.startsWith('?'))) {
    return false;
  }
  request.url = rest.startsWith('/') ? rest : `/${rest}`;
  return true;
}

const server = createServer((request, response) => {
  if (underPrefix(request)) cockpit.handle(request, response);
  else serveTheApp(request, response);
});
server.on('upgrade', (request, socket, head) => {
  if (underPrefix(request)) cockpit.upgrade(request, socket, head);
  else socket.destroy();
});
server.listen(PORT, '127.0.0.1');
```

A server that serves nothing but the cockpit gives it every request as it
comes. Every path under the prefix is the cockpit's: one it does not know is
answered 404, never passed on to the app.

### The page

The page uses two browser entries: `./client` to run jobs and follow the
sessions, `./terminal` to mount a session's terminal. Both take `baseUrl`,
the prefix the cockpit is mounted under. The page links xterm.js's style
sheet, `@xterm/xterm/css/xterm.css`.

```js
import { createCockpitClient } from '@duongtdn/agent-cockpit/client';
import { mountTerminal } from '@duongtdn/agent-cockpit/terminal';

const client = createCockpitClient({ baseUrl: '/cockpit' }); // takes the token from the link
client.on('error', (error) => showConnection(error.code)); // 'no-token', 'refused', 'unreachable'
client.sessions.follow((sessions) => showSessions(sessions)); // now, then at every change

const result = await client.run('explain', { file: 'README.md' }); // { action: 'started', state: 'busy' }

const terminal = mountTerminal(document.getElementById('terminal'), 'explain-readme-md', {
  baseUrl: '/cockpit',
});
terminal.on('status', (status) => showStatus(status)); // 'connecting' | 'open' | 'closed' | 'ended'
```

With a bundler, import the entries by their names, and the style sheet from
the page's code or its HTML. Without one, the page loads the modules as the
package built them, through an import map:

```html
<link rel="stylesheet" href="/modules/xterm/xterm.css" />
<script type="importmap">
  {
    "imports": {
      "@duongtdn/agent-cockpit/client": "/modules/agent-cockpit/client/index.js",
      "@duongtdn/agent-cockpit/terminal": "/modules/agent-cockpit/terminal/index.js",
      "@xterm/xterm": "/modules/xterm/xterm.mjs",
      "@xterm/addon-fit": "/modules/addon-fit/addon-fit.mjs"
    }
  }
</script>
<script type="module" src="/page.js"></script>
```

The app's server then serves the `.js` files of the package's `dist/client/`,
`dist/terminal/` and `dist/shared/` folders (the entries import one another
by relative paths), xterm.js's `lib/xterm.mjs` and `css/xterm.css`, and
`@xterm/addon-fit`'s `lib/addon-fit.mjs`. xterm.js is a dependency of the
cockpit, not of the app: under pnpm, which lets a package see only its own
dependencies, the app finds it from the cockpit's entry. The example's
`server.js` serves the same files.

```js
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const fromCockpit = createRequire(import.meta.resolve('@duongtdn/agent-cockpit/terminal'));
const xtermFolder = dirname(fromCockpit.resolve('@xterm/xterm/package.json'));
```

### The link

The person opens the link the server printed:
`http://127.0.0.1:4310/#cockpit=<token>`. The client takes the token from
the fragment, removes it from the address bar and keeps it in the page's
local storage, so a reload needs no link. A link pasted into a tab that
already shows the page is taken too, and the page reconnects with it. A
page without the token is
refused with `no-token`: the app tells the person to open the link. The
token stays the same from one start of the app to the next.

### The app's own API routes

The cockpit checks only the requests under its mount. A route of the app's
that should answer only the person's page checks the same token: the page
sends `cockpitHeaders()` (from `./client`), the server calls
`cockpit.verify(request)`.

```js
// The page
import { cockpitHeaders } from '@duongtdn/agent-cockpit/client';
const answer = await fetch('/api/whoami', { headers: cockpitHeaders() });

// The server (Fastify)
app.get('/api/whoami', async (request, reply) => {
  if (!cockpit.verify(request)) return reply.code(401).send();
  return { from: request.socket.remoteAddress };
});
```

Guard the API routes, not the pages: opening the link, or reloading, is a
navigation, which carries no header, so a page guarded by `verify` would
never load.

### Renewing the token

`await cockpit.renewToken()` replaces the token: the old link stops working
at once, every page's WebSockets are closed (its terminals too), and each
page needs the new link, which `cockpit.link(…)` now gives. An app offers it
when a link may have leaked. It is the only act that closes every open
socket: an app's sign-out ends no WebSocket a page already holds.

### Opening beyond loopback

An app reached from other machines opens the cockpit itself, with its own
proof of who the person is:

```js
const cockpit = await createCockpit({
  // …
  authorize: (request) => signedIn(request), // the app's sign-in, e.g. its session cookie
  origins: ['https://app.example'], // where its pages are served from
  terminal: 'loopback', // a shell stays on the machine
});
cockpit.on('error', (failure) => log(failure.where, failure.cause)); // an authorize that threw, a 500
```

A request from another address, or one a proxy forwarded, is served only
when `authorize` resolves `true`; a local request still needs the token.
`authorize: (request) => cockpit.verify(request)` opens it by the link
alone. `authorize` must settle, as the request waits for it and the cockpit
sets no time limit on it; one still pending when the cockpit closes is
answered 503. `authorize` should check a proof the person holds, never a header a
client sets itself, and with a browser's WebSockets it receives no header of
the page's: a cookie of the app's sign-in reaches it. TLS, accounts and
sign-in are the app's. A cockpit opened this way is refused with a Claude
Code driver in `plan`, `auto` or `bypassPermissions`, whose sessions reach
the network without asking, unless the app accepts it with
`claudeCode({ acceptOpenNetwork: true })`.

A sign-in's cookie reaches every port of its host, so a page of any other
server on the machine sends it too. The app's own routes that change
something (signing in or out, renewing the token) refuse a request whose
`Origin`, when it has one, is not exactly one of the app's own, port
included, as `examples/translate-and-access` does.
[Security](security.md#opening-beyond-loopback) has the details.

## Jobs

What an app declares: a named piece of work for the agent. Built so far: a
job's `id`, `title` and `description`; its arguments, a zod 4 schema every
run is checked against (`invalid-arguments`); its `key`, which names the
unit of work from the arguments (`[a-z0-9-]+`); and its `prompt`, built from
the arguments, or none for a job the person types into; and its driver
part. The agent runs in the app's folder. Option sources and a job's own
folder come later, and are refused until then.

A job's driver part changes, for its own sessions, what the driver's
options set for every session. For Claude Code, `claudeCode.job(…)` builds
it, with a mode, rules and a model:

```js
const cockpit = await createCockpit({
  // …
  driver: claudeCode({ permissionMode: 'default', permissions: { deny: ['Bash(git push:*)'] } }),
  jobs: [
    {
      id: 'review',
      title: 'Review a change',
      args: z.object({ pr: z.number().int().positive() }),
      key: ({ pr }) => `review-${pr}`,
      prompt: ({ pr }) => `Review pull request #${pr}.`,
      driver: claudeCode.job({ permissionMode: 'plan', model: 'opus' }),
    },
  ],
});
```

The part's mode and model replace the driver's; its rules are added after
the driver's, so the app's deny and ask rules always hold. The plugin, the
sources of settings, the sandbox and the acceptance of an open network stay
the app's. A part that does not fit is refused with `invalid-options`, at
`createCockpit` and again when the job runs. A part whose mode opens the
network (`plan`, `auto`, `bypassPermissions`) is refused in a cockpit
opened beyond loopback, as the driver's own mode would be, unless the
driver accepts it (`acceptOpenNetwork`).

## Units of work

What a job's run works on, named by a key, and how one conversation stays
with it.

## Sessions and their five states

The agent running for a unit of work, in its own tmux session, and its
state: `starting` (the agent is launching), `busy` (it works on a turn),
`idle` (it waits for a prompt; `lastMessage` is the last turn's answer,
`error` why it failed when it ended on an error of the model's API, and
`backgroundTasks` the tasks the agent still runs in the background),
`waiting` (it waits for a person) and `ended` (no agent runs; `reason` says
why, `canResume` whether its conversation is still kept). Each state carries
`since`, when it began. A turn the person interrupts in the terminal ends
`idle`; a background task's work never makes the session `busy`, but the
turn the agent starts itself when a task finishes does; a compaction begun
while `idle` is `busy`, then the same `idle` again, its `since` kept. `cockpit.sessions.follow` and the client's
`sessions.follow` give the whole list at once, then at every change.

So far a session is `waiting` only for something in the terminal
(`pending: [{ kind: 'terminal', dialog? }]`): a start-up dialog the agent
shows before it takes a first prompt (`trust-folder`,
`bypass-permissions`, `onboarding`, `login`), a dialog it shows that the
driver has no name for, or a panel a launch prompt opened (`/help`). The
person answers it in the mounted terminal, and the session goes on. A
person who leaves a start-up dialog ("No", or Esc) ends the session
`declined`, with its `dialog`: the app tells them what the next launch will
meet again.

## Run, send and open

Starting or resuming a session with a job, sending it a prompt, and opening
it with none. Built so far: a run on a key with no session, which launches
the agent with the job's prompt and resolves once the session leaves
`starting`: `busy`; `idle` for a job without a prompt, or one the agent
takes without a turn (a local command such as `/clear`); `waiting` at a
start-up dialog; `ended` when the agent was gone first. A launch is refused
when the agent is missing (`agent-not-found`), older than the driver was
tested on (`agent-too-old`), or cannot be sandboxed as the app asked
(`sandbox-unavailable`), and ended with `unobservable` when the agent
neither reports nor shows a dialog in time. A run on a key
that has a session is refused with `wrong-state`; the
[API reference](api.md#operations) lists what else is refused for now.

## Interrupt, end and remove

Stopping a turn, ending a session, and removing a unit of work.

## Asks

What the agent asks a person — a question, a plan, a permission, an input —
and how an app shows and answers it.

## The channel

The typed messages an app declares between its pages and the agent: notices
and requests.

## The activity stream

What a session did, as a stream an app can follow live and read back.

## The one-shot call

A single call to the model, outside any session.

## The terminal

The agent's real terminal, mounted in the app's page. `mountTerminal(element,
key, { baseUrl })` puts an xterm.js terminal of the cockpit's own in the
app's element, fits it to the element and follows its size, and attaches it
to the session. The app owns the element, its size and how the status
shows; the cockpit owns the rest: reconnecting after a drop, the keys the
agent needs (for Claude Code, Shift+Enter types a new line), and copying.
Text the session copies — the agent's own selection, tmux's — reaches the
person's clipboard; a selection of the terminal's own, made with Shift+drag
(Option+drag on macOS), is copied by Ctrl+C, which then sends nothing to the
agent. `dispose()` removes the terminal; the session goes on. Once the
session has ended there is nothing to attach to: the status is `ended`.
`terminal.on('error', handler)` tells why it could not connect (`no-token`,
`refused` with its `cause`, `unreachable`); refused by the app's `terminal`
switch (`terminal-off`), it stays `closed` and stops trying.

## The Claude Code driver

`claudeCode(options?)` is the driver an app gives `createCockpit`. It
launches `claude` from the server's `PATH` in a tmux session, with settings
of its own: the hooks that report to the cockpit, the app's rules, and the
lines that keep the agent from the cockpit's files, the app's port and
every Claude Code settings file ([security](security.md#keeping-the-agent-out)).
The person's own Claude Code settings still load below them, unless the app
narrows them. Its options ([reference](api.md#claudecodeoptions)):

- `permissionMode` and `permissions`: the mode every session runs in
  (`default` unless the app says), and the rules it writes above the
  person's and the project's. A job's driver part may change them for its
  sessions.
- `model`: the model of every session, else the person's default.
- `pluginDir`: the app's own Claude Code plugin, for its sessions only.
- `settingSources` and `otherMcpServers: false`: fewer of the person's and
  the project's settings, and none of their MCP servers.
- `acceptOpenNetwork`: needed with a mode whose network is open, in a
  cockpit opened beyond loopback ([security](security.md#each-modes-network)).
- `sandbox`: the agent's sandbox, below.

### The sandbox

The agent's sandbox confines the commands it runs: their files and their
network. The person may turn it on in their own settings; an app that
needs it gives `claudeCode({ sandbox: true })`, or the sandbox's
exceptions (`{ excludedCommands, allowUnsandboxedCommands }`). The option
only turns the sandbox on: left out, the person's settings decide, and
`false` is refused. A session the app asked to sandbox never runs
unsandboxed: a launch where the sandbox's programs are missing (`bwrap`
and `socat`, on Linux) is refused with `sandbox-unavailable`, whose `cause`
says what to install, and an agent that finds the sandbox unavailable in
any other way stops before it takes the prompt (the session ends `lost`).
[Machines](machines.md#the-agents-sandbox) says what a machine needs.

### Versions

Each driver is tested on a range of the agent's versions.
`cockpit.status()` gives the version last read, whether it was tested, and
the range. Before each launch the driver reads the version of the agent
the launch would run: a missing agent is refused with `agent-not-found`,
one older than the range with `agent-too-old`; a newer one runs, and
`cockpit.on('untested-version', handler)` tells the app once per version,
so that it can warn the person. [Machines](machines.md#the-agents-tested-range)
gives the range.

### Variables

Each launch starts from the server's environment. The app names its
secrets in `createCockpit({ hiddenEnv })`, and no agent gets them; the
driver removes Claude Code's own variables, which a server started from a
Claude Code terminal would otherwise pass on.

## Errors

Every failure the cockpit reports is a `CockpitError`: one class, with a
kebab-case `code` that tells the failures apart and decides the other fields
the error carries, and a `message` in English for logs and developers.
`isCockpitError(value, code?)` tells one from any other thrown value. The
server and the browser client use the same class, codes and fields. The codes
are listed in the [API reference](api.md#errors). A call of the client
rejects with the error the server raised, rebuilt with its code and fields;
`unreachable` when the server cannot be reached. Why one of the client's live
streams cannot connect goes to `client.on('error', handler)`, once per failed
attempt, while the stream goes on trying. A handler of the app's that
throws, there or on a terminal, stops neither the other handlers nor the
reconnecting: what it threw goes to `console.error`.

On the server, a failure the cockpit cannot tell a page of — its handler's
own 500, an `authorize` that threw, the agent-facing listener's 500 — goes
to `cockpit.on('error', handler)` as `internal-failure`, with `where` and
the `cause` that was thrown; with no handler, to `console.error`.
