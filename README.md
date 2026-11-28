# agent-cockpit

Drive coding agents, in their real terminal UI, from your app's own web UI.

`@duongtdn/agent-cockpit` is a library for a Node app's server and its browser
code. The coding agent does the work; the cockpit starts, resumes, watches and
steers its sessions, and gives the app a framework-free client and, when the app
wants one, a live terminal mounted in its page. It ships no web UI of its own.
It works through drivers; Claude Code is the first.

**Status:** a first path works, end to end: an app creates and mounts a
cockpit, draws a launcher form from its jobs' descriptions and choices,
runs, sends to, opens and starts over its units of work (each key's
conversation resumed in every state, its record kept across restarts, the
person's half-typed draft kept when a prompt is typed), follows the
sessions live, and mounts a session's terminal in its page. Access is built: the cockpit serves
the loopback by default, with a token from the app's link, and the app may
open it beyond the machine with its own `authorize`; every session's
settings keep the agent from the cockpit's files, the app's port and the
files the cockpit can name that would start code at its next launch. The Claude Code driver is complete: its options
(mode, rules, model, plugin, sources of settings, the sandbox), a job's
own driver part, the agent's version checked before each launch, start-up
dialogs, failed turns, background tasks and compaction. The app
interrupts, ends and removes its units of work, and idle sessions end
after a timeout. Still to come: asks, the channel, activity.
Nothing is published to npm so far.

This project is not affiliated with or endorsed by Anthropic. "Claude Code"
names the agent the first driver drives.

## What a machine needs

- Linux (WSL2 included), with tmux 3.2a or later.
- Node 22 or later.
- The coding agent, installed and logged in: Claude Code for the first
  driver, at a version within its tested range (2.1.332 for now) or newer.
- For the agent's sandbox, which the person turns on in their own settings
  or the app asks for: `bubblewrap` and `socat`, and user namespaces.

[docs/machines.md](docs/machines.md) has the details.

## Installing

Not possible yet: nothing is published. Once it is:

```sh
npm install @duongtdn/agent-cockpit zod
```

zod 4 is a peer dependency; Fastify is an optional one, for apps that mount
the cockpit with the Fastify adapter.

On Linux, `node-pty` compiles when it is installed: the machine needs a C/C++
toolchain, `make` and Python 3. With pnpm, allow its build script
(`pnpm approve-builds`). [docs/machines.md](docs/machines.md#installing-on-linux)
has the details.

## A first working page

[docs/guide.md](docs/guide.md#getting-started) shows the server (Fastify, or
a plain `node:http` server), the page and the link.
[examples/jobs-console](examples/jobs-console/DEMO.md) is one, whole: a
Fastify app that mounts the cockpit, offers four jobs and prints its link,
and a page in plain JavaScript that draws a launcher form for each job,
runs, opens and starts afresh, follows the sessions and mounts a terminal.
It runs with no login against a scripted API.
[examples/translate-and-access](examples/translate-and-access/DEMO.md) shows
access: the link and its token, the app's own API checking it, a page of
the network refused, then served once the app opens itself with
`authorize`, the app's routes that change something refusing pages of
other origins, the terminal kept to the machine, and the token renewed.
[examples/asks-on-page](examples/asks-on-page/DEMO.md) shows the agent's
asks on a page with no terminal: each permission the agent asks, with its
tool, input and description, answered Allow, Allow for the session or Deny
with a message; one only the terminal can answer, shown as such; and every
ask settled, with what settled it.

## Documents

- [docs/guide.md](docs/guide.md) — the concepts an app meets.
- [docs/api.md](docs/api.md) — the reference: every entry point, export and
  error code.
- [docs/security.md](docs/security.md) — whom the cockpit defends against,
  opening beyond loopback, the token, what the agent is kept from in each
  permission mode, and what an app must do.
- [docs/machines.md](docs/machines.md) — supported platforms and versions.
- [CHANGELOG.md](CHANGELOG.md) — what changed, release by release.

## Working on the cockpit

```sh
pnpm install
pnpm check    # typecheck, lint, tests, build, and what npm would pack
```

The tests need tmux 3.2a or later and Node 22.18 or later. Some run the real
Claude Code, a development dependency at one exact version, against a
scripted API on the machine itself: they need no login, send nothing to
Anthropic, and leave the person's own Claude Code and its configuration
alone. [CLAUDE.md](CLAUDE.md) has the conventions.

## License

MIT — see [LICENSE](LICENSE).
