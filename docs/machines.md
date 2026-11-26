# Machines

Where the cockpit runs, and with which versions.

**Status:** the cockpit is not built yet. The requirements below are what it
is being built for; each release will state the platforms and versions it was
tested on.

## Supported platforms

Linux, WSL2 included. Windows is supported through WSL2 only. macOS is not
supported yet.

## tmux and Node versions

- tmux 3.2a or later.
- Node 22 or later.

The tmux version is read from `tmux -V`. A release counts from 3.2a on (3.2
itself is too old); a release candidate (`3.3-rc`) or a development build
(`next-3.5`) counts as older than the release it leads to, so both of these
pass and `next-3.2` does not. A build whose name gives no version that can be
ordered (`master`, `openbsd-7.4`) is refused, as is a machine without tmux:
the error is `unsupported-machine` with `what: 'tmux'`.

## The cockpit's own tmux server

The part of the cockpit that runs tmux is built; no public call reaches it
yet. What it does on the machine:

- Sessions live on a tmux server of the app's own, on a socket named
  `agent-cockpit-` and the app's name, apart from the person's tmux server
  and its sessions.
- That server reads no configuration file: the person's `~/.tmux.conf` does
  not apply to it, and the cockpit changes nothing in it.
- On that server only, the cockpit sets tmux up for a terminal shown in a
  page:
  - Programs see `TERM=tmux-256color` when the machine's terminal database
    describes it, else `screen-256color`, and `COLORTERM=truecolor`; 24-bit
    colors pass through.
  - The mouse is on: the wheel scrolls the session's history.
  - There is no prefix key: Ctrl+B reaches the agent like any other key.
  - There is no status line: every row shows the agent's screen.
  - Esc reaches the agent at once; focus changes and copies made by the
    agent (OSC 52) pass to the terminal; two terminals on one session share
    the window at the size of the one last used.

The terminal database is asked through `infocmp tmux-256color`, a program of
ncurses. Where `infocmp` or that description is missing, sessions still run,
on `screen-256color`, which lacks a few abilities such as italics. Nothing
has to be installed for it.

## Installing on Linux

The cockpit depends on `node-pty`, a native module that ships prebuilt
binaries for macOS and Windows only. On Linux its install script compiles it
with `node-gyp`, so the machine that installs needs:

- a C/C++ toolchain and `make` (on Debian or Ubuntu, `build-essential`);
- Python 3.

pnpm runs a dependency's install script only when the app allows it: run
`pnpm approve-builds` and pick `node-pty`, or list it under
`onlyBuiltDependencies` in the app's `pnpm-workspace.yaml`. Without that,
the install succeeds but `node-pty` is not compiled, and loading it fails.
npm runs the script by default.

## The agent's tested range

The range of agent versions each driver was tested on. Not set yet: no driver
is built.

## Outside the tested range

What happens when the agent is newer or older than the tested range. Not
written yet: no driver is built.
