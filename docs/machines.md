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
