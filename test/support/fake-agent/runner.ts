import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTmuxSessionHost } from '../../../src/server/session-host/tmux-session-host.ts';
import { type AgentSession, sessionOf } from '../agent-session.ts';
import { fakeAgentCommand } from './launching.ts';
import { type Turn, writeScript } from './script.ts';

/** What a runner of the fake agent is started with. */
export interface FakeAgentRunnerOptions {
  /** The settings of every session, given as a file with `--settings`. */
  readonly settings: object;
  /** The script the sessions play, a turn a prompt. */
  readonly script: readonly Turn[];
}

/** Runs the fake agent as the real agent's runner runs the real one: in folders and on a tmux socket of its own. */
export interface FakeAgentRunner {
  /** The folder the sessions work in. */
  readonly workFolder: string;
  /** Launches a new conversation (`--session-id`), with a prompt on the command line or none. */
  startNew(options?: { readonly prompt?: string }): Promise<AgentSession>;
  /** Launches the fake agent on a conversation it already has (`--resume`). */
  resume(sessionId: string, options?: { readonly prompt?: string }): Promise<AgentSession>;
  /** Ends every session and the tmux server, and removes the temporary folders. */
  close(): Promise<void>;
}

const TERMINAL_SIZE = { columns: 120, rows: 40 };

/**
 * Starts a runner of the fake agent: makes its temporary folders, writes
 * the settings and the script, and names a tmux socket no other run has.
 * Nothing runs until a launch, and each launch has the command line the
 * real agent's runner gives the real agent.
 *
 * @param options - See {@link FakeAgentRunnerOptions}.
 * @returns The runner; the caller closes it.
 */
export async function startFakeAgentRunner(
  options: FakeAgentRunnerOptions,
): Promise<FakeAgentRunner> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'cockpit-fake-agent-'));
  const [configFolder, workFolder] = [join(root, 'config'), join(root, 'work')];
  const settingsFile = join(root, 'settings.json');
  await mkdir(configFolder);
  await mkdir(workFolder);
  await writeFile(settingsFile, JSON.stringify(options.settings));
  writeScript(workFolder, options.script);
  const host = createTmuxSessionHost({ appName: `fake-agent-${randomUUID()}` });
  const agent = fakeAgentCommand();
  let launches = 0;

  async function launch(
    conversation: readonly [option: '--session-id' | '--resume', id: string],
    prompt: string | undefined,
  ): Promise<AgentSession> {
    launches += 1;
    const name = `fake-agent-${launches}`;
    await host.start({
      name,
      folder: workFolder,
      command: agent.command,
      args: [
        ...agent.args,
        ...conversation,
        '--settings',
        settingsFile,
        '--permission-mode',
        'default',
        '--model',
        'haiku',
        ...(prompt === undefined ? [] : ['--', prompt]),
      ],
      environment: { set: { CLAUDE_CONFIG_DIR: configFolder }, remove: [] },
      size: TERMINAL_SIZE,
    });
    return sessionOf(host, { name, id: conversation[1], configFolder });
  }

  return {
    workFolder,
    startNew: ({ prompt } = {}) => launch(['--session-id', randomUUID()], prompt),
    resume: (sessionId, { prompt } = {}) => launch(['--resume', sessionId], prompt),
    async close() {
      try {
        await host.shutDown();
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 5 });
      }
    },
  };
}
