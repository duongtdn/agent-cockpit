# Security

What the cockpit defends, against whom, and what is left to the app.

**Status:** the request checks, the link's token, the driver's permission
rules and the terminal's clipboard are built. Opening beyond loopback and
keeping the agent away from the cockpit's own files are not built yet: the
sections that say so describe this version as it is.

## Whom the cockpit defends against

The cockpit runs sessions on a person's own machine, for that person. It
keeps out:

- other machines: everything from beyond the loopback is refused;
- pages of other sites open in the person's browser: refused by their
  `Origin` and, against DNS rebinding, by the `Host` they name;
- other users of the machine, and the person's other local servers and
  programs that do not hold the link: refused without the app's token.

It does not defend against another process of the person's own account,
which can do whatever the person can (see the last section).

## The loopback-only default

The cockpit serves the browser on the app's own server, and checks every
request and WebSocket upgrade it is given itself, whatever address the app
listens on. It refuses, with `refused` and its `cause`:

- a request from beyond the loopback (`remote`): only `127.0.0.0/8` and
  `::1` are local;
- a request that carries `Forwarded`, `X-Forwarded-For` or `X-Real-IP`
  (`forwarded`): a proxy or a tunnel on the machine forwarded it, so it is
  remote, whatever address it comes from;
- a request that reaches a local address other than `127.0.0.1` or `::1`
  (`local-address`), so another `127.x` address does not reach an app that
  listens on every address;
- a request whose `Host` is not `127.0.0.1` or `localhost`, any port
  (`host`): this is what stops DNS rebinding, where a page of another site
  points its own name at the loopback;
- a request whose `Origin`, when it has one, is not `http:` or `https:` on
  `127.0.0.1` or `localhost`, any port (`origin`): another site's page.

A page served at `http://[::1]:…` is refused (`host`); use `127.0.0.1` or
`localhost`. A proxy that adds no forwarding header (nginx as shipped, a raw
TCP tunnel) makes its requests local: they still need the token. A refused
request is answered 403, and a refused WebSocket handshake has its socket
ended.

## The link's token

Loopback is not proof that the caller is the person's browser: any process
on the machine, another user's included, can reach a loopback port. So every
request also carries the app's token, or is refused with `no-token`
(answered 401).

- The token is 256 random bits, made at the app's first start and kept in
  the cockpit's state folder, readable by the app's user alone; it stays the
  same from one start to the next.
- The state folder is the cockpit's own, and is kept private, so that no
  other user can read the token or plant one they know. A folder that
  exists must be the user's and is narrowed to the user alone; a symbolic
  link, a file in its place or another user's folder is refused
  (`invalid-options`). Nothing in it is followed: each file the cockpit
  reads there (the token, the lock's id, the agent-facing port) must be a
  regular file of the user's, or the start is refused the same way. A
  token's file others had rights on is replaced by a new token, since the
  old one may have been read; the other files are narrowed to the user.
- The folders above the state folder are checked too, as OpenSSH's
  `StrictModes` does, before any is created: from the root down, a symbolic
  link judged by its own owner and then by the path it leads to, each must
  be the user's or root's; writable by others only with the sticky bit (as
  `/tmp`); writable by its group only with the sticky bit, or when the group
  is the user's private one (the user's primary group, named after the
  user, with no other member in `/etc/group`; a group `/etc/group` does not
  list, as from LDAP, is refused). Otherwise another user could rename the
  state folder away and put a folder of theirs in its place, with a
  session's settings whose hooks run commands as the person; the start is
  refused (`invalid-options`) and nothing is created. The missing folders
  above it are then created with rights `0755`, whatever the umask.
- On WSL2, a folder of the Windows drives (`/mnt/c/…`) shows rights `0777`
  without the sticky bit, so a state folder there is refused: keep it on
  the Linux file system (the default, under `~/.local/state`, is).
- The lock's name is made from an id in the state folder. A start never
  replaces that id (a second process doing so while the first holds the
  lock would run two cockpits), so an id others could read is narrowed but
  kept. If another user then holds the lock's name, every start fails with
  `cockpit-locked` and `holder: 'another-user'`; the remedy, which the
  error's message says too: stop the app's servers, delete
  `<state folder>/lock-id`, and start again.
- `cockpit.link(pageUrl)` puts it in the page's link, in the fragment
  (`#cockpit=…`), which a browser never sends to a server.
- The client and the terminal take it from the fragment, remove it from the
  address bar (so a bookmark, a screenshot or a shared address never holds
  it) and keep it in the origin's local storage, so a reload or another tab
  needs no link. Storage is kept per origin, port included: another app on
  the same host keeps its own.
- They send it in the `cockpit-token` header of every request and, on a
  WebSocket, as a subprotocol; never in a URL, where logs and the browser's
  history would keep it. It is not a cookie: a cookie for `127.0.0.1` would
  reach every local server, whatever its port.
- The server compares it in constant time.

Whoever holds the link holds the cockpit: the app prints it, or hands it to
the browser it opens, and nothing else.

## Opening beyond loopback

Not possible in this version: there is no option to open the cockpit to
other machines, and every request from beyond the loopback is refused. A
person who works from another machine reaches the app through their own
tunnel, which arrives as loopback (and so needs the link) as long as it adds
no forwarding header.

## The rules an app writes: deny and ask

How an app tightens what the agent may do. `claudeCode({ permissionMode,
permissions })` writes the app's rules (`allow`, `ask`, `deny`, as Claude
Code's settings write them) into every session's settings, above the
person's and the project's, and always passes the permission mode
(`'default'` when the app gives none), so the person's own default mode
never applies by accident. Claude Code weighs deny, then ask, then allow:
an app's allow never lifts a deny or an ask of the person's, the project's
or a managed policy, and the app's deny holds whatever they allow.

## The agent's sandbox

What the agent can reach on the machine while it works. In this version the
cockpit adds nothing to confine the agent: a session runs with the person's
own settings and sandbox, the app's permission rules and mode on top. The
agent's tools are not yet kept away from the cockpit's state folder, which
holds the app's token and the sessions' tokens: an agent allowed to read
any file can read them. Each session's hook token is written only in its
files there, never on a command line or in the environment.

## The clipboard

A mounted terminal lets what runs in the session write the person's
clipboard: the agent, tmux, and any program the agent runs there can put
text in it through the terminal's OSC 52 sequence, as in any terminal that
allows it. Nothing can read it that way: a request to read the clipboard
(`?`) is never answered. The browser may refuse the write (a page out of
focus, a policy); the cockpit then drops it. A person who pastes into
another program what they did not copy should know that the session may
have put it there.

## What stays out of reach

What the cockpit does not protect against, so that an app can decide what it
must do itself:

- another process of the app's user, which can read the state folder, and
  so the token;
- an agent free to run any code outside a sandbox, which can do the same;
- what the app's own routes serve: the cockpit checks only the requests it
  is given.
