# Jobs console

A small app on Fastify that mounts the cockpit under `/cockpit`, offers four
jobs, and serves a page that draws a launcher form for each job from what the
cockpit says of it, follows the sessions and their records live, runs, sends,
opens and starts afresh, stops a turn, ends a session, removes a unit of
work, and shows a session's terminal.

- `server.js` — the app: the cockpit, the Fastify server, the page's files.
- `jobs.js` — the jobs, each showing one thing a job can be:
  - **Explain a file**: a _Folder_, then a _File_ among that folder's files
    (dependent choices), and a _Detail_ (an `enum` with a default). Its key
    names the file: `file-src-2f-greet-2e-js`. A key keeps lower-case
    letters and digits and writes any other character as its code point in
    hex between two `-` (`/` is `-2f-`, `.` is `-2e-`): it reads back to the
    name, so two files never share a key, where a slug would merge
    `a-b.js` with `a.b.js`, `README.md` with `readme.md`, or the app's folder
    (`.`) with a folder named `app`. A key holds 100 characters at most: a
    longer name's is cut and ends with `--` and 16 hex digits of the name's
    hash. Copy `keyPart` and `keyOf` from `jobs.js` for your own keys.
  - **Review a file**: the same fields and the same key, in plan mode (a job
    part, `claudeCode.job({ permissionMode: 'plan' })`): on a session Explain
    started, it restarts it with plan mode, its conversation resumed.
  - **Work in a folder**: no prompt; the agent starts in the folder chosen
    (the job's `directory`), for you to type in its terminal.
  - **Ask anything**: a _Topic_ with suggestions (any topic is taken) and a
    _Question_.
- `page/` — the page: plain HTML and JavaScript. `launcher.js` draws a form
  from any job's JSON Schema (`client.jobs()`: labels, hints, types,
  required fields, defaults) and reads a field's choices with
  `client.options(…)`, again whenever a field before it changes: a select
  for choices, a datalist for suggestions. `sessions-list.js` shows a card
  per session, with its buttons: _Stop_ while a turn runs (`busy` or
  `waiting`), _End_ while the session is live, _Remove_ always, after a
  confirmation in the card; `results.js` says what an operation did. The
  browser loads the package's `client` and `terminal` entries, as built,
  and xterm.js's ESM build through an import map; the app serves exactly
  those files. No bundler.
- `sample-project/` — what the scripted agent works in: a copy of it is made
  at each start, so that the forms have folders and files to offer.
- The default agent is the repository's `test/support/scripted-agent.ts`:
  the Claude Code this repository pins, against a scripted fake of
  Anthropic's API (no model, no login, no network). Every question gets the
  same scripted answer, at once, except one that asks for a thorough answer
  (_Detail_ `thorough`): its answer is long and written a few words at a
  time, for about 40 seconds, a turn at work long enough to stop. Each
  launch passes the contract suite's guard first (a settings file, a file
  of MCP servers, a variable that could take the agent elsewhere stops
  it). It is development support, not part of the package: an app runs
  the person's own `claude`.

Every operation's result shows the cockpit's own words, then what they mean:
`action · reason → state: …`, such as
`resumed · settings-changed → busy: the session was restarted with this
job's settings, its conversation resumed.` An error shows the cockpit's
message (a `wrong-state` says where your draft went when a send had to
leave it aside, and which keys bring it back), or the field each issue of
`invalid-arguments` is in: `topic: Name a topic: at least one letter or
digit.` What a remove did shows above the cards, its card gone.

The end-to-end tests (`test/e2e/jobs-console.test.ts`) follow these steps in
a browser; `test/e2e/examples-end.test.ts` checks that it leaves
nothing behind however it ends.

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
The scripted agent: the pinned Claude Code against a fake API, in /tmp/cockpit-real-agent-AbC123.
Open http://127.0.0.1:4310/#cockpit=…
```

## Steps

1. **Open the link** in a browser on this machine. The page shows
   "Following the sessions.", "No sessions yet", and a launcher for each of
   the four jobs. The address bar no longer holds `#cockpit=…`: the page
   keeps the token in its own storage.
2. **Choose, and see the choices follow**: in _Explain a file_, _Folder_
   offers "The app’s folder", `notes` and `src`; _File_ offers nothing until
   a folder is chosen. Choose `notes`: _File_ offers `ideas.md` and
   `todo.md`. Choose `src`: it offers `farewell.js` and `greet.js`, and a
   file chosen before is cleared. _Detail_ shows `brief`, its default.
3. **Run it**: choose `greet.js`, press _Run_. The launcher says
   `started → busy: a new session started.` A card `file-src-2f-greet-2e-js`
   appears; within a few seconds its state is `idle`, _States seen_ reads
   `starting → busy → idle`, its last answer begins "This is the scripted
   answer of the fake API", and _History (1)_ holds
   `run of explain {"folder":"src","file":"greet.js","detail":"brief"}: started`.
4. **Run it again** on the same file once it is `idle`: `sent → busy: the
   session took the prompt.`, and the card goes `busy`, then `idle`;
   _History (2)_ adds `run of explain …: sent`.
5. **Review the same file**: in _Review a file_, choose `src` and `greet.js`,
   press _Run_: `resumed · settings-changed → busy`. The session was ended
   (_States seen_ shows `ended · restarted`) and launched again in plan mode,
   in the same conversation; the history has `run of review …: resumed ·
   settings-changed`.
6. **Keep a draft through a send**: press _Terminal_ on the card. Below the
   cards, the session's terminal shows Claude Code's own screen, `(open)`
   beside its name. Click in it and type a draft, `a draft kept aside`,
   without Enter. In the card's prompt box, type `Summarize it in one line.`
   and press _Send_. The terminal says `(held)` while the cockpit types; the
   draft leaves the input box, the prompt is typed and taken, and the draft
   comes back. The card says `sent → busy`, and goes `idle` with the answer;
   the prompt box is empty. Send another prompt, and while the terminal
   says `(held)` type in it: nothing shows until it says `(open)` again,
   then your keys arrive after the draft, in the order you typed them.
7. **Open a session the agent left**: in the terminal, clear the draft
   (Ctrl+U) and type `/exit`, then Enter. The card goes `ended · agent-exit`
   and the terminal `(ended)`. Press _Open_: `resumed → idle: the
   conversation was resumed.`, and the history has `open of review …:
   resumed` (an open takes the settings of the last run). Press _Terminal_
   to see it again.
8. **Start afresh**: press _Open fresh_ on the card: `started ·
   fresh-on-request → idle`. The live session was ended first; the card's
   last line names the new conversation and, before it, the old one. Or, in
   _Explain a file_, check _Start a fresh conversation_ and run on the same
   file: a new conversation with the job's prompt; the box is unchecked
   again after the run.
9. **Work in a folder**: in _Work in a folder_, choose `notes`, press _Run_:
   `started → idle` (no prompt: the run resolves once the agent waits at its
   input). Press _Terminal_ on `folder-notes` and type there: the agent
   works in the sample project's `notes`. _Run_ again: `nothing-to-send →
   idle`; press _Open_ on its card: `nothing-to-open → idle: its session is
   live already.`
10. **Ask anything**: _Topic_ suggests `the project`, `the notes` and `the
    code`; type a topic of your own, `the weather`, and a question, and run:
    a session `ask-the-20-weather` starts. A suggestion only suggests. Ask
    about `the-weather`: another session, `ask-the-2d-weather`, starts. A
    topic with no letter or digit, `?!`, is refused: `topic: Name a topic:
    at least one letter or digit.`
11. **Stop a turn**: in _Explain a file_, choose `notes`, `ideas.md` and
    _Detail_ `thorough`, press _Run_: `started → busy`. The card
    `file-notes-2f-ideas-2e-md` is `busy` and shows _Stop_; press
    _Terminal_ on it to watch the answer written, part by part. Press
    _Stop_ while it writes: the card says `Stopping the turn of …`, then
    `interrupted → idle: the turn was stopped; …`. The card goes `idle`
    and _Stop_ leaves it; the terminal shows the answer cut short, then
    `Interrupted · What should Claude do instead?`, its input box empty.
    A Stop that comes as the turn ends is no error: `nothing-to-interrupt
    → idle: no turn was running.`
12. **End the session**: press _End_ on the same card: `ended: the session
    ended; its conversation and record are kept for the next run or open.`
    The card goes `ended · app` (the app closed it, not the agent) and
    _End_ leaves it; the terminal says `(ended)`. Press _Open_: its
    conversation is resumed (`resumed → idle`), and _End_ is back.
13. **Remove the unit of work**: press _Remove_ on the card. The card asks
    first: "Remove file-notes-2f-ideas-2e-md? Its session ends if it is
    live, and its record and history are deleted; the agent’s transcripts
    are kept." When the session runs background tasks, it names those it
    would stop. Press _Keep it_, and nothing changes; press _Remove_ again,
    then _Remove for good_. The card leaves the list, and above the cards
    the page says `file-notes-2f-ideas-2e-md — removed: its record and
    history are deleted, …`. Run _Explain_ on `notes/ideas.md` again,
    _Detail_ `brief`: it starts a new conversation (`started`), with a
    history of one run. A session still `starting` cannot be ended or
    removed yet: the card says so in the cockpit's words, `The session …
    is starting.`
14. **The cap**: stop the server and start it with `--max-sessions 2`. Run
    _Explain_ on `src/greet.js`, then on `src/farewell.js`, and let both go
    `idle` with no terminal shown (press _Terminal_ on neither, or reload
    the page without `?session=…`). Run it on `notes/todo.md`: the session
    `idle` the longest, `file-src-2f-greet-2e-js`, is ended (`ended ·
    session-cap`) and the new one starts. A session shown in a terminal is
    not ended for another: press _Terminal_ on `file-src-2f-farewell-2e-js`,
    then run on `notes/ideas.md`: `file-notes-2f-todo-2e-md` is ended, not
    it. When no
    live session can be ended (each busy, or shown in a terminal), a start is
    refused, the cap and the live keys named.
15. **Reload the page** (no link needed): the cards and their histories come
    back, and the terminal of the session you chose (its key is in the
    address, `?session=…`) reconnects and shows the same screen. Edit the
    address to `?session=Not a key`: the terminal's place says "The terminal
    needs a session key."
16. **Stop the server** with Ctrl+C (or close its terminal). It prints
    "Stopped.", ends the sessions and their tmux server, stops the fake API
    and removes its folder, the records with it; one that cannot start (its
    port taken) removes them too. The page says the server cannot be reached
    and keeps trying; the terminal shows `(closed)`, then `(connecting)` as
    it retries.

## With your own agent

```sh
node examples/jobs-console/server.js --real
```

The sessions run the `claude` of your `PATH`, with your login, in the folder
you started the server from: **every run is a real model call**. The forms
offer that folder's own folders and files (hidden ones, `node_modules`,
`dist` and `coverage` left out). That folder must be trusted by Claude Code
first (run `claude` in it once and accept); this version does not answer
start-up dialogs. Its files are in `~/.local/state/agent-cockpit/jobs-console/`,
and the link stays the same from one start to the next. The records are kept
there too: after a restart the cards come back, `ended`, with their
histories.

When the server stops, the sessions go on in tmux, by design. Until a later
version adopts them, a run, an open or a send on a key whose session an
earlier start left is refused. To end them all:

```sh
tmux -L agent-cockpit-jobs-console kill-server
```

Or attach to one, to see it: `tmux -L agent-cockpit-jobs-console attach -t <key>`.
