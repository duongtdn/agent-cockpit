# Guide

The concepts an app meets when it uses `@duongtdn/agent-cockpit`. For the
exact names and types, read the [API reference](api.md).

**Status:** built so far: a cockpit mounted in the app's server, the units
of work (a job run in every state of its key's session, sending, opening,
starting over, interrupting, ending and removing, their records, the cap
on live sessions, the idle timeout, a launcher form from the jobs'
descriptions and choices), the sessions followed live, a
session's terminal in the page, access (the app's own API routes, opening
beyond loopback, and renewing the token), and the Claude Code driver: its
options, a job's driver part, the sandbox and the agent's version. The sections after "Getting started" are
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
page's WebSockets, which would hold the server open. It refuses new calls
first, before it waits for anything, and kills nothing: the sessions go on
in tmux, a call still waiting for its key's turn is rejected and never
runs, and nothing is ended or killed, and no record written, after
`close()`.

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
terminal.on('status', (status) => showStatus(status)); // 'connecting' | 'open' | 'held' | 'closed' | 'ended'
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
Code driver in `acceptEdits`, `plan`, `auto` or `bypassPermissions`, whose
sessions reach the network or write files without asking, unless the app
accepts it with `claudeCode({ acceptOpenNetwork: true })`.

A sign-in's cookie reaches every port of its host, so a page of any other
server on the machine sends it too. The app's own routes that change
something (signing in or out, renewing the token) refuse a request whose
`Origin`, when it has one, is not exactly one of the app's own, port
included, as `examples/translate-and-access` does.
[Security](security.md#opening-beyond-loopback) has the details.

## Jobs

What an app declares: a named piece of work for the agent. A job has an
`id`, a `title` and a `description`; its arguments, a zod 4 object schema
every run is checked against (`invalid-arguments`), each field's `label`
and `hint` given as its metadata (`.meta({ label, hint })`); its `key`,
which names the unit of work from the arguments (`[a-z0-9-]+`, 100
characters at most, else the run is refused `invalid-options`: a key names
a tmux session and a folder and a file of the state folder; the sample
below gives every name a key of its own, a long one cut and hashed); its
`prompt`, built from the arguments, or none for a job the person types
into; and, each optional:

- `options`: a field's choices from the app's data, by field. A source is
  a function of the arguments filled so far (sync or async), so one
  field's choices may depend on another's; it returns `{ value, label? }`
  choices. A run's value must be one of them (`not-a-choice`), unless the
  source is given as `{ choices, suggestions: true }`: then they are only
  suggestions, and any value fits.
- `directory(args)`: the folder the agent works in, relative to the app's
  folder and inside it (`folder-outside-app` otherwise, every link
  followed), made when missing. Without it, the app's folder. A unit of
  work keeps the folder of its first start: a later run whose job gives
  another is refused (`folder-changed`), unless it starts a new
  conversation.
- `fresh: true`: a run that finds the key's session `ended` starts a new
  conversation rather than resuming it.
- `driver`: the job's driver part, below.

```js
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

// A key from a name: lower-case letters and digits as they are, any other
// character as its code point in hex between two `-` (`src/a.js` gives
// `src-2f-a-2e-js`), so that two names never share a key; past 100
// characters, cut, and ended with `--` and a hash of the name.
function keyOf(prefix, name) {
  const part = [...name]
    .map((c) => (/[a-z0-9]/.test(c) ? c : `-${c.codePointAt(0).toString(16)}-`))
    .join('');
  const key = `${prefix}${part}`;
  if (key.length <= 100) return key;
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 16);
  return `${key.slice(0, 82)}--${hash}`;
}

// The app's data: its folders, and the files of one of them. The folder a
// page gives is checked first: a source must not list what lies elsewhere.
async function namesIn(folder, isWanted) {
  const entries = await readdir(folder, { withFileTypes: true });
  return entries.filter(isWanted).map((entry) => ({ value: entry.name }));
}
const listFolders = () => namesIn('.', (entry) => entry.isDirectory());
async function listFiles(folder) {
  const folders = await listFolders();
  if (!folders.some((choice) => choice.value === folder)) return [];
  return namesIn(folder, (entry) => entry.isFile());
}

const cockpit = await createCockpit({
  // …
  jobs: [
    {
      id: 'explain',
      title: 'Explain a file',
      args: z.object({
        folder: z.string().meta({ label: 'Folder' }),
        file: z.string().meta({ label: 'File', hint: 'One of the folder’s files.' }),
      }),
      options: {
        folder: () => listFolders(), // [{ value: 'src' }, { value: 'notes' }]
        file: ({ folder }) => listFiles(folder), // depends on the folder chosen
      },
      key: ({ folder, file }) => keyOf('file-', join(folder, file)),
      prompt: ({ folder, file }) => `Explain the file ${folder}/${file}.`,
    },
    {
      id: 'work',
      title: 'Work in a folder',
      args: z.object({ folder: z.string().meta({ label: 'Folder' }) }),
      options: { folder: { choices: () => listFolders(), suggestions: true } },
      key: ({ folder }) => keyOf('folder-', folder),
      directory: ({ folder }) => folder, // no prompt: the person types in the terminal
    },
  ],
});
```

A page draws its launcher from the jobs, never from a copy of their
schemas: `client.jobs()` gives each job's id, title, description, its
schema as JSON Schema (the input it takes, each field's `label` and `hint`
on the field), `options` naming each field with a source (`'choices'` or
`'suggestions'`) and `hasPrompt`; never its key, prompt, folder, `fresh` or
driver part, which stay on the server. `client.options(jobId, field,
argsSoFar)` reads a field's choices, given what the form holds so far (the
source sees it checked against the schema made partial); a page reads a
field's choices again when a field it depends on changes.

```js
const [job] = await client.jobs();
for (const [name, field] of Object.entries(job.schema.properties)) {
  addField(name, field.label ?? name, field.hint, job.options[name]); // a select for 'choices', a datalist for 'suggestions'
}
const folders = await client.options('explain', 'folder', {});
const files = await client.options('explain', 'file', { folder: 'src' });
const result = await client.run('explain', { folder: 'src', file: 'greet.js' });
```

`createCockpit` checks each job (`invalid-options`): its `args` an object
schema JSON Schema can describe, each source for one of its fields,
`directory` a function, `fresh` `true`.

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
sources of settings, the sandbox and the acceptance of an open mode stay
the app's. A part that does not fit is refused with `invalid-options`, at
`createCockpit` and again when the job runs. A part whose mode is open
(`acceptEdits`, `plan`, `auto`, `bypassPermissions`) is refused in a cockpit
opened beyond loopback, as the driver's own mode would be, unless the
driver accepts it (`acceptOpenNetwork`).

## Units of work

What a job's run works on, named by a key, and how one conversation stays
with it. Runs whose arguments give one key share a unit of work, whichever
job they are of: drafting a chapter and revising it, explaining a file and
reviewing it. The agent keeps its context across them.

The cockpit keeps a record per key in its state folder, until the app
removes it: the conversation a resume takes up, the earlier ones (left by a
fresh start, a conversation the agent no longer kept, or the agent's own
move, such as Claude Code's `/clear`), its folder, the settings its session
was launched with, and the history of its runs and opens — each with its
job, arguments as the run was given them (never what the schema made of
them), time, what it did (`started`, `resumed`, `sent`), why, and
the conversation it acted in. A send is not in the history. Every listed
session carries its `record`. A restarted server lists every recorded key,
`ended` (`lost`) when no session of it lives, ready to be resumed.

`createCockpit({ maxSessions })` caps the live sessions: at the cap a
launch ends the `idle` session idle longest that has no background task, no
terminal attached and no call of its key under way (`ended`,
`session-cap`), else is refused `session-cap-reached`. Off by default.

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
while `idle` is `busy`, then the same `idle` again, its `since` kept, also
when it fails or the person interrupts it (the agent's conversation tells
the interruption, since no hook does). A conversation the agent moves to (Claude Code's `/clear` starts one
under a new id) is the one the session follows from then on, and the one
an ended session's `canResume` tells of, and a resume will take up. `cockpit.sessions.follow` and the client's
`sessions.follow` give the whole list at once, then at every change.

So far a session is `waiting` only for something in the terminal
(`pending: [{ kind: 'terminal', dialog? }]`): a start-up dialog the agent
shows before it takes a first prompt (`trust-folder`,
`bypass-permissions`, `onboarding`, `login`), a dialog it shows that the
driver has no name for, or a panel a launch prompt opened (`/help`,
`/cost`, `/status`, `/config`, `/model`, or one the driver has no name
for, shown 5 seconds after the agent started). The
person answers it in the mounted terminal, and the session goes on. A
named panel's close makes the session `idle`; one the driver has no name
for leaves it `waiting` until the agent's next hook or transcript entry,
never guessed `idle` from the input box alone. A
person who leaves a start-up dialog ("No", or Esc) ends the session
`declined`, with its `dialog`: the app tells them what the next launch will
meet again.

## Run, send and open

Starting or resuming a session with a job, sending it a prompt, and opening
it with none.

- **Run** (`run(jobId, args, { fresh? })`) acts by the state of its key's
  session: with no record it starts the agent with the prompt; on `ended`
  it resumes the conversation with the prompt (or starts a new one for a
  `fresh` job, or when the agent no longer keeps it, `conversation-gone`:
  the page tells the person the agent does not remember); on `idle` it
  types the prompt (`sent`), restarting the session first, conversation
  kept, when the run's settings differ from those it was launched with
  (another job of the key, or the job changed: `settings-changed`); while
  the session is `starting`, `busy` or `waiting` it is refused
  (`wrong-state`). A job without a prompt has nothing to send to a live
  session (`nothing-to-send`).
- **Send** (`send(key, prompt)`) continues a unit of work with a prompt of
  the app's or the person's: typed into an `idle` session, its settings
  kept; an `ended` one is resumed with the prompt and the settings of the
  key's last run. A send never begins a unit of work (`unknown-key`).
- **Open** (`open(key, { fresh? })`) resumes an `ended` unit of work with
  no prompt, for the person to type in the terminal: no turn spent. A live
  session, or a key with no record, has nothing to open
  (`nothing-to-open`). Mounting a terminal never opens a session.
- **Fresh** (`{ fresh: true }` on a run or an open) starts over: a new
  conversation for the key, with the job's prompt or with none. A live
  session is ended first (the result lists the background tasks it
  stopped); the earlier conversation stays in the record.

An open or a send to an `ended` session takes the key's last run again —
its job as the app defines it now, with the recorded arguments — and makes
every check of a run again: a job gone is `unknown-job`. Calls on one key
run one at a time, each on the state the one before left; nothing waits
for a session to become `idle`. A launch resolves once the session leaves
`starting`: `busy`; `idle` for a job without a prompt, or one the agent
takes without a turn (a local command such as `/clear`); `waiting` at a
start-up dialog; `ended` when the agent was gone first. A launch is refused
when the agent is missing or cannot be run (`agent-not-found`), older than
the driver was tested on (`agent-too-old`), or cannot be sandboxed as the
app asked (`sandbox-unavailable`), and ended with `unobservable` when the
agent neither reports nor shows a dialog in time.

A prompt holds more than whitespace (`invalid-arguments` otherwise) and at
most 100,000 characters (`prompt-too-long`). A prompt typed
into a session keeps what the person left in its input box: the half-typed
draft is put back after, and the page's terminal holds the person's keys
meanwhile. Should anything but the box show up while it types (a turn the
agent began by itself, a dialog), the send stops (`wrong-state`); the draft
is put back while the box still shows, else the error's message says where
it is and which keys bring it back. A person browsing the prompt history in
the box (Up recalled a past prompt) is not typed over: the send is refused
(`wrong-state`), nothing typed. A first prompt too long for the agent's
command line is typed the same way once the agent has started, the
page's terminals held from its start: the session stays `starting` until
the agent takes it, and the run settles then. A start-up dialog shown
first makes the session `waiting`; the prompt is typed once the person
answered it, and the run stays pending until then, but holds up nothing
else: the calls on the key act on the `waiting` session meanwhile (a send
refused `wrong-state`, a `fresh` run ends it, the pending run settling
`ended`), and the session's state tells what became of the prompt (`busy`
when the agent took it, `idle` when not). The keys the person typed
before the dialog showed are dropped, never typed, as they were aimed at
the input box, not at the dialog. A session the cockpit is
ending to make room under the cap takes no send or run (`wrong-state`).
The [API
reference](api.md#units-of-work) has the tables.

## Interrupt, end and remove

Stopping a turn, ending a session, and removing a unit of work: what a
page's Stop, End and Remove buttons call (`interrupt(key)`, `end(key)`,
`remove(key)`, on the server's cockpit and the browser's client alike).
Each takes its place among its key's calls, after those asked before it,
as run, send and open do: a Stop clicked while a send types waits for the
send, then stops the turn it began. None of them fails for nothing to
do: each says so in its result, with the session's state, so that a
button clicked just as the turn ended, or twice, is no error. Each is
refused on a `starting` session (`wrong-state`): the agent has not yet
taken its first prompt.

| State                     | Interrupt                       | End                                         | Remove                                          |
| ------------------------- | ------------------------------- | ------------------------------------------- | ----------------------------------------------- |
| `busy`                    | The turn stopped: `interrupted` | The turn stopped first, then ended: `ended` | Ended as `end` ends it, then removed: `removed` |
| `waiting` in the terminal | `nothing-to-interrupt`, no key  | Ended, no key: `ended`                      | Ended, then removed: `removed`                  |
| `idle`                    | `nothing-to-interrupt`          | Ended: `ended`                              | Ended, then removed: `removed`                  |
| `ended`                   | `nothing-to-interrupt`          | `nothing-to-end`                            | Removed: `removed`                              |
| no record                 | `nothing-to-interrupt`          | `nothing-to-end`                            | `nothing-to-remove` (when no session either)    |
| `starting`                | `wrong-state`                   | `wrong-state`                               | `wrong-state`                                   |

Asks and channel requests, still to come, will make a session `waiting`
whose turn Stop and End stop as on `busy`.

**Stop** (`interrupt`) does what the person's Esc does in the terminal:
it stops the agent's turn, and resolves once the session is `idle` again,
confirmed by the driver, never guessed (`interrupted`; a turn may have
begun since, which the sessions' list tells). For Claude Code that is one
Esc, never a second, whatever follows: two would open the agent's rewind
menu. The answer written so far stays in the conversation, marked as
interrupted, and the next prompt carries on from it. When the session is
not seen `idle` within the driver's bound (5 seconds for Claude Code), the
call rejects `interrupt-unconfirmed` with the last state known, nothing
more pressed: the page shows the state the list gives and lets the person
try again or end the session. A session `waiting` in the terminal (a
start-up dialog, a panel, a screen the driver cannot read) runs no turn,
and a key there could answer a dialog nobody saw: Stop presses nothing and
resolves `nothing-to-interrupt` with the state, which tells the page that
a person must act in the terminal. The agent's background tasks go on;
the `idle` session lists them (a shell or a monitor the stopped turn
started is listed only once a later turn ends).

**The withdrawn prompt.** An Esc that lands before the agent began on a
prompt (the model has not answered yet) does not interrupt: the agent
takes the prompt back into its input box, out of the conversation, as if
it had not been sent. No hook tells it; the cockpit reads it on the
agent's screen (the box holding exactly the prompt, no sign of work
above it) and the session is `idle`. After the cockpit's own Stop it then
clears the prompt from the box, the page's terminals held meanwhile, since
the person asked to stop; an Esc a person presses in the terminal while
that Stop waits cannot be told from the cockpit's, and its prompt is
cleared too. An Esc a person presses at any other time leaves the prompt
in the box, theirs to edit or send. Over a draft in the box the same Esc
interrupts instead, and the draft is kept as it was: the cockpit never
clears a box that holds anything but the prompt.

**End** (`end`) stops the agent's process: the session is `ended`
(`reason: 'app'`), and keeps its conversation and record, which the next
run, send or open resumes. On a `busy` session the turn is stopped first,
as Stop stops it, so that the answer written so far stays in the
conversation, then the process is ended whether or not that was
confirmed: the person asked to end it. A prompt that Esc withdraws (it
landed before the agent began) is left in the box, out of the
conversation: no key is pressed once an end was asked but that one Esc. An `idle` session, or one
waiting in the terminal, is ended at once, no key pressed: an End clicked
behind a start-up dialog nobody answers closes it, and its `reason` is
`app`, not `declined`. For Claude Code the process is sent SIGTERM; one
still there after 5 seconds has its tmux session killed, then whatever of
its process group is left. The call resolves once the process is gone,
with the background tasks that stopped with it (`stoppedTasks`, empty when
none ran): an `idle` session lists them beforehand in `backgroundTasks`,
so a page that wants the person to confirm stopping them asks before it
calls `end`. A session the cockpit is ending already (the cap, a restart,
the idle timeout) has that end awaited, and its reason stays.

**Remove** (`remove`) ends a live session as End does, then deletes
everything the cockpit wrote for the key (its record, the session's
folder with its settings and hook token) and forgets the key: it leaves
the sessions' list, followers are told, and its next run starts a new
conversation. It resolves `removed`, with the background tasks it stopped
when it ended a session. The agent's own transcripts are left where the
agent keeps them: they are the person's, who may still resume them in
their own terminal. A key listed with no record (a first launch that
failed) is removed as any other; one with neither a record nor a session
has `nothing-to-remove`. The cockpit expires no record by itself: Remove
is how an app lets a unit of work go.

**Failures.** A session that outlives the bound and cannot be killed is
left live: `end` and `remove` reject with the machine's error, which is no
`CockpitError` (a 500 with no body on the wire, which the client reports
as `unreachable`; `internal-failure` to `cockpit.on('error')`), and a later
End may kill it. A remove that fails, there or deleting a file, keeps the
key's record, so the key stays listed and a Remove clicked again finishes:
a page shows the failure and lets the person click again.

**Idle sessions end by themselves.** A session left `idle` for the app's
`idleTimeout` (30 minutes by default; `false` turns it off) is ended as
End ends it, with `reason: 'idle-timeout'`, so that agents nobody uses do
not pile up; the next run resumes the conversation after a start of a
second or two. The time counts from when the session became `idle`; a
turn, and each new `idle`, starts it again. Three things hold a session:
a background task running, a terminal attached (a page's mounted terminal
or a person's own `tmux attach`), and a call of the app's under way on its
key. A session held when its time is up is not ended then: it is checked
again one timeout later, and again after each check that finds it held,
then ended at the first check that finds it `idle` and held by nothing. So
a reload of the page never ends a session, and a session whose terminal
closed lives on for up to one more timeout; an app that wants it gone
sooner calls `end`. Once its end has begun, a prompt sent meanwhile is
refused (`wrong-state`), and an End or a Remove joins it, the reason kept.
An idle end that fails is written to `console.error` and tried again one
timeout later.

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

The server sends a terminal what the session draws as it comes, the pieces
that arrive together joined into one message. A page that stops reading (a
tab the browser froze, a sleeping laptop, a dead connection) is let go once
the server holds 4 MiB of output for it: its socket is closed with `4001`
and the terminal reconnects at once (`connecting`, then `open`), the screen
drawn anew; the lines that scrolled past meanwhile are missing from its
scrollback. The session and its other terminals go on untouched.

While the cockpit types a prompt into a session (a send, a run into an
`idle` session, a long first prompt), every page terminal attached to it is
`held`: what the person types is kept by the server, not typed into the
app's prompt, and reaches the session once the send is over, however it ended — in the order typed, each key as it was
sent, so that the agent reads typing, not a paste; the status is then
`open` again. One exception: while a long first prompt waits for the input
box, a start-up dialog in its place drops the keys kept, so that they
answer no dialog the person had not seen; the status is `open` again and
the keys typed from then on reach the dialog (the terminal does not yet
tell the person that keys were dropped). A long prompt takes a while to type (about 25 seconds for
100,000 characters), so a page shows the status. Resizing still applies.
A terminal closed during the send drops what it kept, and one that keeps
over a megabyte of keys is closed (it reconnects, held). A person's own
`tmux attach` to the session is not held.

## The Claude Code driver

`claudeCode(options?)` is the driver an app gives `createCockpit`. It
launches `claude` from the server's `PATH` in a tmux session, with settings
of its own: the hooks that report to the cockpit, the app's rules, and the
lines that keep the agent from the cockpit's files, the app's port and
the files the cockpit can name that start code at its next launch: its
settings, its configuration files and `.mcp.json`, the hooks' scripts,
agents and skills of a `.claude` folder, the person's plugins, agents and
skills ([security](security.md#keeping-the-agent-out)). In `acceptEdits`
(inside the work folder), `auto` and `bypassPermissions` the agent's file
tools write unasked and act as the person: those denies are defense in
depth, not a boundary.
The person's own Claude Code settings still load below them, unless the app
narrows them. One of theirs gives way in every session: the input box's
editor is the standard one (`editorMode: "normal"`), so a person who uses
vim mode does not have it in the cockpit's sessions — in vim's NORMAL mode,
which the screen does not show, a prompt the cockpit types would run as
vim's commands. Its options ([reference](api.md#claudecodeoptions)):

- `permissionMode` and `permissions`: the mode every session runs in
  (`default` unless the app says), and the rules it writes above the
  person's and the project's. A job's driver part may change them for its
  sessions.
- `model`: the model of every session, else the person's default.
- `pluginDir`: the app's own Claude Code plugin, for its sessions only.
- `settingSources` and `otherMcpServers: false`: fewer of the person's and
  the project's settings, and none of their MCP servers.
- `acceptOpenNetwork`: needed with an open mode (its network, or its file
  tools' unasked writes), in a cockpit opened beyond loopback
  ([security](security.md#each-modes-network-and-writes)).
- `sandbox`: the agent's sandbox, below.

### The sandbox

The agent's sandbox confines the commands it runs: their files and their
network. The person may turn it on in their own settings; an app that
needs it gives `claudeCode({ sandbox: true })`, or the sandbox's
exceptions (`{ excludedCommands, allowUnsandboxedCommands }`). The option
only turns the sandbox on: left out, the person's settings decide, and
`false` is refused. A session the app asked to sandbox never runs
unsandboxed: a launch where the sandbox's programs are missing (`bwrap`
and `socat`, on Linux), or where `bwrap` cannot make the nested namespace
the sandbox needs (an AppArmor-confined one, probed once), is refused with
`sandbox-unavailable`, whose `cause` says what to install or allow, and an
agent that finds the sandbox unavailable in any other way stops before it
takes the prompt (the session ends `lost`).
[Machines](machines.md#the-agents-sandbox) says what a machine needs.

### Versions

Each driver is tested on a range of the agent's versions.
`cockpit.status()` gives the version last read, whether it was tested, and
the range. Before each launch the driver reads the version of the agent
the launch would run: a missing agent, or one that fails, hangs (10
seconds) or prints no version to `--version`, is refused with
`agent-not-found`, one older than the range with `agent-too-old`; a newer
one, or a build with a suffix (`2.1.340-beta`), runs, and
`cockpit.on('untested-version', handler)` tells the app once per version,
so that it can warn the person. [Machines](machines.md#the-agents-tested-range)
gives the range.

### Variables

Each launch starts from the server's environment. The app names its
secrets in `createCockpit({ hiddenEnv })`, and no agent gets them, nor the
app's tmux server; the driver removes Claude Code's own variables, which a
server started from a Claude Code terminal would otherwise pass on. Hiding
is hygiene, not a boundary: a process of the app's user, the agent among
them, can read the server's own environment
([security](security.md#the-variables-an-app-hides)). A `CLAUDE_CONFIG_DIR`
or a `HOME` that is relative, or whose path holds a character a permission
rule reads as its own, is refused with `invalid-options`: the rules that
keep the agent from its own configuration could miss it.

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
