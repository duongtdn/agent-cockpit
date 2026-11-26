# agent-cockpit

Drive coding agents, in their real terminal UI, from your app's own web UI.

`@duongtdn/agent-cockpit` is a library for a Node app's server and its browser
code. The coding agent does the work; the cockpit starts, resumes, watches and
steers its sessions, and gives the app a framework-free client and, when the app
wants one, a live terminal mounted in its page. It ships no web UI of its own.
It works through drivers; Claude Code is the first.

**Status:** not built yet. Nothing is published to npm so far. The package has
its six entry points and its typed errors, and nothing else.

This project is not affiliated with or endorsed by Anthropic. "Claude Code"
names the agent the first driver drives.

## What a machine needs

- Linux (WSL2 included), with tmux 3.2a or later.
- Node 22 or later.
- The coding agent, installed and logged in: Claude Code for the first driver.

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

Not written yet: it comes with the server, the client and the terminal.

## Documents

- [docs/guide.md](docs/guide.md) — the concepts an app meets.
- [docs/api.md](docs/api.md) — the reference: every entry point, export and
  error code.
- [docs/security.md](docs/security.md) — whom the cockpit defends against,
  and what an app must do.
- [docs/machines.md](docs/machines.md) — supported platforms and versions.
- [CHANGELOG.md](CHANGELOG.md) — what changed, release by release.

## Working on the cockpit

```sh
pnpm install
pnpm check    # typecheck, lint, tests, build, and what npm would pack
```

## License

MIT — see [LICENSE](LICENSE).
