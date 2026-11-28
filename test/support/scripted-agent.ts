import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Driver } from '../../src/server/driver.ts';
import { type FallbackRule, messageText, pacedTurn, startFakeApi, turn } from './fake-api/index.ts';
import { tearDownRun } from './real-agent/run-root.ts';
import { startRealAgentShim } from './real-agent/shim.ts';

/** What the fake API answers to every question, at once, but one that asks for a thorough answer. */
export const SCRIPTED_ANSWER =
  'This is the scripted answer of the fake API: no model ran. Start the example with --real to ask your own agent.';

/** What a prompt says to be answered with {@link THOROUGH_ANSWER}. */
const ASKS_FOR_A_THOROUGH_ANSWER = 'thoroughly';

/**
 * What the fake API answers to a prompt that asks for a thorough answer:
 * a long text, written slowly ({@link THOROUGH_PACE}, about 40 seconds),
 * so that a person has the time to watch a turn at work and to stop it.
 */
const THOROUGH_ANSWER = Array.from(
  { length: 8 },
  (_, part) =>
    `Part ${part + 1} of 8 of the scripted thorough answer of the fake API: no model ran. It is written a few words at a time, as a model at work writes, so that you can stop it.`,
).join('\n\n');

/** How slowly {@link THOROUGH_ANSWER} is written: about 30 characters a second. */
const THOROUGH_PACE = { pieceLength: 6, gapMs: 200 } as const;

/**
 * An example app's stand-in for the agent's model: the Claude Code this
 * repository pins, against a scripted fake of Anthropic's API, so that a
 * person can try the example with no login, no network and no cost. Every
 * question gets {@link SCRIPTED_ANSWER} at once, but one that asks for a
 * thorough answer, which gets {@link THOROUGH_ANSWER}, written slowly.
 */
export interface ScriptedAgent {
  /** The temporary folder that holds everything a session writes, removed by {@link close}. */
  readonly root: string;
  /** The folder the sessions work in, trusted by the agent: the cockpit's `directory`. */
  readonly workFolder: string;
  /** The cockpit's `stateDirectory`. */
  readonly stateFolder: string;
  /**
   * Gives the app's driver, checked: every launch must start the pinned
   * agent's shim and pass the contract runner's guard (the work folder, the
   * variables, the arguments, every settings file the agent would read, no
   * file of MCP servers, the machine's managed settings) before the cockpit
   * starts it.
   *
   * @param driver - The driver, as the app builds it (`claudeCode()`).
   * @returns The driver, checked.
   */
  driver(driver: Driver): Driver;
  /**
   * Ends the sessions and their tmux server, waits for the agents to exit,
   * stops the fake API, removes the root and gives this process back the
   * variables {@link startScriptedAgent} changed. Each step is tried,
   * whatever the one before did.
   */
  close(): Promise<void>;
}

/**
 * Starts the scripted agent: the fake API on a loopback port, and the
 * contract runner's shim in a temporary root (the agent's `HOME` and
 * configuration, which starts it at its prompt with no dialog; a trusted work
 * folder; the cockpit's state; the tmux socket). On a failure nothing is
 * left behind.
 *
 * Changes this process's `PATH` (the shim first, so the driver launches it),
 * `HOME` and `CLAUDE_CONFIG_DIR` (where the driver looks for conversations)
 * and `TMUX_TMPDIR` (where the cockpit's tmux socket goes), until
 * {@link ScriptedAgent.close}.
 *
 * @param appName - The app's name, as given to `createCockpit`: its tmux socket is named after it.
 * @returns The scripted agent.
 */
export async function startScriptedAgent(appName: string): Promise<ScriptedAgent> {
  const api = await startFakeApi({ fallback: scriptedAnswerTo });
  const shim = await startRealAgentShim(api.baseUrl).catch(async (error: unknown) => {
    await api.close();
    throw error;
  });
  const tmuxSocket = `agent-cockpit-${appName}`;
  const restoreVariables = setVariables({
    ...shim.serverVariables,
    TMUX_TMPDIR: join(shim.root, 'tmux'),
  });

  async function close(): Promise<void> {
    try {
      await tearDownRun({
        endSessions: async () => endTmuxServer(tmuxSocket),
        // Taken before the server ends: an agent still writes its files while it exits.
        processIds: paneProcesses(tmuxSocket),
        root: shim.root,
      });
    } finally {
      try {
        await api.close();
      } finally {
        restoreVariables();
      }
    }
  }

  await mkdir(join(shim.root, 'tmux'), { mode: 0o700 }).catch(async (error: unknown) => {
    await close();
    throw error;
  });
  return {
    root: shim.root,
    workFolder: shim.workFolder,
    stateFolder: shim.stateFolder,
    driver: (driver) => shim.guarded(driver),
    close,
  };
}

/** The fake API's answer to a prompt: {@link THOROUGH_ANSWER} to one that asks for it, else {@link SCRIPTED_ANSWER}. */
const scriptedAnswerTo: FallbackRule = (request) => {
  const prompt = messageText(request.body?.messages?.findLast(({ role }) => role === 'user'));
  return prompt.includes(ASKS_FOR_A_THOROUGH_ANSWER)
    ? pacedTurn(turn(THOROUGH_ANSWER), THOROUGH_PACE)
    : turn(SCRIPTED_ANSWER);
};

/** Sets variables of this process; the function returned gives back what they were. */
function setVariables(variables: Readonly<Record<string, string>>): () => void {
  const before = Object.keys(variables).map((name) => [name, process.env[name]] as const);
  Object.assign(process.env, variables);
  return () => {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

/** The processes of the sessions on the socket: each pane's process is the agent itself. */
function paneProcesses(socket: string): number[] {
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

function endTmuxServer(socket: string): void {
  try {
    execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
  } catch {
    // No server to end.
  }
}
