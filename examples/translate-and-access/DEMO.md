# Translate and access

A small app on Fastify that shows who may reach its cockpit, and how:

- **On this machine**, a page proves itself with the app's token, which
  only the link printed in the server's terminal carries. The app's own API
  (`/api/whoami`, `/api/renew-token`) checks the same token:
  the page sends `cockpitHeaders()`, the app calls `cockpit.verify`. The
  pages themselves are served to anyone: a navigation carries no header.
- **From the network**, the cockpit refuses every page (`remote`), and every
  request a proxy forwarded (`forwarded`), unless the app opens it. With
  `--open`, the app gives the cockpit an `authorize` that checks the app's
  own sign-in: a page of the network signs in with a password the server
  prints, and gets a cookie (a browser sends it on WebSocket handshakes too,
  where a page can set no header). `origins` lists the machine's network
  addresses at the app's port, and any `--origin` you add.
- **The terminal** is a shell on this machine: `terminal: 'loopback'` keeps
  it from every page of the network, opened or not (`terminal-off`).
- **Renewing the token** (a button on the page): the old link stops working
  at once, every open page's WebSockets are closed, and the server prints
  the new link.
- What fails inside the cockpit (a bare 500, an `authorize` that throws)
  reaches the app through `cockpit.on('error')`, which prints it.

One job ("Say hello") gives it sessions to follow and a terminal to keep
local. The other half of the example, a translation through the app's own
route with a one-shot call, comes with the version of the cockpit that
adds one-shot calls.

- `server.js` — the app: the cockpit and its access options, the app's API
  and sign-in, the Fastify server, the page's files.
- `page/` — the page: plain HTML and JavaScript, the package's `client` and
  `terminal` entries loaded as built through an import map. No bundler.
- The default agent is the repository's `test/support/scripted-agent.ts`:
  the Claude Code this repository pins, against a scripted fake of
  Anthropic's API (no model, no login, no network), each launch checked by
  the contract suite's guard. It is development support, not part of the
  package.

The end-to-end tests (`test/e2e/translate-and-access.test.ts`) follow these
steps in a browser, a page of the network included; `test/e2e/examples-end.test.ts`
checks that it leaves nothing behind however it ends.

## Start it

From the repository's folder, with Node 22.18 or later, tmux 3.2a or later,
and the development install:

```sh
pnpm install
pnpm build                                     # the example imports the built package
node examples/translate-and-access/server.js   # --port <n> for another port than 4320
```

It prints where the scripted agent keeps its files, then the link:

```
The scripted agent: the pinned Claude Code against a fake API, in /tmp/cockpit-real-agent-AbC123.
Open http://127.0.0.1:4320/#cockpit=…
```

## Steps

1. **Open the link** in a browser on this machine. The page shows
   "Following the sessions." and "No sessions yet". The address bar no
   longer holds `#cockpit=…`: the page keeps the token in its own storage.
2. **The app's own API knows the page**: _Access_ reads "The app's API
   knows this page by the app's token, from 127.0.0.1." The page asked
   `/api/whoami` with `cockpitHeaders()`. Press _Call the API without the
   token_: "Without the token's header, the app's API answered 401."
3. **Say hello**: type `Ada` in _Name_, press _Say hello_. A row
   `hello-ada` appears; within a few seconds it is `idle`, with the
   scripted answer. Press
   _Terminal_ on it: the session's terminal opens below, `(open)`.
4. **A request a proxy forwarded is remote**, even with the token. In
   another terminal, with the token from the link:

   ```sh
   curl -i -H 'cockpit-token: <token>' -H 'X-Forwarded-For: 203.0.113.7' \
     http://127.0.0.1:4320/cockpit/sessions
   ```

   It answers `403`, `"code":"refused"`, `"cause":"forwarded"`. Without the
   `X-Forwarded-For` line it answers the sessions; without the token,
   `401` and `no-token`.
5. **A page of the network is refused.** Stop the server (Ctrl+C) and
   start it listening on every address, not opened:

   ```sh
   node examples/translate-and-access/server.js --host 0.0.0.0
   ```

   It prints, before the link, where the network reaches it —
   `From the network: http://192.168.1.20:4320/`, one line per address of
   the machine — and "Not opened (--open): the cockpit refuses every page
   of the network." Open that address from another device on the same
   network (a phone on the same Wi-Fi), or from this machine's own browser:
   a request to the machine's network address does not come from the
   loopback, so the app sees it as from the network. The page shows "The
   cockpit refused this page (refused · remote)." and "The app's API refused
   this page (401)." A sign-in form appears; any password gets "The app was
   started without --open". Under WSL2 the address printed is the Linux
   side's: another device reaches it only once Windows forwards a port to
   it; this machine's own browser reaches it as it is.
6. **Open it with `--open`.** Stop the server and start it again:

   ```sh
   node examples/translate-and-access/server.js --open
   ```

   It listens on every address and prints a password: `Password for a page
   of the network: …`, new at every start. Open the network address again
   (the page of step 5, reloaded). It is still refused (`remote`) until you
   sign in: a wrong password gets "That is not the password the app
   printed."; the right one reloads the page, which now shows "Following
   the sessions." and "The app's API knows this page by its sign-in, from
   <its address>." The page can say hello and sees the sessions. Press
   _Terminal_ on a row: "The terminal stays on the app's machine (refused ·
   terminal-off).", and the terminal `(closed)`; it does not retry. On
   this machine, open the link this start printed in a new tab (the
   scripted agent's state, the token in it, is new at every start): there
   the same _Terminal_ opens.

   A name for this machine (`http://my-box.local:4320`) is refused
   (`host`) until you add it: `--origin http://my-box.local:4320`.
   The password and the cookie travel in clear over plain HTTP; an app
   that opens itself to a network serves TLS, which is the app's to set up.
7. **Renew the token**: on the page on `127.0.0.1`, press _Renew the
   token_. It says "Renewed: every page needs the new link, printed in the
   server's terminal.", and the server prints "Renewed the token: every
   page needs the new link." and the new `Open …` line. The page's
   WebSockets were closed: it now says "This page has no valid token: open
   the link the server printed.", its terminal too. The old link gets the
   same. Open the new link in a new tab: it works, and within a few
   seconds the page you renewed from follows the sessions again by itself
   (a page reads the token its origin keeps at each try). A link pasted
   into a tab that already shows the page changes only what follows `#`,
   which does not reload it: reload it then. The page of the network,
   signed in, goes on: its proof is the app's sign-in, not the token.
8. **Stop the server** with Ctrl+C (or close its terminal). It prints
   "Stopped.", ends the sessions and their tmux server, stops the fake API
   and removes its folder; one that cannot start (its port taken) removes
   them too.

## With your own agent

```sh
node examples/translate-and-access/server.js --real
```

The sessions run the `claude` of your `PATH`, with your login, in the
folder you started the server from: **every hello is a real model call**.
That folder must be trusted by Claude Code first (run `claude` in it once
and accept). Its files are in `~/.local/state/agent-cockpit/translate-and-access/`,
and the link stays the same from one start to the next, until you renew it.
With `--open`, the sessions run in Claude Code's `default` permission mode,
the one whose network the cockpit keeps to its allow-list; the cockpit
refuses to open itself to the network with a driver in a mode that reaches
further, unless the app accepts it in the driver's options.

When the server stops, the sessions go on in tmux, by design. To end them
all:

```sh
tmux -L agent-cockpit-translate-and-access kill-server
```
