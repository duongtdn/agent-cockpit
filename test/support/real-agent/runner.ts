import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import type { SessionHost } from '../../../src/server/session-host/session-host.ts';
import { createTmuxSessionHost } from '../../../src/server/session-host/tmux-session-host.ts';
import { pinnedAgentBinary } from './binary.ts';
import {
  type AgentFolders,
  agentConfiguration,
  agentEnvironment,
  onlyTheseVariables,
} from './environment.ts';
import { assertStaysLocal } from './guard.ts';

/** What a runner is started with. */
export interface RealAgentRunnerOptions {
  /** Where the API's double listens: the only API the agent is told of. */
  readonly apiBaseUrl: string;
  /** The content of the `--settings` file of every session: the hooks, and what else a test needs. */
  readonly settings: object;
}

/** What a test chooses about one launch. */
export interface LaunchOptions {
  /** The prompt on the command line, after `--`; none starts the session idle. */
  readonly prompt?: string;
}

/** An entry of a transcript: one line of its file, parsed. Its format is the agent's own. */
export type TranscriptEntry = Readonly<Record<string, unknown>>;

/** A session of the real agent, in a terminal of its own. */
export interface AgentSession {
  /** The conversation's id. */
  readonly id: string;
  /** Types text into the terminal, as a person would. */
  type(text: string): Promise<void>;
  /** Presses keys, by the session host's names (`Enter`, `Escape`). */
  press(...keys: string[]): Promise<void>;
  /** Reads what the terminal shows. */
  screen(): Promise<string>;
  /** Reads the conversation's transcript; empty while the agent has written none. */
  transcript(): TranscriptEntry[];
  /**
   * Gives the agent's process id.
   *
   * @throws Error when the session does not live.
   */
  processId(): Promise<number>;
  /** Tells whether the session lives: its terminal exists. */
  isLive(): Promise<boolean>;
}

/** Runs the pinned agent for one test, in folders and on a tmux socket of its own. */
export interface RealAgentRunner {
  /** The folder the sessions work in. */
  readonly workFolder: string;
  /**
   * Launches a new conversation (`--session-id`).
   *
   * @returns The session, as soon as its terminal exists: the agent is still starting.
   * @throws Error when the environment could reach Anthropic or the person's configuration.
   */
  startNew(options?: LaunchOptions): Promise<AgentSession>;
  /**
   * Launches the agent on a conversation it already has (`--resume`).
   *
   * @param sessionId - The conversation's id.
   * @throws Error as {@link RealAgentRunner.startNew}.
   */
  resume(sessionId: string, options?: LaunchOptions): Promise<AgentSession>;
  /**
   * Ends every session and the tmux server, waits until the agents'
   * processes are gone, and removes the temporary root. Safe to call twice.
   */
  close(): Promise<void>;
}

const TERMINAL_SIZE = { columns: 120, rows: 40 };
/** Fast enough for a test, in writes too small to read as a paste. */
const TYPING = { chunkLength: 100, pauseMs: 5 };
/** How long an agent's process may take to exit once its terminal is gone, before it is killed. */
const EXIT_TIMEOUT_MS = 5000;
const EXIT_POLL_MS = 20;

/**
 * Starts a runner: makes its temporary root (the agent's `HOME`, its
 * configuration folder, a trusted work folder, the settings file) and names
 * a tmux socket no other run has. Nothing runs until a launch.
 *
 * @param options - The API's address and the sessions' settings.
 * @returns The runner; the caller closes it, whatever the test's outcome.
 */
export async function startRealAgentRunner(
  options: RealAgentRunnerOptions,
): Promise<RealAgentRunner> {
  const folders = await createFolders();
  const settingsFile = join(folders.root, 'settings.json');
  await writeFile(settingsFile, JSON.stringify(options.settings));
  const environment = agentEnvironment(folders, options.apiBaseUrl);
  const host = createTmuxSessionHost({ appName: `real-agent-${randomUUID()}` });
  const processIds: number[] = [];
  let launches = 0;
  let closed: Promise<void> | undefined;

  async function launch(
    conversation: readonly [option: '--session-id' | '--resume', id: string],
    { prompt }: LaunchOptions,
  ): Promise<AgentSession> {
    assertStaysLocal(environment, folders.root);
    launches += 1;
    const name = `agent-${launches}`;
    await host.start({
      name,
      folder: folders.workFolder,
      command: pinnedAgentBinary(),
      args: [
        ...conversation,
        '--settings',
        settingsFile,
        '--permission-mode',
        'default',
        '--model',
        'haiku',
        ...(prompt === undefined ? [] : ['--', prompt]),
      ],
      environment: onlyTheseVariables(environment, process.env),
      size: TERMINAL_SIZE,
    });
    const session = sessionOf(host, name, conversation[1], folders.configFolder);
    // Remembered for the teardown; an agent that exited at once has none.
    await session.processId().then(
      (pid) => processIds.push(pid),
      () => undefined,
    );
    return session;
  }

  return {
    workFolder: folders.workFolder,
    startNew: (launchOptions = {}) => launch(['--session-id', randomUUID()], launchOptions),
    resume: (sessionId, launchOptions = {}) => launch(['--resume', sessionId], launchOptions),
    close: () => {
      closed ??= tearDown(host, processIds, folders.root);
      return closed;
    },
  };
}

async function createFolders(): Promise<AgentFolders> {
  // Resolved: the agent looks a folder's trust up by its resolved path.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-real-agent-')));
  const folders = {
    root,
    home: join(root, 'home'),
    configFolder: join(root, 'config'),
    workFolder: join(root, 'work'),
  };
  for (const folder of [folders.home, folders.configFolder, folders.workFolder]) {
    await mkdir(folder);
  }
  await writeFile(
    join(folders.configFolder, '.claude.json'),
    JSON.stringify(agentConfiguration(folders)),
  );
  return folders;
}

function sessionOf(
  host: SessionHost,
  name: string,
  id: string,
  configFolder: string,
): AgentSession {
  return {
    id,
    type: (text) => host.sendText(name, text, TYPING),
    press: (...keys) => host.sendKeys(name, keys),
    screen: async () => (await host.readScreen(name)).text,
    transcript: () => readTranscript(configFolder, id),
    processId: async () => {
      const running = await host.processOf(name);
      if (running === undefined) throw new Error(`The session ${name} does not live.`);
      return running.pid;
    },
    isLive: () => host.isLive(name),
  };
}

/** The agent keeps a conversation in the project folder named after the folder it first ran in. */
function readTranscript(configFolder: string, sessionId: string): TranscriptEntry[] {
  const projects = join(configFolder, 'projects');
  if (!existsSync(projects)) return [];
  const path = readdirSync(projects)
    .map((project) => join(projects, project, `${sessionId}.jsonl`))
    .find((candidate) => existsSync(candidate));
  if (path === undefined) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as TranscriptEntry);
}

/** Every step is tried, whatever the one before did: a failed test must leave nothing behind either. */
async function tearDown(
  host: SessionHost,
  processIds: readonly number[],
  root: string,
): Promise<void> {
  try {
    await host.shutDown();
  } finally {
    try {
      // An agent still writes its files while it exits.
      await Promise.all(processIds.map(gone));
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    }
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits for a process to exit, and kills one that does not. */
async function gone(pid: number): Promise<void> {
  const deadline = Date.now() + EXIT_TIMEOUT_MS;
  while (isRunning(pid)) {
    if (Date.now() > deadline) {
      process.kill(pid, 'SIGKILL');
      return;
    }
    await pause(EXIT_POLL_MS);
  }
}
