// The example's default agent: the Claude Code this repository pins, run
// against a scripted fake of Anthropic's API, so that a person can try the
// example with no login, no network and no cost. Every question gets the
// same scripted answer.
//
// It is development support, not part of the package: it uses the
// repository's test doubles (TypeScript, which Node 22.18 or later runs as
// it is). An app has nothing like it; it runs the person's own `claude`.

import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { startFakeApi, turn } from '../../test/support/fake-api/index.ts';
import { pinnedAgentBinary } from '../../test/support/real-agent/binary.ts';
import {
  agentConfiguration,
  agentEnvironment,
  TERMINAL_VARIABLES,
} from '../../test/support/real-agent/environment.ts';

/** What the fake API answers to every question. */
export const SCRIPTED_ANSWER =
  'This is the scripted answer of the fake API: no model ran. Start the example with --real to ask your own agent.';

/** How long an agent may take to exit once its tmux server is gone, before it is killed. */
const EXIT_TIMEOUT_MS = 5_000;
const EXIT_POLL_MS = 50;

/**
 * Starts the scripted agent: a temporary folder for everything a session
 * writes (the agent's `HOME`; its configuration, which starts it at its
 * prompt with no dialog: onboarding done, the key approved, the work folder
 * trusted; the cockpit's state; the tmux socket), the fake API on a loopback port, and a `claude`
 * first on this process's `PATH` that runs the pinned agent with only the
 * variables that keep it on the fake API.
 *
 * Changes this process's `PATH`, `CLAUDE_CONFIG_DIR` (where the driver looks
 * for conversations) and `TMUX_TMPDIR` (where the cockpit's tmux socket goes).
 *
 * @param appName - The app's name, as given to `createCockpit`: its tmux socket is named after it.
 * @returns The folders to give the cockpit, and `close`, which ends the
 * sessions and their tmux server, the fake API, and removes the folder.
 */
export async function startScriptedAgent(appName) {
  // Resolved: the agent looks a folder's trust up by its resolved path.
  const root = await mkdtemp(join(await realpath(tmpdir()), 'jobs-console-'));
  const folders = {
    root,
    home: join(root, 'home'),
    configFolder: join(root, 'config'),
    workFolder: join(root, 'work'),
    temporaryFolder: join(root, 'tmp'),
  };
  const stateFolder = join(root, 'state');
  const shimFolder = join(root, 'bin');
  const tmuxFolder = join(root, 'tmux');
  for (const folder of [...Object.values(folders).slice(1), stateFolder, shimFolder, tmuxFolder]) {
    await mkdir(folder, { mode: 0o700 });
  }
  await writeFile(
    join(folders.configFolder, '.claude.json'),
    JSON.stringify(agentConfiguration(folders)),
  );
  const api = await startFakeApi({ fallback: turn(SCRIPTED_ANSWER) });
  await writeShim(shimFolder, agentEnvironment(folders, api.baseUrl));
  process.env.PATH = `${shimFolder}:${process.env.PATH}`;
  process.env.CLAUDE_CONFIG_DIR = folders.configFolder;
  process.env.TMUX_TMPDIR = tmuxFolder;
  const tmuxSocket = `agent-cockpit-${appName}`;

  return {
    root,
    workFolder: folders.workFolder,
    stateFolder,
    async close() {
      // Each step is tried, whatever the one before did: nothing is left behind.
      try {
        const agents = paneProcesses(tmuxSocket);
        endTmuxServer(tmuxSocket);
        // An agent still writes its files while it exits.
        await Promise.all(agents.map(exited));
      } finally {
        try {
          await api.close();
        } finally {
          await rm(root, { recursive: true, force: true, maxRetries: 5 });
        }
      }
    },
  };
}

/**
 * Writes the `claude` the driver launches: it runs the pinned agent with the
 * variables given and the terminal's own, and no other — none of the
 * server's, so no key or address of the person's reaches the agent.
 */
async function writeShim(folder, variables) {
  const terminal = TERMINAL_VARIABLES.map((name) => `\${${name}+"${name}=$${name}"}`);
  const given = Object.entries(variables).map(([name, value]) => shellWord(`${name}=${value}`));
  const command = ['exec /usr/bin/env -i', ...terminal, ...given, shellWord(pinnedAgentBinary())];
  const shim = join(folder, 'claude');
  await writeFile(shim, `#!/bin/sh\n${command.join(' ')} "$@"\n`);
  await chmod(shim, 0o700);
}

function shellWord(word) {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The processes of the sessions on the socket: each pane's process is the agent itself. */
function paneProcesses(socket) {
  try {
    return execFileSync('tmux', ['-L', socket, 'list-panes', '-a', '-F', '#{pane_pid}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter((line) => line !== '')
      .map(Number);
  } catch {
    // No server: no session was run.
    return [];
  }
}

function endTmuxServer(socket) {
  try {
    execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
  } catch {
    // No server to end.
  }
}

async function exited(pid) {
  const deadline = Date.now() + EXIT_TIMEOUT_MS;
  while (isRunning(pid)) {
    if (Date.now() > deadline) {
      process.kill(pid, 'SIGKILL');
      return;
    }
    await pause(EXIT_POLL_MS);
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
