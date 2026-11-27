import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeCode } from '../../src/claude-code/index.ts';
import { sandboxChecker } from '../../src/claude-code/sandbox-check.ts';
import type { Launch } from '../../src/server/driver.ts';
import { isCockpitError } from '../../src/shared/cockpit-error.ts';
import { NEVER_S, PATIENCE } from '../support/patience.ts';

/**
 * The driver's check, before a launch whose app asks for the sandbox, that
 * the agent's sandbox can run: its programs on the launch's `PATH`, then
 * one probe of what the sandbox makes, nested as the agent's helper does.
 * The probe runs programs: these tests stand in for them.
 */

let files: string;

beforeEach(() => {
  files = mkdtempSync(join(tmpdir(), 'cockpit-sandbox-check-'));
});

afterEach(() => {
  rmSync(files, { recursive: true, force: true });
});

function launchWith(PATH: string): Launch {
  return {
    key: 'chapter-1',
    conversationId: '6f1c2f0e-3b1a-4c66-9d57-0a4b8a3e5c11',
    directory: '/work/app',
    files,
    hooks: { url: 'http://127.0.0.1:4100', token: 'k3Xq9-token-of-the-launch_0123456789abcdef' },
    prompt: 'Explain a.ts',
    environment: { PATH, HOME: '/home/someone', CLAUDE_CONFIG_DIR: '/home/someone/.claude' },
    confinement: {
      stateRoots: ['/home/someone/.local/state/agent-cockpit'],
      appAddresses: [{ host: '127.0.0.1', port: 8765 }],
      listener: { host: '127.0.0.1', port: 4100 },
    },
  };
}

/** The runs of the stand-ins, each a line of its name and arguments. */
function runs(): string[] {
  try {
    return readFileSync(join(files, 'runs'), 'utf8').trim().split('\n');
  } catch {
    return [];
  }
}

/**
 * A folder of stand-ins for the commands named: each records its run and
 * exits, `bwrap` as `script` says (with success when none is given).
 */
function commandsFolder(names: readonly string[], bwrap = 'exit 0'): string {
  const folder = join(files, `bin-${names.join('-') || 'none'}-${readdirSync(files).length}`);
  mkdirSync(folder);
  for (const name of names) {
    const body = name === 'bwrap' ? bwrap : 'exit 0';
    writeFileSync(
      join(folder, name),
      `#!/bin/sh\necho "${name} $*" >> '${join(files, 'runs')}'\n${body}\n`,
    );
    chmodSync(join(folder, name), 0o755);
  }
  return folder;
}

async function refusalOf(driver: ReturnType<typeof claudeCode>, PATH: string): Promise<unknown> {
  return driver.launch(launchWith(PATH)).then(
    () => undefined,
    (error: unknown) => error,
  );
}

function settingsOf(args: readonly string[]): Record<string, unknown> {
  return JSON.parse(readFileSync(args[args.indexOf('--settings') + 1] as string, 'utf8'));
}

/** What `bwrap` says where AppArmor lets it make a namespace but denies what it runs one of its own. */
const APPARMOR_DENIAL = 'bwrap: setting up uid map: Permission denied';

describe('a launch in the sandbox the app asks for', () => {
  it("turns the sandbox on, failing where it cannot run, beside the cockpit's lines", async () => {
    const { args } = await claudeCode({ sandbox: true }).launch(
      launchWith(commandsFolder(['bwrap', 'socat'])),
    );

    expect(settingsOf(args).sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: ['127.0.0.1:4100'] },
    });
  });

  it.runIf(process.platform === 'linux')(
    'is refused as sandbox-unavailable, naming what is missing, when bubblewrap or socat is not on the PATH',
    async () => {
      const driver = claudeCode({ sandbox: true });

      const noBwrap = await refusalOf(driver, commandsFolder(['socat']));
      const neither = await refusalOf(driver, commandsFolder([]));

      expect(isCockpitError(noBwrap, 'sandbox-unavailable')).toBe(true);
      expect(noBwrap).toMatchObject({ cause: expect.stringMatching(/^bwrap not found/) });
      expect(neither).toMatchObject({ cause: expect.stringMatching(/^bwrap and socat not found/) });
    },
  );

  it.runIf(process.platform === 'linux')(
    'writes no file and starts nothing when it is refused',
    async () => {
      await refusalOf(claudeCode({ sandbox: true }), commandsFolder(['socat']));

      expect(readdirSync(files).filter((name) => !name.startsWith('bin-'))).toEqual([]);
    },
  );

  it('finds bubblewrap and socat in any folder of the PATH, not in a folder that is no folder', async () => {
    const PATH = [
      '',
      join(files, 'absent'),
      commandsFolder(['bwrap']),
      commandsFolder(['socat']),
    ].join(':');

    expect(await refusalOf(claudeCode({ sandbox: true }), PATH)).toBeUndefined();
  });

  it('does not look for the sandbox when the app does not ask for it: the person decides', async () => {
    expect(await refusalOf(claudeCode(), commandsFolder([]))).toBeUndefined();
    expect(runs()).toEqual([]);
  });

  it.runIf(process.platform === 'linux')(
    'does not count a file that cannot be run, or a folder, as the command',
    async () => {
      const folder = commandsFolder(['socat']);
      writeFileSync(join(folder, 'bwrap'), '');
      chmodSync(join(folder, 'bwrap'), 0o644);
      const other = commandsFolder([]);
      mkdirSync(join(other, 'bwrap'));

      expect(
        isCockpitError(
          await refusalOf(claudeCode({ sandbox: true }), `${folder}:${other}`),
          'sandbox-unavailable',
        ),
      ).toBe(true);
    },
  );
});

describe.runIf(process.platform === 'linux')("the probe of the agent's sandbox", () => {
  it('runs bwrap as the agent’s sandbox nests it: every namespace, and one of its own inside', async () => {
    await claudeCode({ sandbox: true }).launch(launchWith(commandsFolder(['bwrap', 'socat'])));

    expect(runs()).toEqual([
      'bwrap --unshare-all --die-with-parent --ro-bind / / --proc /proc --dev /dev unshare --user --map-root-user true',
    ]);
  });

  it('refuses a launch where bwrap cannot make what the sandbox needs: sandbox-unavailable, with what bwrap said, nothing written', async () => {
    const PATH = commandsFolder(['bwrap', 'socat'], `echo '${APPARMOR_DENIAL}' >&2\nexit 1`);

    const refusal = await refusalOf(claudeCode({ sandbox: true }), PATH);

    expect(isCockpitError(refusal, 'sandbox-unavailable')).toBe(true);
    expect(refusal).toMatchObject({
      cause: expect.stringContaining(APPARMOR_DENIAL),
    });
    expect((refusal as { cause: string }).cause).toMatch(/exited with status 1/);
    expect((refusal as { cause: string }).cause).toMatch(/AppArmor/);
    expect(
      readdirSync(files).filter((name) => name !== 'runs' && !name.startsWith('bin-')),
    ).toEqual([]);
  });

  it('probes once per driver: a later launch, or one with another PATH to the same bwrap, runs none', async () => {
    const driver = claudeCode({ sandbox: true });
    const PATH = commandsFolder(['bwrap', 'socat']);

    await driver.launch(launchWith(PATH));
    await driver.launch(launchWith(`${files}:${PATH}`));
    await claudeCode({ sandbox: true }).launch(launchWith(PATH));

    expect(runs()).toHaveLength(2);
  });

  it('keeps no failure: a launch after the machine is fixed probes again, and runs', async () => {
    const driver = claudeCode({ sandbox: true });
    const PATH = commandsFolder(['bwrap', 'socat'], 'exit 1');
    expect(isCockpitError(await refusalOf(driver, PATH), 'sandbox-unavailable')).toBe(true);

    writeFileSync(join(PATH, 'bwrap'), `#!/bin/sh\necho "bwrap $*" >> '${join(files, 'runs')}'\n`);

    expect(await refusalOf(driver, PATH)).toBeUndefined();
    expect(runs()).toHaveLength(2);
  });

  it('refuses a launch whose probe does not answer in time', async () => {
    const PATH = commandsFolder(['bwrap', 'socat'], `exec sleep ${NEVER_S}`);
    const check = sandboxChecker(200);

    const started = Date.now();
    const refusal = await check({ PATH: `${PATH}:/usr/bin:/bin` }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(Date.now() - started).toBeLessThan(PATIENCE.condition);
    expect(refusal).toMatchObject({
      code: 'sandbox-unavailable',
      cause: expect.stringMatching(/did not answer within 0\.2 s/),
    });
  });
});
