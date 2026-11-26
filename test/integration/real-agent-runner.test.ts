import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTmuxSessionHost } from '../../src/server/session-host/tmux-session-host.ts';
import { eventually } from '../support/eventually.ts';
import { type FakeApi, startFakeApi } from '../support/fake-api/index.ts';
import {
  agentEnvironment,
  onlyTheseVariables,
  TERMINAL_VARIABLES,
} from '../support/real-agent/environment.ts';
import { type RealAgentRunner, startRealAgentRunner } from '../support/real-agent/runner.ts';
import { startRealAgentShim, writeRealAgentShim } from '../support/real-agent/shim.ts';

const LOOPBACK = 'http://127.0.0.1:9';
/** Another address of this machine, where nothing listens: what a refused launch would have been sent to. */
const ELSEWHERE = { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:10' } };
const SOME_SESSION = '0c9a3d4e-0000-4000-8000-000000000000';

let runner: RealAgentRunner | undefined;
let api: FakeApi | undefined;
const made: string[] = [];

afterEach(async () => {
  await runner?.close();
  await api?.close();
  runner = undefined;
  api = undefined;
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** Starts a runner whose agents, when a test launches one, are told of an API's double and nothing else. */
async function startRunner(settings: object = {}): Promise<RealAgentRunner> {
  api = await startFakeApi();
  runner = await startRealAgentRunner({ apiBaseUrl: api.baseUrl, settings });
  return runner;
}

function writeSettings(file: string, settings: object): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(settings));
}

describe('the runner of the real agent', () => {
  it("does not start with an API that is not on the loopback: Anthropic's is never reached", async () => {
    for (const apiBaseUrl of ['https://api.anthropic.com', 'http://127.0.0.1\\@example.com']) {
      await expect(startRealAgentRunner({ apiBaseUrl, settings: {} })).rejects.toThrow(
        /ANTHROPIC_BASE_URL/,
      );
    }
  });

  it('refuses to launch, new or resumed, with settings that would send the agent elsewhere', async () => {
    const started = await startRunner(ELSEWHERE);

    await expect(started.startNew({ prompt: 'hello' })).rejects.toThrow(/settings.*"env"/);
    await expect(started.resume(SOME_SESSION)).rejects.toThrow(/settings.*"env"/);
  });

  it.each([
    ["the user's settings", ['config', 'settings.json']],
    ["the project's settings", ['work', '.claude', 'settings.json']],
    ["the project's local settings", ['work', '.claude', 'settings.local.json']],
    ['the local settings of a folder above the work folder', ['.claude', 'settings.local.json']],
  ])('refuses to launch when %s would send the agent elsewhere', async (_what, path) => {
    const started = await startRunner();
    const file = join(started.root, ...path);
    writeSettings(file, ELSEWHERE);

    await expect(started.startNew()).rejects.toThrow(/settings.*"env"/);
    await expect(started.startNew()).rejects.toThrow(file);
  });

  it.each(['home', 'config', 'tmp', 'work'])(
    'refuses to launch when its folder %s was replaced by a link that leads out of its root',
    async (name) => {
      const started = await startRunner();
      const outside = mkdtempSync(join(realpathSync(tmpdir()), 'cockpit-runner-test-'));
      made.push(outside);
      rmSync(join(started.root, name), { recursive: true });
      symlinkSync(outside, join(started.root, name));

      await expect(started.startNew()).rejects.toThrow(/not a real folder inside/);
    },
  );

  it('refuses to launch when one of its folders is gone', async () => {
    const started = await startRunner();
    rmSync(join(started.root, 'home'), { recursive: true });

    await expect(started.startNew()).rejects.toThrow(/HOME.*not a real folder inside/);
  });

  it('keeps no settings file that could change between the check and the launch', async () => {
    const started = await startRunner({ permissions: { allow: ['Bash'] } });

    expect(readdirSync(started.root).sort()).toEqual(['config', 'home', 'tmp', 'work']);
    expect(readdirSync(join(started.root, 'config'))).toEqual(['.claude.json']);
  });

  it('hands the agent the checked settings themselves, on its command line', async () => {
    const settings = { permissions: { allow: ['Bash(true)'] } };
    const started = await startRunner(settings);

    const session = await started.startNew();
    const commandLine = execFileSync(
      'ps',
      ['-o', 'args=', '-p', String(await session.processId())],
      {
        encoding: 'utf8',
      },
    );

    expect(commandLine).toContain(`--settings ${JSON.stringify(settings)}`);
  });

  it('tells when a session is gone: an agent that exits at its launch is not taken for one that starts', async () => {
    const started = await startRunner();

    const session = await started.resume(SOME_SESSION);

    await session.ended;
    expect(await session.isLive()).toBe(false);
  });

  it('tells a session is gone when the runner closes, with the last screen seen of it', async () => {
    const started = await startRunner();
    const session = await started.startNew();
    await eventually(async () => expect(await session.screen()).toContain('Claude Code'));

    await started.close();

    expect((await session.ended).lastScreen).toContain('Claude Code');
  });

  it('removes its temporary root when closed, and may be closed twice', async () => {
    const started = await startRunner();
    expect(existsSync(started.workFolder)).toBe(true);
    expect(started.workFolder.startsWith(`${started.root}/`)).toBe(true);

    await started.close();
    await started.close();

    expect(existsSync(started.root)).toBe(false);
    expect(started.leftOutsideRoot()).toEqual([]);
  });
});

describe("the environment of the real agent's process", () => {
  /** Prints the names of its variables into the file it is given. */
  const WRITE_VARIABLE_NAMES =
    'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(Object.keys(process.env)))';

  it("is the launch's variables and the terminal's own, no other", async () => {
    const folder = mkdtempSync(join(realpathSync(tmpdir()), 'cockpit-runner-test-'));
    made.push(folder);
    const report = join(folder, 'names.json');
    const folders = {
      root: folder,
      home: folder,
      configFolder: folder,
      workFolder: folder,
      temporaryFolder: folder,
    };
    const given = agentEnvironment(folders, LOOPBACK);
    const host = createTmuxSessionHost({ appName: `real-agent-environment-${process.pid}` });

    try {
      await host.start({
        name: 'names',
        folder,
        command: process.execPath,
        args: ['-e', WRITE_VARIABLE_NAMES, report],
        environment: onlyTheseVariables(given, process.env),
        size: { columns: 80, rows: 24 },
      });
      const names = await eventually(() => JSON.parse(readFileSync(report, 'utf8')) as string[]);

      expect(names.sort()).toEqual([...Object.keys(given), ...TERMINAL_VARIABLES].sort());
    } finally {
      await host.shutDown();
    }
  });
});

describe('the shim that runs the real agent in place of the driver’s claude', () => {
  it("gives its program the recipe's variables and the terminal's own, no other, and the arguments as they are", async () => {
    const folder = mkdtempSync(join(realpathSync(tmpdir()), 'cockpit-shim-test-'));
    made.push(folder);
    const report = join(folder, 'report.json');
    const program = join(folder, 'report');
    writeFileSync(
      program,
      `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(report)}, JSON.stringify({ names: Object.keys(process.env), args: process.argv.slice(2) }))\n`,
      { mode: 0o700 },
    );
    const folders = {
      root: folder,
      home: folder,
      configFolder: folder,
      workFolder: folder,
      temporaryFolder: folder,
    };
    const given = agentEnvironment(folders, LOOPBACK);
    const shim = writeRealAgentShim(folder, given, program);
    const host = createTmuxSessionHost({ appName: `real-agent-shim-${process.pid}` });

    try {
      await host.start({
        name: 'shim',
        folder,
        command: shim,
        args: ['--', "-p it's a prompt"],
        // Over the test's own variables, what the shim must drop: another API, an agent's own variable.
        environment: {
          set: { ANTHROPIC_BASE_URL: 'https://example.com', CLAUDE_CODE_ENTRYPOINT: 'cli' },
          remove: [],
        },
        size: { columns: 80, rows: 24 },
      });
      const reported = await eventually(
        () => JSON.parse(readFileSync(report, 'utf8')) as { names: string[]; args: string[] },
      );

      expect(reported.names.sort()).toEqual([...Object.keys(given), ...TERMINAL_VARIABLES].sort());
      expect(reported.args).toEqual(['--', "-p it's a prompt"]);
    } finally {
      await host.shutDown();
    }
  });

  it("refuses a launch whose claude is not the shim on the launch's PATH, and one that fails the guard", async () => {
    api = await startFakeApi();
    const shim = await startRealAgentShim(api.baseUrl);
    made.push(shim.root);
    const launching = (environment: Record<string, string>, args: string[] = []) =>
      shim
        .guarded({
          terminalKeys: [],
          silentStartCause: '',
          launch: async () => ({ command: 'claude', args, environment }),
          readHook: () => ({ events: [] }),
          canResume: async () => false,
        })
        .launch({
          key: 'k',
          conversationId: SOME_SESSION,
          directory: shim.workFolder,
          files: shim.root,
          hooks: { url: 'http://127.0.0.1:9', token: 't' },
          environment: {},
        });

    await expect(launching({ PATH: '/usr/bin:/bin' })).rejects.toThrow(/not the shim/);
    await expect(
      launching({ PATH: shim.serverVariables.PATH as string }, ['--dangerously-skip-permissions']),
    ).rejects.toThrow(/has no rule in OPTION_RULES/);
    await expect(
      launching({ PATH: shim.serverVariables.PATH as string }, ['--session-id', SOME_SESSION]),
    ).resolves.toMatchObject({ command: 'claude' });
  });
});
