import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeCode } from '../../src/claude-code/index.ts';
import {
  type AgentListener,
  openAgentListener,
} from '../../src/server/agent-listener/agent-listener.ts';
import type { SessionHost } from '../../src/server/session-host/session-host.ts';
import { createTmuxSessionHost } from '../../src/server/session-host/tmux-session-host.ts';
import type { JobRun, JobRuns } from '../../src/server/sessions/job-runs.ts';
import { createSessions, type Sessions } from '../../src/server/sessions/sessions.ts';
import { openUnitsOfWork, type UnitsOfWork } from '../../src/server/sessions/units-of-work.ts';
import { openRecordStore } from '../../src/server/state/records.ts';
import { openStateFolder } from '../../src/server/state/state-folder.ts';
import { createTerminalHolds } from '../../src/server/terminal-hold.ts';
import { writeAgentShim } from '../support/agent-shim.ts';
import { eventually } from '../support/eventually.ts';
import { fakeAgentCommand } from '../support/fake-agent/launching.ts';
import { writeScript } from '../support/fake-agent/script.ts';
import { transcriptPathFor } from '../support/fake-agent/transcript.ts';

/**
 * What only real files show of a remove, through the units of work, the
 * Claude Code driver and the fake agent in tmux: what the cockpit wrote for
 * the key deleted from disk, the agent's transcript left where it wrote it.
 */

const KEY = 'explain-a';

let root: string;
let configFolder: string;
let directory: string;
let statePath: string;
let host: SessionHost;
let listener: AgentListener;
let sessions: Sessions;
let units: UnitsOfWork;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-units-')));
  const shims = join(root, 'bin');
  mkdirSync(shims);
  writeAgentShim(shims, fakeAgentCommand());
  configFolder = join(root, 'config');
});

beforeEach(async () => {
  // The driver launches `claude` from the server's PATH, and reads the
  // conversations where the agents it launched keep them.
  vi.stubEnv('PATH', `${join(root, 'bin')}${delimiter}${process.env.PATH}`);
  vi.stubEnv('CLAUDE_CONFIG_DIR', configFolder);
  directory = join(root, 'work');
  mkdirSync(directory, { recursive: true });
  statePath = join(root, 'state');
  host = createTmuxSessionHost({ appName: `units-${process.pid}-${Date.now()}` });
  const folder = await openStateFolder(statePath);
  listener = await openAgentListener({
    folder: folder.path,
    receive: (request) => sessions.receive(request),
    reportFailure: () => {},
  });
  const driver = claudeCode();
  sessions = createSessions({
    host,
    driver,
    hooks: listener.hooks,
    folders: folder.sessions,
    environment: serverEnvironment,
    admitAgent: async () => {},
    confinement: async () => ({
      stateRoots: [statePath],
      appAddresses: [],
      listener: { host: '127.0.0.1', port: listener.port },
    }),
    holds: createTerminalHolds(),
  });
  units = await openUnitsOfWork({
    sessions,
    records: await openRecordStore(folder.path),
    jobs: JOBS,
    driver,
    environment: serverEnvironment,
    folders: folder.sessions,
  });
});

afterEach(async () => {
  await units.close();
  sessions.close();
  await listener.close();
  await host.shutDown();
  rmSync(statePath, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function serverEnvironment(): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

/** The app's one job: it explains a file, in the app's folder. */
const JOBS: JobRuns = {
  read(jobId, args) {
    const { file } = args as { file: string };
    const run: JobRun = {
      jobId,
      key: `explain-${file}`,
      prompt: `Explain ${file}.`,
      args,
      folder: { path: directory, relative: '.' },
      fresh: false,
    };
    return { key: run.key, prompt: `Explain ${file}.`, checked: async () => run };
  },
  makeFolder: async (folder) => folder,
  recordedFolder: async (relative) => ({ path: directory, relative }),
};

describe('a remove, on disk', () => {
  it("deletes the key's record and its session's folder, and leaves the agent's transcript", async () => {
    writeScript(directory, [{ do: 'turn', reply: 'Done.' }]);
    await units.run('explain', { file: 'a' });
    await eventually(() => expect(units.list()).toMatchObject([{ key: KEY, state: 'idle' }]));
    const conversationId = units.list()[0]?.record?.conversationId ?? '';
    const record = join(statePath, 'records', `${KEY}.json`);
    const sessionFolder = join(statePath, 'sessions', KEY);
    const transcript = transcriptPathFor(configFolder, directory, conversationId);
    expect(existsSync(record)).toBe(true);
    expect(readdirSync(sessionFolder).sort()).toEqual(['hook-address.json', 'settings.json']);
    expect(existsSync(transcript)).toBe(true);

    await expect(units.remove(KEY)).resolves.toEqual({ action: 'removed' });

    expect(existsSync(record)).toBe(false);
    expect(existsSync(sessionFolder)).toBe(false);
    expect(existsSync(transcript)).toBe(true);
    expect(await host.list()).toEqual([]);
  });
});
