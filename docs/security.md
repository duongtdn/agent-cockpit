# Security

What the cockpit defends, against whom, and what is left to the app.

**Status:** everything this document describes is built: the request checks
and the app's opening beyond loopback, the link's token and its renewal, the
agent-facing listener, the lines that keep the agent away from the
cockpit's own files, the app's port and the files it can name that would
start code at the agent's next launch, the sandbox an app asks for, the variables an app hides, the state
folder's trust, and the terminal's clipboard. Each limit is stated where it applies, and the last
section gathers them.

## Whom the cockpit defends against

A page that drives a coding agent can do what the agent can do. The
terminal is a shell on the machine. Running a job, and later sending a
prompt or answering an ask, is a shell by another route: one "allow" lets
the agent run a command. Following the sessions shows the content of the
work. The cockpit guards all of them alike.

It runs sessions on a person's own machine, for that person. It keeps out:

- other machines: everything from beyond the loopback is refused, unless
  the app opens the cockpit with its own `authorize`;
- pages of other sites open in the person's browser: refused by their
  `Origin` and, against DNS rebinding, by the `Host` they name;
- other users of the machine, and the person's other local servers and
  programs that do not hold the link: refused without the app's token;
- the agent itself, within what its permission rules and its sandbox
  allow: the cockpit writes into every session the lines that keep it from
  the cockpit's files, the app's port and the files it can name that would
  start code at its next launch (see "Keeping the agent out").

It does not defend against another process of the person's own account,
which can do whatever the person can, nor against an agent left free to run
any code outside a sandbox, nor, in a mode whose file tools write unasked
(`acceptEdits` inside the work folder, `auto`, `bypassPermissions`),
against the agent's own file tools, which act as the person there (see the
last section).

## The loopback default

The cockpit serves the browser on the app's own server, and checks every
request and WebSocket upgrade it is given itself, whatever address the app
listens on: an app that listens on every address by mistake still gets a
cockpit that refuses the network. A request is **local** when it comes from
`127.0.0.0/8` or `::1` and carries no forwarding header; otherwise it is
**remote**. Without `authorize`, the checks refuse, with `refused` and its
`cause`:

- `remote`: a request from beyond the loopback;
- `forwarded`: a request that carries `Forwarded`, `X-Forwarded-For` or
  `X-Real-IP`, whatever address it comes from: a proxy or a tunnel on the
  machine forwarded it, so it is remote;
- `local-address`: a local request that reaches a local address other than
  `127.0.0.1` or `::1`, so another `127.x` address does not reach an app
  that listens on every address;
- `host`: a request whose `Host` is not `127.0.0.1` or `localhost`, any
  port (nor one of the app's `origins`). This is what stops DNS rebinding,
  where a page of another site points its own name at the loopback;
- `origin`: a request whose `Origin`, when it has one, is not `http:` or
  `https:` on `127.0.0.1` or `localhost`, any port (nor one of the app's
  `origins`): another site's page;
- `terminal-off`: a terminal's request that the app's `terminal` switch
  closes (below), checked once the request is admitted;

and then, with `no-token` (answered 401), a local request that does not
carry the app's token.

A refused request is answered 403, and a refused WebSocket handshake has its
socket ended. A browser cannot read why a handshake was refused, so the
client and the terminal ask the same path over HTTP, which the same checks
refuse the same way, and pass the error to their `on('error')` handlers.

A page served at `http://[::1]:…` is refused (`host`); use `127.0.0.1` or
`localhost`. A person who works from another machine without opening
anything reaches the app through their own tunnel (SSH port forwarding),
which arrives as loopback and so needs the link, as long as it adds no
forwarding header.

## Opening beyond loopback

An app opens the cockpit to other machines with two options of
`createCockpit`:

- `authorize: (request) => boolean | Promise<boolean>` is the only way a
  remote request is served: the request passes the `Host` and `Origin`
  checks, then is served when `authorize` resolves exactly `true`. Anything
  else refuses it with its own cause (`remote` or `forwarded`); an
  `authorize` that throws or rejects refuses it too, and the failure goes to
  `cockpit.on('error')` as `internal-failure` (`where: 'authorize'`). A
  remote request admitted this way needs no token: `authorize` is its
  proof. A local request never reaches `authorize`: it needs the token.
  `authorize` must settle: the request waits for it, and the cockpit sets
  no time limit on it (bounding it, a lookup that may hang among others, is
  the app's); one still pending when the cockpit closes is answered 503, so
  it holds nothing open. It is asked once a request.
- `origins: ['https://app.example', 'http://10.0.0.5:8765']` lists the
  origins, beyond `127.0.0.1` and `localhost`, that a page may come from
  (`Origin`) and that a request may name (`Host`, the origin's host and
  port). Each is written as a browser sends it: `http:` or `https:`, the
  host in lower case, a port or none, no path. A remote page whose origin is
  not listed is refused (`origin` or `host`), whatever `authorize` says.

`authorize: (request) => cockpit.verify(request)` opens remote access by the
link: whoever holds it reaches the cockpit from anywhere the server is
reached.

What `authorize` checks is the app's proof of who the person is: a session
cookie of the app's own sign-in, the link's token through `verify`, a client
certificate. It should never trust a header a client can set itself, such
as a user name in `X-User` or `X-Forwarded-User`: any program that reaches
the server sends whatever headers it likes, and a page's script can add its
own to its requests. A header a proxy of the app's sets is worth something
only when that proxy removes the one the client sent. A browser sets no
header of a page's on a WebSocket handshake; it does send the page's
cookies, so a cookie (`HttpOnly`, `SameSite=Strict`) is what an app's
sign-in reaches the terminal and the live sessions with. The `Origin` check
keeps another site's pages out, cookie or not.

A cookie is no proof of which page sent it: a browser sends it to every
port of its host, and `SameSite` counts every port of a host as one site,
so a page of any other server on the machine (another user's included)
carries the app's sign-in. The cockpit's own `Origin` check holds for what
it is given; the app's own routes that change something (signing in or
out, renewing the token) are the app's to guard: refuse a request whose
`Origin`, when it has one, is not exactly one of the app's own, port
included, as `examples/translate-and-access` does. Accounts, sign-in and
TLS are the app's: over plain HTTP, a password and a cookie cross the
network in clear.

The terminal has a switch of its own, the `terminal` option:

- `'on'` (the default): the terminal follows the other surfaces;
- `'loopback'`: every remote terminal request is refused (`terminal-off`),
  however the app opened the rest: a shell stays on the machine;
- `'off'`: every terminal request is refused, local ones included.

A mounted terminal refused with `terminal-off` reports it to its
`on('error')` handlers and stops trying: the switch holds until the app
changes it.

A proxy on the machine that adds a forwarding header (most do) makes its
requests remote: they reach `authorize`, and their `Host` and `Origin` must
be the app's (pass the original `Host` on, or list the origin the proxy
serves). A proxy that adds none (nginx as shipped, a raw TCP tunnel) makes
its requests local: they need the token, never reach `authorize`, and the
cockpit cannot tell them from the person's own browser. Configure such a
proxy to add `X-Forwarded-For`.

A cockpit opened beyond loopback is refused with a Claude Code driver in a
mode whose network is open, unless the app accepts it: see "Each mode's
network" below.

## The link's token

Loopback is not proof that the caller is the person's browser: any process
on the machine, another user's included, can reach a loopback port. So every
local request also carries the app's token, or is refused with `no-token`.

- **Made and kept.** The token is 256 random bits, made at the app's first
  start and kept in the cockpit's state folder, readable by the app's user
  alone; it stays the same from one start to the next, until the app renews
  it.
- **The link.** `cockpit.link(pageUrl)` puts it in the page's link, in the
  fragment (`#cockpit=…`), which a browser never sends to a server. Whoever
  holds the link holds the cockpit: the app prints it, or hands it to the
  browser it opens, and nothing else.
- **In the page.** The client and the terminal take it from the fragment,
  remove it from the address bar (so a bookmark, a screenshot or a shared
  address never holds it) and keep it in the origin's local storage, so a
  reload or another tab needs no link. Storage is kept per origin, port
  included: another app on the same host keeps its own. Where the browser
  refuses the page its storage, the token stays in the page's memory. A
  link pasted into a tab that already shows the page changes only the
  fragment, which does not reload it: the page takes its token then
  (`hashchange`), removes it from the address bar as before, and its
  streams and terminals reconnect with it at once. So a window related to
  the tab (its opener, or one it opened) can set `#cockpit=…` and overwrite
  the stored token, cutting the origin's tabs off until the person reopens
  the app's link, as a full-page link to `#cockpit=…` could already do. It
  fixes no session on the person: each app has one token, and a wrong one
  opens nothing.
- **On the wire.** They send it in the `cockpit-token` header of every
  request and, on a WebSocket, as a subprotocol; never in a URL, where logs
  and the browser's history would keep it. It is not a cookie: a cookie for
  `127.0.0.1` would reach every local server, whatever its port. The server
  compares it in constant time.
- **The app's own API routes.** `cockpit.verify(request)` tells whether a
  request carries the token (its header; on a WebSocket handshake, its
  subprotocol), in constant time; it checks no address. In the page,
  `cockpitHeaders()` from `./client` gives the header to add:
  `fetch('/api/whoami', { headers: cockpitHeaders() })`. Guard the app's API
  routes with it, not its pages: a navigation (opening the link, a reload)
  carries no header, so a page guarded by `verify` would never load. A
  route of the app's is the app's to check: the cockpit checks only the
  requests it is given.
- **Renewing it.** `await cockpit.renewToken()` writes a new token to the
  state folder, then puts it in force: the one before is refused at once,
  everywhere, `verify` included. Every browser-facing WebSocket is closed —
  the sessions' followers and every terminal — so that nothing opened with
  the old token stays open; each page that reconnects is checked again and,
  without the new token, is told `no-token`. The person opens the new link,
  which `link` now gives; a page of the same origin that retries then finds
  the new token in the origin's storage. A request or a WebSocket handshake
  whose admission overlapped a renewal is refused with 503 and a body
  that asks for it again, never with an error: it is made again as a new
  request (the client makes a request again once, a second later; its
  streams and terminals reconnect by themselves, reporting nothing),
  checked against the token now in force, and `authorize` is asked once
  for each request, never twice for one. A remote page admitted by `authorize` reconnects as before, unless
  its `authorize` relied on the token. Renewing is the only act that cuts
  every open socket: an app's sign-out, or a sign-in that expires, ends no
  follow or terminal WebSocket already open, since `authorize` is asked
  only when a request or a handshake is admitted; such a socket ends when
  it drops, at a renewal, or when the cockpit closes. Nothing else
  changes: the sessions go on, and their own tokens with them. When the new token cannot be written, `renewToken` rejects with
  the file system's error, the token in force stays, and no socket is
  closed. Renew when the link may have leaked: a screenshot, a shared log,
  a browser profile someone else could read.

## The agent-facing listener

The agent's hooks report to the cockpit on a listener of its own, apart
from the app's server: it binds `127.0.0.1` only, so opening the app to the
network never opens it. Its port is chosen at the first start and kept in
the state folder (`agentPort` fixes it).

- Every request carries a live session's token as `Authorization: Bearer`;
  a request without one is refused 401 before anything else is said, and
  its body is not read.
- A request that looks like a browser's is refused 403 before its token is
  read: one that carries an `Origin` header, whatever its value, or a `Host`
  other than exactly `127.0.0.1:<port>`. The hooks send neither; a page
  sends `Origin` on every cross-origin request, and a page that reaches the
  listener through a name it rebinds to the loopback sends that name as
  `Host`.
- Each session's token is written only in the session's files in the state
  folder, which the agent's tools may not read (below): never on a command
  line or in the environment, where any process of the user could read it.
  The command hook that starts a session is given the path of its file and
  reads it itself.
- A failure while it serves a hook is answered 500 and goes to
  `cockpit.on('error')` as `internal-failure` (`where: 'agent-listener'`).

## Keeping the agent out

The agent runs on the person's machine, with the person's own settings for
it still loaded. The Claude Code driver writes into every session's
settings, whatever the app sets, the lines that keep the agent from the
cockpit's state (the app's token, the sessions' tokens and settings), from
the app's browser-facing server, and from the files it can name that start
code at its next launch (its settings, its configuration files and
`.mcp.json`, the hooks' scripts, agents and skills of a `.claude` folder,
the person's plugins, agents and skills).
The agent's sandbox is on when the person turns it on in their own Claude
Code settings (`"sandbox": { "enabled": true }`), or when the app asks for
it ([below](#the-sandbox-an-app-asks-for)). Without it, the sandbox's lines
change nothing: a session starts and works as it would without them.

The state roots are the cockpit's default one (`agent-cockpit` under
`$XDG_STATE_HOME`, by default `~/.local/state/agent-cockpit`, which holds
every app's state folder) and the app's `stateDirectory` when it names one,
each by the path given and, when it differs, the path the system resolves
it to.

| Line                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Without the sandbox                                                                                                                                                                                                                                                                                                                                                                                                                                        | With the sandbox                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A `Read` deny on each state root                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Keeps out Claude Code's `Read` tool and the file commands it recognizes (`cat`, `grep`). Not code an allowed command runs: a script in Python or Node reads the folder.                                                                                                                                                                                                                                                                                    | Enforced on every process the sandbox runs: the folder's files look absent, in `default` and `bypassPermissions` alike.                                                                                                                                      |
| An `Edit` deny on each state root                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Keeps out the `Write` and `Edit` tools and the shell's plain writes (`echo >`, `cp`, `mv`, `rm`), in `default` and `bypassPermissions` alike, so the agent cannot plant a token or a session's settings there. Not code in another language.                                                                                                                                                                                                               | As without the sandbox.                                                                                                                                                                                                                                      |
| The app's ports denied on every local address and loopback name (`sandbox.network.deniedDomains`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Changes nothing: a command reaches the app's port. It still needs the token, which the denies above keep from Claude Code's own tools.                                                                                                                                                                                                                                                                                                                     | A sandboxed command cannot reach the app's port by `localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]`, `[::]`, their other spellings (`127.1`, `2130706433`, `[::ffff:127.0.0.1]`) or any address of the machine's own, in every mode; other ports are left alone. |
| The agent-facing listener allowed (`sandbox.network.allowedDomains`, `127.0.0.1:<port>`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Changes nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                           | The hooks reach the cockpit; the listener still asks each request for a session's token.                                                                                                                                                                     |
| No command outside the sandbox (`sandbox.allowUnsandboxedCommands: false`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Changes nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                           | A command cannot ask to leave the sandbox, in `bypassPermissions` too, whatever the project's settings say; unless the app's own `sandbox` gives `allowUnsandboxedCommands: true`.                                                                           |
| An `Edit` deny on the files the cockpit can name that start code at the agent's next launch: `.claude/settings.json`, `.claude/settings.local.json` and `.mcp.json` wherever they are, and every file of a `.claude/hooks`, `.claude/agents` or `.claude/skills` folder; the person's own `settings.json`, the legacy `.config.json` and every `.claude*.json` in the agent's configuration folder, every `.claude*.json` in the home, and every file of the person's `plugins`, `agents` and `skills` folders (in the configuration folder), each by its path and its real path | Keeps the `Write` and `Edit` tools and the shell commands Claude Code recognizes from them, in every mode, `bypassPermissions` included. Not code in another language.                                                                                                                                                                                                                                                                                     | As without the sandbox: those tools run in the agent's own process, outside the sandbox.                                                                                                                                                                     |
| `acceptEdits`, `auto`, `bypassPermissions`: the agent's file tools as the person                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Nothing asks before a `Write` or an `Edit` (in `acceptEdits`, inside the work folder; in `auto`, where its check approves): the tools write any file the person can there, but those the denies name. The denies on files that start code are defense in depth, not a boundary: a file the cockpit cannot name (a script a hook, the status line or an MCP server runs, a shell's startup file) still starts code at the next launch, outside the sandbox. | As without the sandbox: those tools run in the agent's own process.                                                                                                                                                                                          |

The app's ports are those its browser-facing server listens on: the
Fastify adapter reads them from the server at each launch; with the neutral
handler the app gives `port` (one or several). A launch while none is known
is refused with `no-app-port`, since its sandbox could not be kept from the
app. The machine's addresses are read at each launch too. A state root
whose path holds a character a permission rule reads as its own (a
pattern's `*`, `?`, `[`, `]`, `{`, `}`; the rule's brackets `(`, `)`; its
escape `\`; a control character) could be missed by its denies:
`createCockpit` refuses it (`invalid-options`). So it is with the agent's
configuration folder and home, which the denies of the person's files
name: a `CLAUDE_CONFIG_DIR` or a `HOME` that is relative (the agent would
resolve it against the folder it runs in, which no rule names) or whose
path, as given or resolved, holds such a character is refused with
`invalid-options` (each issue with an empty path), by `createCockpit` for
the server's environment and again by each launch, which reads it anew.

Another `127.x` address of the app's port is refused by the handler itself
(`local-address`), with the sandbox or without it.

### Files that start code: the agent can never edit those the cockpit names

In a cockpit session the agent cannot edit the files the cockpit can name
that start code at its next launch, even when the person or a job asks it
to: a Claude Code settings file; its configuration file under any of its
names (`.claude.json`, a suffixed `.claude-<name>.json`, in the
configuration folder and in the home) and the legacy `.config.json` of the
configuration folder, which the agent reads in place of `.claude.json` when
it holds anything; any `.mcp.json`; the hooks' scripts, agents and skills
of any `.claude` folder (an agent's or a skill's frontmatter may hold
hooks); and anything in the person's plugins, agents and skills folders.
The person edits them by hand, or in a session of their own outside the
cockpit. The reason: the agent's `Write` and `Edit` tools run in its own
process, not in the sandbox, and each of these files starts code at the
next launch outside the sandbox and outside the permission rules, able to
read the cockpit's state and its tokens: a settings file's or a plugin's
command hook, an MCP server of a configuration file or a `.mcp.json` (a
project's `.mcp.json` runs with no one asked in `bypassPermissions`). The
denies stop such a write in every mode. Code the agent runs outside the
sandbox, in a language whose file access Claude Code does not recognize,
can still write them, as it can the state folder
([what stays open](#what-stays-open)).

These denies are defense in depth, not a boundary. Which files start code
is open-ended: a script that a hook, the status line or an MCP server
runs, wherever it lies; a shell's startup file. No list of denies closes
it. In `default` the agent asks the person before such a write, and in
`dontAsk` it is refused. In `acceptEdits` it writes inside the work folder
unasked — a script there that a project's hook runs (`./scripts/check.sh`)
then runs what the agent wrote, outside the sandbox — so within that
folder **the agent's own file tools act as the person**; in `auto` they
write wherever its check approves, and in `bypassPermissions` nothing asks
at all. There they act as the person, as code the agent runs without the
sandbox does: a person who runs such a mode trusts the agent with their
account, as in their own terminal. Beyond loopback a session in
`acceptEdits`, `auto` or `bypassPermissions` is refused unless the app
accepts it ([each mode's network and writes](#each-modes-network-and-writes)),
so a token valid from afar is never within such a session's reach by
default.

### The sandbox an app asks for

`claudeCode({ sandbox: true })`, or `sandbox: { excludedCommands?,
allowUnsandboxedCommands? }`, runs every session in the agent's sandbox,
whatever the person's settings say. The option only turns the sandbox on:
`sandbox: false` is refused (`invalid-options`), since an app may not take
away a sandbox the person turned on; left out, the person's own settings
decide.

With it, each session's settings carry `sandbox.enabled: true` and
`sandbox.failIfUnavailable: true`. `failIfUnavailable` makes the agent stop,
rather than run its commands unconfined, where the sandbox cannot run: it
reports its start, then exits before it sends the launch prompt or runs a
command, and the session ends (`reason: 'lost'`: nothing tells the cockpit
why). So that this is seldom the way an app learns it, the driver first
looks on the agent's `PATH` for what the sandbox needs (on Linux, `bwrap`
and `socat`), then, on Linux, has `bwrap` make what the agent's sandbox
makes (a user namespace nested in its own: the check of
[machines](machines.md#the-agents-sandbox), bounded to 10 seconds), which
an AppArmor-confined `bwrap` refuses. A launch that fails either is
refused with `sandbox-unavailable`, its `cause` naming what is missing or
what `bwrap` said, and what would fix it; nothing starts. A probe that
passed is kept for that `bwrap` (by its real path) for the driver's life;
one that failed is made again at the next launch. What neither sees is
left to `failIfUnavailable`.

The exceptions loosen the sandbox, and the app answers for them:
`excludedCommands` run outside it, the cockpit's sandbox lines included,
and `allowUnsandboxedCommands: true` lets a command the sandbox refuses run
outside it once the person approves (`false` when left out, as the
cockpit's own line says).

### The variables an app hides

A launch starts from the server's environment, read at that moment.
`createCockpit({ hiddenEnv: ['STRIPE_KEY', …] })` names the app's secrets,
which no session's agent gets; the driver then removes Claude Code's own
(`CLAUDE_CODE_*`, `CLAUDECODE`), so a server started from a Claude Code
terminal hands that session's socket and token to no agent. The app's tmux
server is not given the hidden variables either, and each launch removes
them from the global environment of a server that had them (one another
process started). The `env` of the person's own Claude Code settings still
reaches the agent: those variables are the person's.

This is hygiene, not a boundary: the agent runs as the app's user, and any
process of that user can read the app server's own environment
(`/proc/<pid>/environ`), the hidden variables included, and that of a tmux
server started with them. A secret the agent must never reach is kept out
of the server's environment, not only hidden.

### Each mode's network and writes

The sandbox keeps a sandboxed command's network to an allow-list: the
cockpit's listener, and what the person's own settings allow. What happens
beyond it depends on the permission mode the app launches its sessions in,
as the cockpit's tests measured it, with the sandbox on, on the version of
Claude Code they run ([machines](machines.md#the-agents-tested-range)). The
mode also decides whether the agent's file tools, which run outside the
sandbox, write a file without asking the person:

| Mode                | A reach beyond the allow-list (another local port, another address of the machine's)                                                                                             | The file tools' writes                                 | The session       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------- |
| `default`           | Asked of the person or refused, never reached, whatever the command names                                                                                                        | Asked of the person                                    | Confined          |
| `acceptEdits`       | Asked of the person or refused, never reached, whatever the command names                                                                                                        | Inside the work folder, with no ask                    | Open: its writes  |
| `dontAsk`           | Refused, with no ask                                                                                                                                                             | Refused, with no ask                                   | Confined          |
| `plan`              | Asked; but reached with no ask once the command that names the host in its `allowed_domains` is approved, which `auto`'s own check, run in `plan` too, may do without the person | None: `plan` writes nothing                            | Open: its network |
| `auto`              | Refused; but reached with no ask once the command that names the host in its `allowed_domains` is approved, which `auto`'s own check does without the person                     | Wherever `auto`'s check approves, with no ask          | Open: both        |
| `bypassPermissions` | Reached, with no ask                                                                                                                                                             | Anywhere the cockpit's denies do not name, with no ask | Open: both        |

Stated plainly: a session in `plan`, `auto` or `bypassPermissions` reaches,
without the person being asked, the machine's other local ports (the
person's other servers), the internet, and so the person's files: a
sandboxed command reads every file no deny rule hides — a browser's
profile among them, where the page keeps the app's token — and in an open
mode what it reads can leave the machine. The app's port and the cockpit's
state stay denied in every mode. A session in `acceptEdits`, `auto` or
`bypassPermissions` writes files no one was asked about; a hook that runs
one of them (a project's hook running a script of the work folder) runs it
outside the sandbox, where it reaches what the person's own commands
reach.

On loopback, a token that leaves the machine opens nothing. Opened beyond
loopback, it works from afar, so `createCockpit` refuses `authorize` with a
driver, or a job, in `acceptEdits`, `plan`, `auto` or `bypassPermissions`
(`invalid-options`, its issue on `driver`; its reason says whether the
mode's network or its writes are open, or both), unless the app accepts it:
`claudeCode({ permissionMode: 'acceptEdits', acceptOpenNetwork: true })`.
`default` and `dontAsk` need no acceptance.

### The rules an app writes: deny and ask

How an app tightens what the agent may do. `claudeCode({ permissionMode,
permissions })` writes the app's rules (`allow`, `ask`, `deny`, as Claude
Code's settings write them) into every session's settings, above the
person's and the project's, the cockpit's own denies after the app's, and
always passes the permission mode (`'default'` when the app gives none), so
the person's own default mode never applies by accident. Claude Code weighs
deny, then ask, then allow: an app's allow never lifts a deny or an ask of
the person's, the project's or a managed policy, and the app's deny holds
whatever they allow. An app writes its safety lines as deny or ask rules,
never as "not in the allow list": the person's own allow rules merge in.

## The state folder's trust

The state folder holds the app's token, the sessions' tokens and settings,
the lock's id and the agent-facing port. It is the cockpit's own, and is
kept private, so that no other user can read the token or plant one they
know, nor write a session's settings whose hooks would run commands as the
person.

- `stateDirectory` names the cockpit's own folder, not a parent shared with
  others. A folder that exists must be the user's and is narrowed to the
  user alone; a symbolic link, a file in its place or another user's folder
  is refused (`invalid-options`). One that is missing is created readable
  by the user alone.
- Nothing in it is followed: each file the cockpit reads there (the token,
  the lock's id, the agent-facing port) must be a regular file of the
  user's, or the start is refused the same way. A token's file others had
  rights on is replaced by a new token, since the old one may have been
  read; the other files are narrowed to the user.
- The folders above the state folder are checked too, as OpenSSH's
  `StrictModes` does, before any is created: from the root down, a symbolic
  link judged by its own owner and then by the path it leads to, each must
  be the user's or root's; writable by others only with the sticky bit (as
  `/tmp`); writable by its group only with the sticky bit, or when the group
  is the user's private one (the user's primary group, listed once in
  `/etc/group`, named after the user, with no other member there and no
  other user's primary group in `/etc/passwd`; a group `/etc/group` does
  not list, as from LDAP, is refused). The exception holds only on files
  read whole: if either file cannot be read, or holds a NIS `+` or `-` line
  or a gid that is no number, the group-writable folder is refused, the
  message saying why (comments and blank lines are skipped). A symbolic
  link that leads nowhere, loops, or passes through a file is refused the
  same way. Otherwise another user could rename the state folder away and
  put a folder of theirs in its place; the start is refused
  (`invalid-options`) and nothing is created. The missing folders above it
  are then created with rights `0755`, whatever the umask.
- A state root whose path holds a character a permission rule reads as
  its own is refused (above).
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

## Failures the app is told of

A failure the cockpit cannot tell a page or the agent of goes to
`cockpit.on('error', handler)` as `internal-failure`, with `where` and the
`cause` that was thrown: the handler's own (it answered 500, with no body,
so nothing of the server's inside reaches the wire), an `authorize` that
threw or rejected (the request was refused), and the agent-facing
listener's (it answered 500). While the app has no handler, they go to
`console.error`.

## The clipboard

A mounted terminal lets what runs in the session write the person's
clipboard: the agent, tmux, and any program the agent runs there can put
text in it through the terminal's OSC 52 sequence, as in any terminal that
allows it. Nothing can read it that way: a request to read the clipboard
(`?`) is never answered. The browser may refuse the write (a page out of
focus, a policy); the cockpit then drops it. A person who pastes into
another program what they did not copy should know that the session may
have put it there.

## What stays open

What the cockpit does not protect against, so that an app can decide what it
must do itself:

- another process of the app's user, which can read the state folder, and
  so the token: it can already do all the person can;
- code the agent runs without the sandbox, in a language whose file access
  Claude Code does not recognize as a command (a Python or Node script): the
  denies do not hold for it, and it can read the token and reach the app's
  port. An app whose agent must not escape its rules asks for the agent's
  sandbox (`claudeCode({ sandbox: true })`);
- a session in `plan`, `auto` or `bypassPermissions`, whose network is open
  even in the sandbox (above);
- a command excluded from the sandbox by the person's or the project's
  settings, or the app's `sandbox` (`excludedCommands`): it runs
  unconfined;
- code the agent runs outside the sandbox, which can still write a file
  that starts code at the next launch (a settings file's hook, an MCP
  server, a plugin);
- in `bypassPermissions`, the agent's own file tools, which act as the
  person: they write any file the denies do not name, among them files
  that start code at the next launch outside the sandbox (a script a hook
  or an MCP server runs, a shell's startup file). The denies on the files
  the cockpit can name are defense in depth, not a boundary;
- a hidden variable, which a process of the app's user can still read in
  the server's own environment (above);
- a tool of the person's that drives their browser (a browser automation
  server, an extension the agent can reach): the browser holds the token;
- what the app's own routes serve: the cockpit checks only the requests it
  is given, and `verify` only when the app calls it;
- TLS, accounts and sign-in, when the app opens the cockpit beyond
  loopback.
