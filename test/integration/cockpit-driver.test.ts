import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { claudeCode } from '../../src/claude-code/index.ts';
import { TESTED_RANGE } from '../../src/claude-code/tested-range.ts';
import {
  type Cockpit,
  type CockpitOptions,
  createCockpit,
  type Job,
  type UntestedVersion,
} from '../../src/server/index.ts';
import type { SessionHost } from '../../src/server/session-host/session-host.ts';
import { createTmuxSessionHost } from '../../src/server/session-host/tmux-session-host.ts';
import type { Session } from '../../src/shared/session.ts';
import { writeAgentShim } from '../support/agent-shim.ts';
import { eventually } from '../support/eventually.ts';
import { fakeAgentCommand } from '../support/fake-agent/launching.ts';
import { writeScript } from '../support/fake-agent/script.ts';
import { holdTasks, releaseTasks } from '../support/fake-agent/tasks.ts';
import { startNodeHttpApp } from '../support/node-http-app.ts';
import { agentConfiguration, FAKE_API_KEY } from '../support/real-agent/environment.ts';
import { post } from '../support/wire-client.ts';

/**
 * The criteria of the complete Claude Code driver, through `createCockpit`
 * and the fake agent in tmux: start-up dialogs, failed turns, background
 * tasks, compaction, the agent's version, a job's driver part, the
 * variables the app hides, the sandbox.
 */

const pacing = { chunkLength: 100, pauseMs: 1 };

/** The port an app that runs its jobs in-process gives the cockpit. */
const APP_PORT = 4311;

const explain = {
  id: 'explain',
  title: 'Explain a file',
  args: z.object({ file: z.string().min(1) }),
  key: ({ file }: { file: string }) => `explain-${file.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
  prompt: ({ file }: { file: string }) => `Explain ${file}`,
} satisfies Job<z.ZodObject<{ file: z.ZodString }>>;

const explainJob = explain as unknown as Job;

let root: string;
/** A folder holding a `claude` that runs the fake agent. */
let shims: string;
/** A folder holding only `tmux`: a `PATH` with no agent, and no sandbox's programs. */
let tmuxOnly: string;
let made = 0;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-driver-')));
  shims = join(root, 'bin');
  mkdirSync(shims);
  writeAgentShim(shims, fakeAgentCommand());
  tmuxOnly = join(root, 'tmux-only');
  mkdirSync(tmuxOnly);
  symlinkSync(programOnPath('tmux'), join(tmuxOnly, 'tmux'));
});

beforeEach(() => {
  // The driver launches `claude` from the server's PATH, and reads the
  // conversations where the agents it launched keep them.
  vi.stubEnv('PATH', `${shims}${delimiter}${process.env.PATH}`);
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'config'));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The first program of that name on this process's `PATH`. */
function programOnPath(name: string): string {
  const found = (process.env.PATH ?? '')
    .split(delimiter)
    .map((folder) => join(folder, name))
    .find((path) => existsSync(path));
  if (found === undefined) throw new Error(`The test needs ${name} on the PATH.`);
  return found;
}

/** A cockpit of an app of its own, its folders and tmux server ended after the test. */
interface Made {
  readonly cockpit: Cockpit;
  readonly directory: string;
  readonly stateDirectory: string;
  /** The app's tmux sessions, as a person at the terminal reaches them. */
  readonly host: SessionHost;
}

async function newCockpit(options: Partial<CockpitOptions> = {}): Promise<Made> {
  made += 1;
  const name = `driver-${process.pid}-${made}`;
  const directory = join(root, `work-${made}`);
  mkdirSync(directory);
  const stateDirectory = join(root, `state-${made}`);
  const host = createTmuxSessionHost({ appName: name });
  const cockpit = await createCockpit({
    name,
    directory,
    driver: claudeCode(),
    jobs: [explainJob],
    stateDirectory,
    port: APP_PORT,
    ...options,
  });
  cleanups.push(async () => {
    await cockpit.close();
    await host.shutDown();
  });
  return { cockpit, directory, stateDirectory, host };
}

function sessionOf(cockpit: Cockpit, key: string): Session | undefined {
  return cockpit.sessions.list().find((session) => session.key === key);
}

/** Waits until the session is in the state, and gives it. */
function inState<S extends Session['state']>(cockpit: Cockpit, key: string, state: S) {
  return eventually(() => {
    const session = sessionOf(cockpit, key);
    expect(session?.state).toBe(state);
    return session as Extract<Session, { state: S }>;
  });
}

/** Records every change of a session, each state once in a row. */
function statesOf(cockpit: Cockpit, key: string): Session[] {
  const seen: Session[] = [];
  const stop = cockpit.sessions.follow((sessions) => {
    const session = sessions.find((each) => each.key === key);
    if (session !== undefined && seen.at(-1) !== session) seen.push(session);
  });
  cleanups.push(async () => stop());
  return seen;
}

/** Waits until the session's screen shows a text. */
function screenShows(host: SessionHost, key: string, text: string): Promise<void> {
  return eventually(async () => {
    expect((await host.readScreen(key)).text).toContain(text);
  });
}

/** Types a line in the session's terminal, as a person does, and submits it. */
async function type(host: SessionHost, key: string, line: string): Promise<void> {
  await host.sendText(key, line, pacing);
  await host.sendKeys(key, ['Enter']);
}

async function refusalOf(operation: Promise<unknown>): Promise<Record<string, unknown>> {
  return operation.then(
    () => expect.fail('Expected a refusal.'),
    (error: unknown) => error as Record<string, unknown>,
  );
}

describe('a start-up dialog', () => {
  /** A configuration of the agent's that does not trust the app's folder, with the key approved. */
  function untrustingConfiguration(): void {
    const folder = join(root, `config-untrusting-${made + 1}`);
    mkdirSync(folder);
    writeFileSync(
      join(folder, '.claude.json'),
      JSON.stringify(agentConfiguration({ workFolder: '/somewhere/else' })),
    );
    vi.stubEnv('CLAUDE_CONFIG_DIR', folder);
    vi.stubEnv('ANTHROPIC_API_KEY', FAKE_API_KEY);
  }

  it('makes the run resolve `waiting` on it; once the person trusts the folder, the prompt is taken and the turn ends `idle`', async () => {
    untrustingConfiguration();
    const { cockpit, directory, host } = await newCockpit();
    writeScript(directory, [[{ do: 'reply', text: 'Explained.' }]]);
    const seen = statesOf(cockpit, 'explain-a');

    const result = await cockpit.run('explain', { file: 'a' });

    expect(result).toEqual({ action: 'started', state: 'waiting' });
    expect(sessionOf(cockpit, 'explain-a')).toMatchObject({
      state: 'waiting',
      pending: [{ kind: 'terminal', dialog: 'trust-folder' }],
    });

    await host.sendKeys('explain-a', ['Down']);
    await screenShows(host, 'explain-a', '❯ Yes, I trust this folder');
    await host.sendKeys('explain-a', ['Enter']);

    expect(await inState(cockpit, 'explain-a', 'idle')).toMatchObject({
      lastMessage: 'Explained.',
    });
    expect(seen.map(({ state }) => state)).toEqual([
      'starting',
      'waiting',
      'starting',
      'busy',
      'idle',
    ]);
  });

  it('ends the session `declined`, naming the dialog, when the person leaves it', async () => {
    untrustingConfiguration();
    const { cockpit, directory, host } = await newCockpit();
    writeScript(directory, [[{ do: 'reply', text: 'Explained.' }]]);
    await cockpit.run('explain', { file: 'a' });

    await host.sendKeys('explain-a', ['Enter']);

    expect(await inState(cockpit, 'explain-a', 'ended')).toMatchObject({
      reason: 'declined',
      dialog: 'trust-folder',
    });
  });
});

describe('the states a session goes through', () => {
  it('is `idle` with the error of a turn that failed on the API', async () => {
    const { cockpit, directory } = await newCockpit();
    writeScript(directory, [[{ do: 'fail', status: 429 }]]);

    await cockpit.run('explain', { file: 'a' });

    expect(await inState(cockpit, 'explain-a', 'idle')).toMatchObject({
      error: { kind: 'rate-limit', message: expect.stringContaining('429') },
    });
  });

  it('lists a background task on `idle` while it runs; its end starts a turn of its own, which ends with none listed', async () => {
    const { cockpit, directory } = await newCockpit();
    holdTasks(directory);
    writeScript(directory, [
      [
        {
          do: 'task',
          description: 'Count files',
          prompt: 'Count the files.',
          agentType: 'general-purpose',
          work: [{ do: 'reply', text: 'Counted.' }],
        },
        { do: 'reply', text: 'Started.' },
      ],
      [{ do: 'reply', text: 'Noted.' }],
    ]);

    await cockpit.run('explain', { file: 'a' });

    expect(await inState(cockpit, 'explain-a', 'idle')).toMatchObject({
      lastMessage: 'Started.',
      backgroundTasks: [
        { id: expect.any(String), type: 'general-purpose', description: 'Count files' },
      ],
    });
    releaseTasks(directory);
    const noted = await eventually(() => {
      const session = sessionOf(cockpit, 'explain-a');
      expect(session).toMatchObject({ state: 'idle', lastMessage: 'Noted.' });
      return session;
    });
    expect(noted).not.toHaveProperty('backgroundTasks');
  });

  it('is `busy` while a compaction typed at `idle` runs, then the same `idle` again, its `since` kept', async () => {
    const { cockpit, directory, host } = await newCockpit();
    writeScript(directory, [
      [{ do: 'reply', text: 'Something to compact.' }],
      [{ do: 'compact', summary: 'The summary.' }],
    ]);
    await cockpit.run('explain', { file: 'a' });
    const idle = await inState(cockpit, 'explain-a', 'idle');
    const seen = statesOf(cockpit, 'explain-a');

    await type(host, 'explain-a', '/compact');

    await eventually(() =>
      expect(seen.map(({ state }) => state)).toEqual(['idle', 'busy', 'idle']),
    );
    expect(seen.at(-1)).toEqual(idle);
  });
});

describe("the agent's version", () => {
  it('is read as the cockpit is created: the version the agent says, tested', async () => {
    const { cockpit } = await newCockpit();

    expect(cockpit.status()).toEqual({
      agentVersion: TESTED_RANGE.newest,
      tested: true,
      testedRange: TESTED_RANGE,
    });
  });

  it('is none when no agent is found as the cockpit is created, which still opens; a run is refused `agent-not-found`, nothing listed', async () => {
    vi.stubEnv('PATH', tmuxOnly);
    const { cockpit } = await newCockpit();

    expect(cockpit.status()).toEqual({ tested: false, testedRange: TESTED_RANGE });
    expect(await refusalOf(cockpit.run('explain', { file: 'a' }))).toMatchObject({
      code: 'agent-not-found',
      command: 'claude',
    });
    expect(cockpit.sessions.list()).toEqual([]);
  });

  it('refuses a run with an agent older than the tested range: `agent-too-old`, nothing listed', async () => {
    vi.stubEnv('FAKE_AGENT_VERSION', '0.0.1');
    const { cockpit } = await newCockpit();

    expect(cockpit.status()).toEqual({
      agentVersion: '0.0.1',
      tested: false,
      testedRange: TESTED_RANGE,
    });
    expect(await refusalOf(cockpit.run('explain', { file: 'a' }))).toMatchObject({
      code: 'agent-too-old',
      found: '0.0.1',
      oldestTested: TESTED_RANGE.oldest,
    });
    expect(cockpit.sessions.list()).toEqual([]);
  });

  it('refuses a run whose agent cannot say its version: `agent-not-found` with why, 503 on the wire, never a bare 500', async () => {
    vi.stubEnv('FAKE_AGENT_VERSION', 'not-a-version');
    const app = await startNodeHttpApp('127.0.0.1');
    cleanups.push(() => app.close());
    const { cockpit } = await newCockpit({ port: app.port });
    app.serve(cockpit);
    const token = new URL(cockpit.link('http://127.0.0.1/')).hash.replace('#cockpit=', '');

    expect(cockpit.status()).toEqual({ tested: false, testedRange: TESTED_RANGE });
    const reply = await post(
      `${app.base}/run`,
      { jobId: 'explain', args: { file: 'a' } },
      { token },
    );

    expect(reply.status).toBe(503);
    expect(JSON.parse(reply.body).error).toMatchObject({
      code: 'agent-not-found',
      command: 'claude',
      message: expect.stringContaining('claude --version printed no version'),
    });
    expect(reply.body).not.toContain('not-a-version');
    expect(cockpit.sessions.list()).toEqual([]);
  });

  it('runs an agent newer than the tested range, and tells the app once, at the first launch', async () => {
    vi.stubEnv('FAKE_AGENT_VERSION', '99.0.0');
    const { cockpit, directory } = await newCockpit();
    writeScript(directory, [[{ do: 'reply', text: 'Done.' }]]);
    const told: UntestedVersion[] = [];
    cockpit.on('untested-version', (event) => told.push(event));

    expect(await cockpit.run('explain', { file: 'a' })).toEqual({
      action: 'started',
      state: 'busy',
    });
    expect(await cockpit.run('explain', { file: 'b' })).toEqual({
      action: 'started',
      state: 'busy',
    });

    expect(told).toEqual([{ agentVersion: '99.0.0', testedRange: TESTED_RANGE }]);
    expect(cockpit.status()).toEqual({
      agentVersion: '99.0.0',
      tested: false,
      testedRange: TESTED_RANGE,
    });
  });
});

describe("a job's driver part", () => {
  const settingsOf = (stateDirectory: string, key: string) =>
    JSON.parse(readFileSync(join(stateDirectory, 'sessions', key, 'settings.json'), 'utf8')) as {
      permissions: { allow?: string[] };
    };

  it("launches the job's sessions in its mode, its rules added to the app's; the app's other jobs keep the app's", async () => {
    const careful = {
      ...explain,
      id: 'careful',
      key: ({ file }: { file: string }) => `careful-${file}`,
      driver: claudeCode.job({
        permissionMode: 'acceptEdits',
        permissions: { allow: ['Bash(ls:*)'] },
      }),
    };
    const { cockpit, directory, stateDirectory, host } = await newCockpit({
      driver: claudeCode({ permissions: { allow: ['Read'] } }),
      jobs: [explainJob, careful as unknown as Job],
    });
    writeScript(directory, [[{ do: 'reply', text: 'Done.' }]]);

    await cockpit.run('careful', { file: 'a' });
    await cockpit.run('explain', { file: 'a' });

    await screenShows(host, 'careful-a', 'mode: acceptEdits');
    await screenShows(host, 'explain-a', 'mode: default');
    expect(settingsOf(stateDirectory, 'careful-a').permissions.allow).toEqual([
      'Read',
      'Bash(ls:*)',
    ]);
    expect(settingsOf(stateDirectory, 'explain-a').permissions.allow).toEqual(['Read']);
  });

  it('is refused at createCockpit, naming the job, when it opens the network of a cockpit opened beyond loopback', async () => {
    const free = {
      ...explain,
      id: 'free',
      driver: claudeCode.job({ permissionMode: 'bypassPermissions' }),
    };

    const refusal = await refusalOf(
      newCockpit({ jobs: [explainJob, free as unknown as Job], authorize: () => true }),
    );

    expect(refusal).toMatchObject({
      code: 'invalid-options',
      issues: [{ path: ['jobs', 1, 'driver'], message: expect.stringContaining('"free"') }],
    });
  });

  it('is refused at createCockpit in acceptEdits, whose file tools write unasked, when the cockpit is opened beyond loopback, unless the app accepts it', async () => {
    const editing = {
      ...explain,
      id: 'editing',
      key: ({ file }: { file: string }) => `editing-${file}`,
      driver: claudeCode.job({ permissionMode: 'acceptEdits' }),
    };
    const jobs = [explainJob, editing as unknown as Job];

    const refusal = await refusalOf(newCockpit({ jobs, authorize: () => true }));

    expect(refusal).toMatchObject({
      code: 'invalid-options',
      issues: [
        {
          path: ['jobs', 1, 'driver'],
          message: expect.stringMatching(/"editing".*without asking/s),
        },
      ],
    });
    const { cockpit, directory, host } = await newCockpit({
      driver: claudeCode({ acceptOpenNetwork: true }),
      jobs,
      authorize: () => true,
    });
    writeScript(directory, [[{ do: 'reply', text: 'Done.' }]]);
    await cockpit.run('editing', { file: 'a' });
    await screenShows(host, 'editing-a', 'mode: acceptEdits');
  });

  it('is checked again as a run launches it: a part changed since to open the network is refused, nothing launched', async () => {
    // An app in JavaScript may write the part by hand, and keep it.
    const part: { permissionMode: string } = { permissionMode: 'default' };
    const changing = { ...explain, id: 'changing', driver: part };
    const { cockpit } = await newCockpit({
      jobs: [changing as unknown as Job],
      authorize: () => true,
    });

    part.permissionMode = 'auto';

    expect(await refusalOf(cockpit.run('changing', { file: 'a' }))).toMatchObject({
      code: 'invalid-options',
      issues: [{ path: ['driver'], message: expect.stringContaining('"changing"') }],
    });
    expect(cockpit.sessions.list()).toEqual([]);
  });
});

describe("the server's environment", () => {
  it("reaches the agent without the variables the app hides, and without the agent's own", async () => {
    vi.stubEnv('APP_SECRET', 'not for the agent');
    vi.stubEnv('APP_SETTING', 'for the agent');
    vi.stubEnv('CLAUDE_CODE_PARENT_TOKEN', 'not for the agent either');
    const { cockpit, directory, host } = await newCockpit({ hiddenEnv: ['APP_SECRET'] });
    writeScript(directory, [[{ do: 'stay-busy' }]]);

    await cockpit.run('explain', { file: 'a' });

    const agent = await host.processOf('explain-a');
    const names = readFileSync(`/proc/${agent?.pid}/environ`, 'utf8')
      .split('\0')
      .map((variable) => variable.slice(0, variable.indexOf('=')));
    expect(names).toContain('APP_SETTING');
    expect(names).not.toContain('APP_SECRET');
    expect(names).not.toContain('CLAUDE_CODE_PARENT_TOKEN');
  });
});

describe("the agent's configuration folder", () => {
  it('is refused at createCockpit when the denies that keep the agent from its files could miss it: invalid-options, no state folder made', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', 'relative/config');
    const stateDirectory = join(root, 'state-of-a-refused-cockpit');

    const refusal = await refusalOf(newCockpit({ stateDirectory }));

    expect(refusal).toMatchObject({
      code: 'invalid-options',
      issues: [{ path: [], message: expect.stringContaining('CLAUDE_CONFIG_DIR') }],
    });
    expect(existsSync(stateDirectory)).toBe(false);
  });

  it('is refused again at a launch, read from the environment as it is then', async () => {
    const { cockpit } = await newCockpit();
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'config*'));

    expect(await refusalOf(cockpit.run('explain', { file: 'a' }))).toMatchObject({
      code: 'invalid-options',
      issues: [{ path: [], message: expect.stringContaining('CLAUDE_CONFIG_DIR') }],
    });
    expect(cockpit.sessions.list()).toEqual([]);
  });
});

describe("the agent's sandbox the app asked for", () => {
  it('refuses a run where it cannot run, with its cause: 503 on the wire, nothing launched', async () => {
    vi.stubEnv('PATH', `${shims}${delimiter}${tmuxOnly}`);
    const app = await startNodeHttpApp('127.0.0.1');
    cleanups.push(() => app.close());
    const { cockpit } = await newCockpit({ driver: claudeCode({ sandbox: true }), port: app.port });
    app.serve(cockpit);
    const token = new URL(cockpit.link('http://127.0.0.1/')).hash.replace('#cockpit=', '');

    const reply = await post(
      `${app.base}/run`,
      { jobId: 'explain', args: { file: 'a' } },
      { token },
    );

    expect(reply.status).toBe(503);
    expect(JSON.parse(reply.body).error).toMatchObject({
      code: 'sandbox-unavailable',
      cause: expect.stringContaining('bwrap'),
    });
    expect(cockpit.sessions.list()).toEqual([]);
  });
});
