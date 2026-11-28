# Asks on the page

A small app on Fastify that mounts the cockpit under `/cockpit`, offers two
jobs whose agent asks a permission, and serves a page that shows every ask
of the agent's and answers it, with no terminal in the page: Allow, Allow
for the session, or Deny with a message. An ask only a person in the
session's terminal can answer shows where to answer it, and every ask
settled since the page opened shows what settled it: the app, the terminal,
or neither (`cancelled`).

- `server.js` — the app: the cockpit, the Fastify server, the page's files.
  It prints the link to open and the command that reaches a session's
  terminal.
- `jobs.js` — the jobs. Each has the agent create an empty file with
  `` `touch <file>` ``, a command it asks permission for, and each is one
  session whatever the file (a run on an idle session sends it the next
  prompt):
  - **Create a file** (key `create`): in the agent's default mode, where
    the cockpit holds the agent's permission request and offers it to the
    app as an ask; the first answer, the page's or the terminal's, wins.
  - **Create a file in plan mode** (key `plan`): behind an API that does
    not pass the agent's server-side safety check (the scripted one here),
    plan mode asks in the terminal alone; the cockpit learns of it and
    lists it as an ask the app cannot answer (`answerable: 'terminal'`).
- `page/` — the page: plain HTML and JavaScript. `page.js` runs the jobs,
  follows the sessions (`sessions-table.js`) and the asks of every session
  (`client.asks.follow('*', …)`, `client.asks.on('settled', …)`).
  `asks-list.js` draws each ask by its kind: a kind is one entry of its
  `KINDS` table (its title, content, one-line summary and answers), so
  another kind of ask (a question, a plan to approve) is one more entry;
  the list itself knows none. The browser loads the package's `client`
  entry, as built, through an import map; the app serves exactly those
  files. No bundler, no xterm.js.
- The default agent is the repository's `test/support/scripted-agent.ts`:
  the Claude Code this repository pins, against a scripted fake of
  Anthropic's API (no model, no login, no network). A prompt that asks for
  `` `touch <file>` `` gets a call of `Bash` with that command, then, once
  the call ran or was refused, says which. It is development support, not
  part of the package: an app runs the person's own `claude`.

The end-to-end test (`test/e2e/asks-on-page.test.ts`) follows steps 2 and 4
in a browser, with its own keys in the session's terminal;
`test/e2e/examples-end.test.ts` checks that it leaves nothing behind however
it ends.

## Start it

From the repository's folder, with Node 22.18 or later, tmux 3.2a or later,
and the development install:

```sh
pnpm install
pnpm build                              # the example imports the built package
node examples/asks-on-page/server.js    # --port <n> for another port than 4330
```

It prints where the scripted agent keeps its files, how to reach a
session's terminal, then the link:

```
The scripted agent: the pinned Claude Code against a fake API, in /tmp/cockpit-real-agent-AbC123.
A session's terminal: TMUX_TMPDIR=/tmp/cockpit-real-agent-AbC123/tmux tmux -L agent-cockpit-asks-on-page attach -t <key>
Open http://127.0.0.1:4330/#cockpit=…
```

## Steps

1. **Open the link** in a browser on this machine. The page says
   "Following the sessions and their asks.", "No sessions yet", "Nothing
   asked." and "None settled since the page opened." The address bar no
   longer holds `#cockpit=…`.
2. **Allow**: leave _File_ at `hello.txt` and press _Create it_. The page
   says `create on hello.txt: started → busy.` The session `create` shows
   `waiting`, for "an ask, below", and under _Pending asks_ the ask shows:
   `create — Permission to run Bash`, its tool (`Bash`), its input as the
   agent gave it (`{ "command": "touch hello.txt", "description": "Create
   the empty file hello.txt" }`), its description, when it was asked, and
   its answers. Press _Allow_: the ask moves to _Settled asks_, `settled
   by app (answered by the app)`; the session goes `idle`, its last answer
   "Done: the command ran." The file is in the scripted agent's work
   folder.
3. **Deny with a message**: set _File_ to `secret.txt` and press _Create
   it_: `sent → busy`, the same session, and a new ask. Type `Not this
   file.` in its _Message_ and press _Deny_: settled by `app`, and the
   session's last answer is "The command was not run. The refusal said:
   Not this file." (the agent gave the model your message). _Deny_ with no
   message refuses with the agent's own words.
4. **Answer in the terminal**: set _File_ to `typed.txt` and press _Create
   it_. In another terminal, run the command the server printed, with
   `create` for `<key>`: Claude Code's own screen shows the same ask, "Do
   you want to proceed?", its first option `Yes` selected. Press Enter. On
   the page the ask moves to _Settled asks_, `settled by terminal
   (answered in the terminal)`, its buttons gone with it, and the session
   goes `idle`: the first answer wins. Close that terminal's window to
   leave it (the cockpit's
   sessions have no tmux prefix key, so no key detaches): the session goes
   on.
5. **Allow for the session**: set _File_ to `one.txt`, press _Create it_,
   then _Allow for the session_ on its ask: settled by `app`, `idle`. Set
   _File_ to `two.txt` and press _Create it_ again: this time no ask
   shows; the session goes `busy`, then `idle`, "Done: the command ran." The
   session remembers `touch` commands until it ends: one program's
   commands, never more (a command that is not one simple command is
   remembered as that exact command).
6. **An ask the page cannot answer**: set _File_ to `planned.txt` and press
   _Create it in plan mode_: a second session, `plan`, starts in plan mode.
   It stays `busy` for several seconds: the agent asks in its terminal
   alone, and tells the cockpit only by a notification, about 6.5 seconds
   after its dialog shows. Then the session shows `waiting`, for "a person
   in its terminal", and its ask shows the same tool, input and
   description, with no buttons: "Answer in the terminal of plan: the
   server printed how to reach it." Run the printed command with `plan`
   for `<key>`: the dialog says "Auto mode can't check actions in this
   session, so this one needs your approval", its first option `No`
   selected. Press Down, then Enter, for `Yes`: settled by `terminal`, and
   the session goes `idle`, "Done: the command ran."
7. **Cancelled**: press _Create it in plan mode_ again, on `later.txt`, and
   wait for its ask. In the session's terminal, press Esc: the agent stops
   the turn, and the ask is settled by `cancelled` (its turn or its
   session ended first): nobody answered it.
8. **Reload the page** (no link needed) while an ask is pending (run step 6
   again on another file): the pending ask comes back as it was; _Settled
   asks_ starts empty, since it lists what this page saw settled.
9. **Stop the server** with Ctrl+C (or close its terminal). It prints
   "Stopped.", ends the sessions and their tmux server, stops the fake API
   and removes its folder. The page says the server cannot be reached and
   keeps trying.

## With your own agent

```sh
node examples/asks-on-page/server.js --real
```

The sessions run the `claude` of your `PATH`, with your login, in the folder
you started the server from: **every run is a real model call**, and a file
you allow is created in that folder. The model decides what it runs: it is
asked for exactly `` `touch <file>` ``, and the ask shows what it actually
asked for. In plan mode behind Anthropic's API the model may not run the
command at all, planning instead, so step 6 may show no ask. That folder
must be trusted by Claude Code first (run `claude` in it once and accept);
this version does not answer start-up dialogs. The server prints
`tmux -L agent-cockpit-asks-on-page attach -t <key>` for a session's
terminal.

When the server stops, the sessions go on in tmux, by design, and an ask
still pending can be answered only in the terminal. To end them all:

```sh
tmux -L agent-cockpit-asks-on-page kill-server
```
