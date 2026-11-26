import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import type { SessionHost } from '../../../src/server/session-host/session-host.ts';
import { createTmuxSessionHost } from '../../../src/server/session-host/tmux-session-host.ts';
import { findTranscript } from '../transcript-files.ts';
import { pinnedAgentBinary } from './binary.ts';
import {
  type AgentFolders,
  agentConfiguration,
  agentEnvironment,
  onlyTheseVariables,
  ROOT_NAME_PREFIX,
  variablesAfter,
} from './environment.ts';
import { type AgentLaunch, assertStaysLocal, loopbackOrigin } from './guard.ts';

/** What a runner is started with. */
export interface RealAgentRunnerOptions {
  /**
   * Where the API's double listens: the only API the agent is told of, as
   * its origin. A plain HTTP address of the loopback interface, with its port.
   */
  readonly apiBaseUrl: string;
  /**
   * The settings of every session, given written out with `--settings`:
   * what the launch rules let pass, its hooks and its permissions.
   */
  readonly settings: object;
}

/** What a test chooses about one launch. */
export interface LaunchOptions {
  /** The prompt on the command line, after `--`; none starts the session idle. */
  readonly prompt?: string;
}

/** An entry of a transcript: one line of its file, parsed. Its format is the agent's own. */
export type TranscriptEntry = Readonly<Record<string, unknown>>;

/** How a session was when it was last seen. */
export interface SessionEnd {
  /** The last screen read of the session; `undefined` when it was gone before any was. */
  readonly lastScreen: string | undefined;
}

/** A session of the real agent, in a terminal of its own. */
export interface AgentSession {
  /** The session's name on its host, for a message to tell it from the others. */
  readonly name: string;
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
  /**
   * Fulfilled once the session is gone, however it went: its agent exited,
   * at its launch too, it was killed, or the runner closed.
   */
  readonly ended: Promise<SessionEnd>;
}

/** Runs the pinned agent for one test, in folders and on a tmux socket of its own. */
export interface RealAgentRunner {
  /** The temporary folder the run owns: everything a session writes is in it. */
  readonly root: string;
  /** The folder the sessions work in. */
  readonly workFolder: string;
  /**
   * Launches a new conversation (`--session-id`).
   *
   * @returns The session, as soon as its terminal exists: the agent is still starting.
   * @throws Error when what the agent would be started with or would read —
   * its environment, its arguments, its folders, any settings file — could
   * take it to Anthropic or to the person's configuration.
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
   * Lists what the sessions left outside the root: the folders the agent
   * keeps, a working folder each, in the machine's temporary folder when it
   * is not given one of its own.
   *
   * @returns The folders' paths; none when everything stayed in the root.
   */
  leftOutsideRoot(): string[];
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
/** How often a session is looked at, to know when it is gone and what it showed last. */
const WATCH_POLL_MS = 50;

/**
 * Starts a runner: makes its temporary root (the agent's `HOME`, its
 * configuration folder, a trusted work folder, its temporary folder) and
 * names a tmux socket no other run has. Nothing runs until a launch.
 *
 * @param options - The API's address and the sessions' settings.
 * @returns The runner; the caller closes it, whatever the test's outcome.
 * @throws Error naming `ANTHROPIC_BASE_URL` when the API's address is not a
 * plain HTTP address of the loopback interface; nothing is made then.
 */
export async function startRealAgentRunner(
  options: RealAgentRunnerOptions,
): Promise<RealAgentRunner> {
  const apiOrigin = loopbackOrigin(options.apiBaseUrl);
  const folders = await createFolders();
  const environment = agentEnvironment(folders, apiOrigin);
  const host = createTmuxSessionHost({ appName: `real-agent-${randomUUID()}` });
  const processIds: number[] = [];
  let launches = 0;
  let closed: Promise<void> | undefined;

  async function launch(
    conversation: readonly [option: '--session-id' | '--resume', id: string],
    { prompt }: LaunchOptions,
  ): Promise<AgentSession> {
    const changes = onlyTheseVariables(environment, process.env);
    const checked: AgentLaunch = {
      environment: variablesAfter(changes, process.env),
      args: [
        ...conversation,
        // Written out: the agent reads the very text that is checked, and no file that could change after it.
        '--settings',
        JSON.stringify(options.settings),
        '--permission-mode',
        'default',
        '--model',
        'haiku',
        ...(prompt === undefined ? [] : ['--', prompt]),
      ],
      workFolder: folders.workFolder,
      root: folders.root,
    };
    assertStaysLocal(checked);
    launches += 1;
    const name = `agent-${launches}`;
    await host.start({
      name,
      folder: checked.workFolder,
      command: pinnedAgentBinary(),
      args: checked.args,
      environment: changes,
      size: TERMINAL_SIZE,
    });
    const session = sessionOf(host, name, conversation[1], folders.configFolder);
    // Remembered for the teardown. An agent that exited at once has none: its session's end tells.
    await session.processId().then(
      (pid) => processIds.push(pid),
      () => undefined,
    );
    return session;
  }

  return {
    root: folders.root,
    workFolder: folders.workFolder,
    leftOutsideRoot: () => agentFoldersOutside(folders.root),
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
  const root = await mkdtemp(join(await realpath(tmpdir()), ROOT_NAME_PREFIX));
  const inside = {
    home: join(root, 'home'),
    configFolder: join(root, 'config'),
    workFolder: join(root, 'work'),
    temporaryFolder: join(root, 'tmp'),
  };
  for (const folder of Object.values(inside)) await mkdir(folder);
  const folders = { root, ...inside };
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
  let lastScreen: string | undefined;
  const screen = async () => {
    lastScreen = (await host.readScreen(name)).text;
    return lastScreen;
  };
  return {
    name,
    id,
    type: (text) => host.sendText(name, text, TYPING),
    press: (...keys) => host.sendKeys(name, keys),
    screen,
    transcript: () => readTranscript(configFolder, id),
    processId: async () => {
      const running = await host.processOf(name);
      if (running === undefined) throw new Error(`The session ${name} does not live.`);
      return running.pid;
    },
    isLive: () => host.isLive(name),
    ended: gone(host, name, screen).then(() => ({ lastScreen })),
  };
}

/**
 * Waits until a session is gone, reading its screen meanwhile: a session
 * host tells of no end, and a session that is gone shows nothing.
 */
async function gone(
  host: SessionHost,
  name: string,
  readScreen: () => Promise<unknown>,
): Promise<void> {
  // A host that cannot be asked has no session to show either.
  while (await host.isLive(name).catch(() => false)) {
    await readScreen().catch(() => undefined);
    await pause(WATCH_POLL_MS);
  }
}

function readTranscript(configFolder: string, sessionId: string): TranscriptEntry[] {
  const path = findTranscript(configFolder, sessionId);
  if (path === undefined) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as TranscriptEntry);
}

/**
 * Lists the folders an agent made for sessions under a root in the machine's
 * temporary folder: it names each after the session's working folder, so
 * each carries the root's name.
 */
function agentFoldersOutside(root: string): string[] {
  const agentFolder = join(tmpdir(), `claude-${userInfo().uid}`);
  if (!existsSync(agentFolder)) return [];
  return readdirSync(agentFolder)
    .filter((name) => name.includes(basename(root)))
    .map((name) => join(agentFolder, name));
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
      await Promise.all(processIds.map(exited));
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
async function exited(pid: number): Promise<void> {
  const deadline = Date.now() + EXIT_TIMEOUT_MS;
  while (isRunning(pid)) {
    if (Date.now() > deadline) {
      process.kill(pid, 'SIGKILL');
      return;
    }
    await pause(EXIT_POLL_MS);
  }
}
