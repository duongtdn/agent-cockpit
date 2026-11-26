# Machines

Where the cockpit runs, and with which versions.

**Status:** nothing is released yet. The requirements below are what this
version checks and is tested on, the agent's tested range included; each
release will state the platforms and versions it was tested on.

## Supported platforms

Linux, WSL2 included. Windows is supported through WSL2 only. macOS is not
supported yet. `createCockpit` checks the platform and rejects on any other
with `unsupported-machine` (`what: 'platform'`).

## tmux and Node versions

- tmux 3.2a or later.
- Node 22 or later. The package's `engines` field says so; `createCockpit`
  does not check it.

The tmux version is read from `tmux -V`. A release counts from 3.2a on (3.2
itself is too old); a release candidate (`3.3-rc`) or a development build
(`next-3.5`) counts as older than the release it leads to, so both of these
pass and `next-3.2` does not. A build whose name gives no version that can be
ordered (`master`, `openbsd-7.4`) is refused, as is a machine without tmux:
the error is `unsupported-machine` with `what: 'tmux'`.

## The cockpit's own tmux server

`createCockpit` checks tmux's version; a run starts a session on it. What it
does on the machine:

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

## The app's lock

One cockpit runs sessions per app, user and machine. `createCockpit` takes
the app's lock; a second process of the same app waits 5 seconds for the
first to exit (as when a watcher restarts the server), then rejects with
`cockpit-locked`, whose `holder` is the process id of the process that holds
it, or `'another-user'` when no process of the user's holds it.

The lock is a Linux abstract unix socket, `agent-cockpit-<uid>-<id>`, where
`<id>` is a random id kept in the app's state folder. The system frees it the
moment its holder exits, however it exits, so a crash never leaves a stale
lock, and there is no file to remove. It is Linux-only, which is one reason
macOS is not supported yet. On WSL2, every distribution shares the names of
abstract sockets: the id kept in the state folder makes each state folder's
lock its own, so two distributions do not block each other. The holder is
found from the kernel (`/proc/net/unix` and the processes' descriptors),
never from what the holder says.

On WSL2, keep the state folder on the Linux file system (the default, under
`~/.local/state`, is). A folder of the Windows drives (`/mnt/c/…`) shows
rights `0777` without the sticky bit, which would let any user replace it,
so the cockpit refuses a state folder there with `invalid-options` (see
`security.md`).

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

## The agent's sandbox

The agent's sandbox is on when the person turns it on, in their own Claude
Code settings (`"sandbox": { "enabled": true }`), or when the app asks for
it (`claudeCode({ sandbox: true })`). The cockpit writes into every session
the lines that keep a sandboxed command from the cockpit's files and the
app's port ([security](security.md#keeping-the-agent-out)). Without the
sandbox those lines change nothing, and a session runs as it would without
them.

On Linux, Claude Code's sandbox needs:

- `bubblewrap` (`bwrap`) and `socat`, on the `PATH` the agent runs with (on
  Debian or Ubuntu: `apt-get install bubblewrap socat`);
- unprivileged user namespaces, which `bwrap` makes, and a second one that
  Claude Code's seccomp helper makes inside `bwrap`, with its capabilities
  there (to write `/proc/self/setgroups`).

Ubuntu 24.04 restricts both through AppArmor:

- the setting `kernel.apparmor_restrict_unprivileged_userns` keeps an
  unconfined process from making a user namespace;
- the profiles of `bwrap-userns-restrict` (`bwrap` and `unpriv_bwrap`),
  loaded whatever that setting says, let `bwrap` make its namespace but run
  everything inside it under `unpriv_bwrap`, which denies every capability.

There, a check of one level, `bwrap --unshare-all --die-with-parent --ro-bind
/ / true`, passes, yet every sandboxed command the agent runs fails, with a
message like `apply-seccomp: … nested userns is capability-restricted …`.
The check that tells is the nested one:

```sh
bwrap --unshare-all --die-with-parent --ro-bind / / --proc /proc --dev /dev \
  unshare --user --map-root-user true
```

It must run without an error. The cockpit's CI makes it pass by setting
`sysctl kernel.apparmor_restrict_unprivileged_userns=0` and unloading that
profile (`apparmor_parser --remove /etc/apparmor.d/bwrap-userns-restrict`).
Both lower the machine's protection: Ubuntu restricts user namespaces
because they open the kernel to attacks, and unloading the profile, or
adjusting it to grant those capabilities, gives that back to whatever runs
in `bwrap`. On a person's machine it is their choice, not the cockpit's.
Without the sandbox, the cockpit's lines keep the agent out only as the
"Without the sandbox" column of the
[confinement table](security.md#keeping-the-agent-out) says.

WSL2 runs the sandbox as Linux does. Claude Code's `sandbox.failIfUnavailable: true`
makes the agent stop where the sandbox cannot run, rather than run
unsandboxed: the person sets it in their own settings, and the app's
`sandbox` option writes it into every session. With that option, the driver
also looks for `bwrap` and `socat` on the agent's `PATH` before each launch,
then runs the nested check above with that `bwrap` (bounded to 10 seconds,
once per `bwrap` while it passes), and refuses a launch that fails either
with `sandbox-unavailable`, whose `cause` says what is missing or what
`bwrap` said, and what would fix it. Without the option, the check is the
person's to run. The cockpit's own tests run the sandbox
on these programs, on CI too.

## The agent's tested range

The range of agent versions each driver was tested on: its contract tests
ran on them. The Claude Code driver's is 2.1.332 to 2.1.332, the version
its tests are pinned to; `cockpit.status().testedRange` gives it.

The driver reads the version of the agent each launch would run: the first
executable `claude` on the launch's `PATH`, asked `claude --version`
(which prints `2.1.332 (Claude Code)`, with no dialog and no hook, whatever
its configuration lacks). It asks once per executable, known by its real path and its time
of change, so an update of the agent is read anew at the next launch.
`createCockpit` reads it too, for `status()`; an agent missing then is no
failure, since no session runs yet.

## Outside the tested range

- **No agent** on the launch's `PATH`: the launch is refused with
  `agent-not-found` (`command: 'claude'`), and nothing starts.
- **Older** than the oldest tested: the launch is refused with
  `agent-too-old` (`found`, `oldestTested`). Update the agent.
- **Newer** than the newest tested, or a build with a suffix (`2.1.340-beta`,
  `2.1.332+local`) not older than the oldest tested: the session runs.
  `cockpit.on('untested-version', handler)` tells the app the first time a
  launch runs such a version, once per version, and `status()` says
  `tested: false`. What the driver relies on was not tested on that
  version.
- **An agent that cannot be run**: one that fails `claude --version`, hangs
  on it for 10 seconds, or prints no version, is refused with
  `agent-not-found` too, its message saying why and its `cause` holding
  what it printed (the server's alone: it never reaches the browser).
  Nothing starts; it is asked again at the next launch.
