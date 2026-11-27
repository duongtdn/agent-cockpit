import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
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
import { writeAgentShim } from '../support/agent-shim.ts';
import { fakeAgentCommand } from '../support/fake-agent/launching.ts';
import { writeScript } from '../support/fake-agent/script.ts';

/**
 * What only a real launch in tmux shows of the Claude Code driver, through
 * `createCockpit` and the fake agent: the agent's version read from its
 * program, the variables that reach its process, the configuration folder
 * checked before any file is made.
 */

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
let made = 0;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-driver-')));
  shims = join(root, 'bin');
  mkdirSync(shims);
  writeAgentShim(shims, fakeAgentCommand());
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

async function refusalOf(operation: Promise<unknown>): Promise<Record<string, unknown>> {
  return operation.then(
    () => expect.fail('Expected a refusal.'),
    (error: unknown) => error as Record<string, unknown>,
  );
}

describe("the agent's version", () => {
  it('is read as the cockpit is created: the version the agent says, tested', async () => {
    const { cockpit } = await newCockpit();

    expect(cockpit.status()).toEqual({
      agentVersion: TESTED_RANGE.newest,
      tested: true,
      testedRange: TESTED_RANGE,
    });
  });

  it('runs an agent newer than the tested range, and tells the app once, at the first launch', async () => {
    vi.stubEnv('FAKE_AGENT_VERSION', '99.0.0');
    const { cockpit, directory } = await newCockpit();
    writeScript(directory, [{ do: 'turn', reply: 'Done.' }]);
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

describe("the server's environment", () => {
  it("reaches the agent without the variables the app hides, and without the agent's own", async () => {
    vi.stubEnv('APP_SECRET', 'not for the agent');
    vi.stubEnv('APP_SETTING', 'for the agent');
    vi.stubEnv('CLAUDE_CODE_PARENT_TOKEN', 'not for the agent either');
    const { cockpit, directory, host } = await newCockpit({ hiddenEnv: ['APP_SECRET'] });
    writeScript(directory, [{ do: 'stay-busy' }]);

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
});
