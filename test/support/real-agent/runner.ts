import { randomUUID } from 'node:crypto';
import { createTmuxSessionHost } from '../../../src/server/session-host/tmux-session-host.ts';
import { type AgentSession, sessionOf } from '../agent-session.ts';
import { pinnedAgentBinary } from './binary.ts';
import { agentEnvironment, onlyTheseVariables, variablesAfter } from './environment.ts';
import { type AgentLaunch, assertStaysLocal, loopbackOrigin } from './guard.ts';
import { agentFoldersOutside, createAgentFolders, tearDownRun } from './run-root.ts';

export type { AgentSession, SessionEnd, TranscriptEntry } from '../agent-session.ts';

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
  const folders = await createAgentFolders();
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
    const session = sessionOf(host, {
      name,
      id: conversation[1],
      configFolder: folders.configFolder,
    });
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
      closed ??= tearDownRun({
        endSessions: () => host.shutDown(),
        processIds,
        root: folders.root,
      });
      return closed;
    },
  };
}
