# Jobs console

A small app on Fastify that mounts the cockpit under `/cockpit`, offers one
job ("Explain a file"), and serves a page that runs it, follows the sessions
and their states live, and shows a session's terminal.

- `server.js` — the app: the cockpit, its job, the Fastify server, the page's files.
- `page/` — the page: plain HTML and JavaScript. The browser loads the
  package's `client` and `terminal` entries, as built, and xterm.js's ESM
  build through an import map; the app serves exactly those files. No bundler.
- `scripted-agent.js` — the default agent: the Claude Code this repository
  pins, against a scripted fake of Anthropic's API (no model, no login, no
  network). Every question gets the same scripted answer. It is development
  support, not part of the package.

The end-to-end test (`test/e2e/jobs-console.test.ts`) follows these steps in
a browser.

## Start it

From the repository's folder, with Node 22.18 or later, tmux 3.2a or later,
and the development install:

```sh
pnpm install
pnpm build                              # the example imports the built package
node examples/jobs-console/server.js    # --port <n> for another port than 4310
```

It prints where the scripted agent keeps its files, then the link:

```
The scripted agent: the pinned Claude Code against a fake API, in /tmp/jobs-console-AbC123.
Open http://127.0.0.1:4310/#cockpit=…
```

## Steps

1. **Open the link** in a browser on this machine. The page shows
   "Following the sessions." and "No sessions yet". The address bar no longer
   holds `#cockpit=…`: the page keeps the token in its own storage.
2. **Run the job**: type `README.md` in _File_, press _Run_. The page says
   "Started a session on README.md: it is busy." A row `explain-readme-md`
   appears; within a few seconds its state is `idle`, _States seen_ reads
   `starting → busy → idle`, and _Last answer_ begins "This is the scripted
   answer of the fake API".
3. **Open its terminal**: press _Terminal_ on the row. Below the table, the
   session's terminal shows Claude Code's own screen, `(open)` beside its
   name: the prompt you ran and the scripted answer. Type in it — another
   question gets the same answer, and the row goes `busy`, then `idle` again.
4. **Run it again on the same file**: the page says the session already
   exists (`wrong-state`). This version runs a job only on a file with no
   session; another file name gets a session of its own.
5. **Reload the page** (no link needed): the sessions come back, and the
   terminal of the session you chose (its key is in the address, `?session=…`)
   reconnects and shows the same screen.
6. **Stop the server** with Ctrl+C. It prints "Stopped.", ends the sessions
   and their tmux server, stops the fake API and removes its folder. The
   page says the server cannot be reached and keeps trying; the terminal
   shows `(closed)`, then `(connecting)` as it retries.

## With your own agent

```sh
node examples/jobs-console/server.js --real
```

The sessions run the `claude` of your `PATH`, with your login, in the folder
you started the server from: **every run is a real model call**. That folder
must be trusted by Claude Code first (run `claude` in it once and accept);
this version does not answer start-up dialogs. Its files are in
`~/.local/state/agent-cockpit/jobs-console/`, and the link stays the same
from one start to the next.

When the server stops, the sessions go on in tmux, by design. Until a later
version adopts them, a run on a file whose session an earlier start left is
refused. To end them all:

```sh
tmux -L agent-cockpit-jobs-console kill-server
```

Or attach to one, to see it: `tmux -L agent-cockpit-jobs-console attach -t <key>`.
