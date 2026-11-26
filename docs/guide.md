# Guide

The concepts an app meets when it uses `@duongtdn/agent-cockpit`. For the
exact names and types, read the [API reference](api.md).

**Status:** the first path is built: a cockpit mounted in the app's server,
a job run on a key with no session, the sessions followed live, a
session's terminal in the page, and access: the app's own API routes,
opening beyond loopback, and renewing the token. The sections after "Getting started" are
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
the arguments, or none for a job the person types into. The agent runs in
the app's folder. Option sources, a job's own folder and its driver part
come later, and are refused until then.

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
`sessions.follow` give the whole list at once, then at every change. The
cockpit does not yet tell `waiting`.

## Run, send and open

Starting or resuming a session with a job, sending it a prompt, and opening
it with none. Built so far: a run on a key with no session, which launches
the agent with the job's prompt and resolves once the session leaves
`starting` (`busy`, or `idle` for a job without a prompt). A run on a key
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
