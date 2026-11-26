import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { claudeCode } from '../../src/claude-code/index.ts';
import { checkCockpitOptions } from '../../src/server/cockpit-options.ts';
import { checkPlatform, linkTo } from '../../src/server/create-cockpit.ts';
import type { Job } from '../../src/server/jobs.ts';
import { isCockpitError } from '../../src/shared/cockpit-error.ts';

const folder = mkdtempSync(join(tmpdir(), 'cockpit-options-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const explain = {
  id: 'explain',
  title: 'Explain a file',
  args: z.object({ file: z.string().min(1) }),
  key: ({ file }: { file: string }) => `explain-${file.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
  prompt: ({ file }: { file: string }) => `Explain ${file}`,
} satisfies Job<z.ZodObject<{ file: z.ZodString }>>;

const valid = () => ({ name: 'my-app', directory: folder, driver: claudeCode(), jobs: [explain] });

async function optionIssues(options: unknown) {
  const error = await checkCockpitOptions(options).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(isCockpitError(error, 'invalid-options')).toBe(true);
  return (error as { issues: { path: unknown[]; message: string }[] }).issues;
}

describe("createCockpit's options", () => {
  it('pass as given, the app’s folder made absolute', async () => {
    const checked = await checkCockpitOptions({
      ...valid(),
      directory: '.',
      stateDirectory: join(folder, 'state'),
      agentPort: 4567,
    });

    expect(checked).toMatchObject({ name: 'my-app', directory: resolve('.'), agentPort: 4567 });
  });

  it.each([undefined, null, 'my-app', 3])('refuse %j as no options', async (given) => {
    expect(await optionIssues(given)).toEqual([
      { path: [], message: 'Expected the options, an object.' },
    ]);
  });

  it('refuse every missing or ill-typed option, each with its path', async () => {
    const issues = await optionIssues({
      name: '',
      directory: 3,
      driver: {},
      jobs: 'none',
      stateDirectory: '',
      agentPort: 70000,
      terminal: 'no',
      origins: 'https://app.example',
      authorize: 'yes',
      port: -1,
      hiddenEnv: 'SECRET',
    });

    expect(issues.map(({ path }) => path).sort()).toEqual(
      [
        ['agentPort'],
        ['authorize'],
        ['directory'],
        ['driver'],
        ['hiddenEnv'],
        ['jobs'],
        ['name'],
        ['origins'],
        ['port'],
        ['stateDirectory'],
        ['terminal'],
      ].sort(),
    );
  });

  it.each(['channel', 'idleTimeout', 'elicitations', 'typo'])(
    'refuse %s, an option this version does not take, rather than ignore it',
    async (name) => {
      expect(await optionIssues({ ...valid(), [name]: undefined })).toEqual([
        { path: [name], message: 'Not an option of this version of the cockpit.' },
      ]);
    },
  );

  it('keep the terminal on and the cockpit on loopback when the access options are left out', async () => {
    const checked = await checkCockpitOptions(valid());

    expect(checked).toMatchObject({ terminal: 'on', origins: [], ports: [] });
    expect(checked.authorize).toBeUndefined();
  });

  it('take the names of the variables hidden from the sessions; none when left out', async () => {
    expect((await checkCockpitOptions(valid())).hiddenEnv).toEqual([]);
    expect(
      (await checkCockpitOptions({ ...valid(), hiddenEnv: ['ADMIN_TOKEN', 'db.password'] }))
        .hiddenEnv,
    ).toEqual(['ADMIN_TOKEN', 'db.password']);
  });

  it.each(['', 'A=B', 'A\0B'])('refuse %j as the name of a hidden variable', async (name) => {
    expect(
      (await optionIssues({ ...valid(), hiddenEnv: ['OK', name] })).map(({ path }) => path),
    ).toEqual([['hiddenEnv', 1]]);
  });

  it('take the access options: authorize, sync or async, origins, the terminal switch', async () => {
    const authorize = async () => true;
    const checked = await checkCockpitOptions({
      ...valid(),
      authorize,
      origins: ['https://app.example', 'http://10.0.0.5:8765'],
      terminal: 'loopback',
    });

    expect(checked).toMatchObject({
      authorize,
      origins: ['https://app.example', 'http://10.0.0.5:8765'],
      terminal: 'loopback',
    });
  });

  it.each([
    [8765, [8765]],
    [
      [8765, 8443],
      [8765, 8443],
    ],
  ])('take the app’s port %j, as the list of its ports', async (port, ports) => {
    expect((await checkCockpitOptions({ ...valid(), port })).ports).toEqual(ports);
  });

  it.each([0, 65536, 1.5, '8765', [], [8765, 0]])('refuse the port %j', async (port) => {
    const issues = await optionIssues({ ...valid(), port });

    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every(({ path }) => path[0] === 'port')).toBe(true);
  });

  it.each(['always', true, 'loopback-only'])('refuse the terminal switch %j', async (terminal) => {
    expect((await optionIssues({ ...valid(), terminal })).map(({ path }) => path)).toEqual([
      ['terminal'],
    ]);
  });

  it('refuse an authorize that is no function', async () => {
    expect((await optionIssues({ ...valid(), authorize: true })).map(({ path }) => path)).toEqual([
      ['authorize'],
    ]);
  });

  it.each([
    'https://app.example/',
    'https://app.example/page',
    'https://App.example',
    'app.example',
    'ftp://app.example',
    'https://app.example?x=1',
    'https://user@app.example',
  ])('refuse the origin %j: an origin as a browser sends it, nothing else', async (origin) => {
    expect(
      (await optionIssues({ ...valid(), origins: ['https://ok.example', origin] })).map(
        ({ path }) => path,
      ),
    ).toEqual([['origins', 1]]);
  });

  it('refuse a driver whose sessions reach an open network, with authorize, unless the app accepted it', async () => {
    const open = claudeCode({ permissionMode: 'bypassPermissions' });
    const accepted = claudeCode({ permissionMode: 'bypassPermissions', acceptOpenNetwork: true });
    const authorize = () => true;

    expect(await optionIssues({ ...valid(), driver: open, authorize })).toEqual([
      { path: ['driver'], message: expect.stringContaining('acceptOpenNetwork') },
    ]);
    await expect(
      checkCockpitOptions({ ...valid(), driver: accepted, authorize }),
    ).resolves.toBeDefined();
    await expect(checkCockpitOptions({ ...valid(), driver: open })).resolves.toBeDefined();
  });

  it.each(['default', 'dontAsk'] as const)(
    'take a driver in %s with authorize: its sessions are confined',
    async (permissionMode) => {
      await expect(
        checkCockpitOptions({
          ...valid(),
          driver: claudeCode({ permissionMode }),
          authorize: () => true,
        }),
      ).resolves.toBeDefined();
    },
  );

  it('refuse a driver in acceptEdits with authorize, saying its file tools write unasked, unless the app accepted it', async () => {
    const authorize = () => true;

    expect(
      await optionIssues({
        ...valid(),
        driver: claudeCode({ permissionMode: 'acceptEdits' }),
        authorize,
      }),
    ).toEqual([{ path: ['driver'], message: expect.stringMatching(/write.*without asking/) }]);
    await expect(
      checkCockpitOptions({
        ...valid(),
        driver: claudeCode({ permissionMode: 'acceptEdits', acceptOpenNetwork: true }),
        authorize,
      }),
    ).resolves.toBeDefined();
  });

  it('refuse a driver that does not say how far its sessions reach the network', async () => {
    const { networkOf: _left, ...withoutNetwork } = claudeCode();

    expect(
      (await optionIssues({ ...valid(), driver: withoutNetwork })).map(({ path }) => path),
    ).toEqual([['driver']]);
  });

  it('refuse a job that does not fit, each issue with its path', async () => {
    const issues = await optionIssues({
      ...valid(),
      jobs: [{ id: '', title: 3, args: {}, key: 'k', prompt: 'p', description: 2 }],
    });

    expect(issues.map(({ path }) => path.join('.')).sort()).toEqual(
      [
        'jobs.0.args',
        'jobs.0.description',
        'jobs.0.id',
        'jobs.0.key',
        'jobs.0.prompt',
        'jobs.0.title',
      ].sort(),
    );
  });

  it("take a job's driver part that fits the driver", async () => {
    const part = claudeCode.job({ permissionMode: 'acceptEdits', model: 'haiku' });

    const checked = await checkCockpitOptions({ ...valid(), jobs: [{ ...explain, driver: part }] });

    expect(checked.jobs[0]?.driver).toBe(part);
  });

  it("refuse a job's driver part that does not fit the driver, each issue with its path from the options", async () => {
    const issues = await optionIssues({
      ...valid(),
      jobs: [
        explain,
        { ...explain, id: 'other', driver: { permissionMode: 'loose', pluginDir: '.' } },
      ],
    });

    expect(issues.map(({ path }) => path).sort()).toEqual(
      [
        ['jobs', 1, 'driver', 'permissionMode'],
        ['jobs', 1, 'driver', 'pluginDir'],
      ].sort(),
    );
  });

  it.each(['acceptEdits', 'plan', 'auto', 'bypassPermissions'] as const)(
    "refuse a job in %s with authorize, naming the job, unless the app's driver accepted the open network",
    async (permissionMode) => {
      const job = { ...explain, id: 'free', driver: claudeCode.job({ permissionMode }) };
      const authorize = () => true;

      expect(await optionIssues({ ...valid(), jobs: [explain, job], authorize })).toEqual([
        { path: ['jobs', 1, 'driver'], message: expect.stringContaining('"free"') },
      ]);
      await expect(
        checkCockpitOptions({
          ...valid(),
          driver: claudeCode({ acceptOpenNetwork: true }),
          jobs: [job],
          authorize,
        }),
      ).resolves.toBeDefined();
      await expect(checkCockpitOptions({ ...valid(), jobs: [job] })).resolves.toBeDefined();
    },
  );

  it("refuse the driver's own open mode with authorize, even when every job sets a confined one", async () => {
    const job = { ...explain, driver: claudeCode.job({ permissionMode: 'default' }) };

    expect(
      await optionIssues({
        ...valid(),
        driver: claudeCode({ permissionMode: 'auto' }),
        jobs: [job],
        authorize: () => true,
      }),
    ).toEqual([{ path: ['driver'], message: expect.stringContaining('acceptOpenNetwork') }]);
  });

  it('take a job’s option sources, folder and fresh', async () => {
    const job = {
      ...explain,
      options: { file: () => [{ value: 'a.md' }] },
      directory: () => 'docs',
      fresh: true as const,
    };

    const checked = await checkCockpitOptions({ ...valid(), jobs: [job] });

    expect(checked.jobs[0]).toBe(job);
  });

  it('refuse a job’s option sources, folder and fresh that do not fit, each issue with its path from the options', async () => {
    const issues = await optionIssues({
      ...valid(),
      jobs: [
        explain,
        { ...explain, id: 'other', options: { nothing: () => [] }, directory: 'docs', fresh: 1 },
      ],
    });

    expect(issues.map(({ path }) => path)).toEqual([
      ['jobs', 1, 'options', 'nothing'],
      ['jobs', 1, 'directory'],
      ['jobs', 1, 'fresh'],
    ]);
  });

  it('refuse a job whose arguments JSON Schema cannot describe, or are no object', async () => {
    const issues = await optionIssues({
      ...valid(),
      jobs: [
        { ...explain, args: z.object({ when: z.date() }) },
        { ...explain, id: 'other', args: z.string() },
      ],
    });

    expect(issues).toEqual([
      { path: ['jobs', 0, 'args'], message: expect.stringContaining('JSON Schema') },
      { path: ['jobs', 1, 'args'], message: expect.stringContaining('object schema') },
    ]);
  });

  it('take a cap on live sessions, a whole number from 1', async () => {
    expect(await checkCockpitOptions({ ...valid(), maxSessions: 2 })).toMatchObject({
      maxSessions: 2,
    });
    for (const maxSessions of [0, 1.5, '2']) {
      expect(await optionIssues({ ...valid(), maxSessions })).toEqual([
        { path: ['maxSessions'], message: expect.any(String) },
      ]);
    }
  });

  it('refuse two jobs of one id', async () => {
    expect(await optionIssues({ ...valid(), jobs: [explain, { ...explain }] })).toEqual([
      { path: ['jobs', 1, 'id'], message: 'Another job has the id "explain".' },
    ]);
  });

  it('refuse an app’s folder that is no folder', async () => {
    const file = join(folder, 'a-file');
    writeFileSync(file, '');

    for (const directory of [file, join(folder, 'none')]) {
      expect(await optionIssues({ ...valid(), directory })).toEqual([
        { path: ['directory'], message: `No folder at ${directory}.` },
      ]);
    }
  });
});

describe('the link', () => {
  it('puts the token in the page’s fragment, replacing one it had', () => {
    expect(linkTo('http://127.0.0.1:8765/', 'abc')).toBe('http://127.0.0.1:8765/#cockpit=abc');
    expect(linkTo('https://localhost/app?x=1#old', 'abc')).toBe(
      'https://localhost/app?x=1#cockpit=abc',
    );
  });

  it.each(['/relative', 'not a url', 'file:///etc/passwd', 'javascript:alert(1)'])(
    'refuses %j: invalid-options',
    (pageUrl) => {
      expect(() => linkTo(pageUrl, 'abc')).toThrow(
        expect.objectContaining({ code: 'invalid-options' }),
      );
    },
  );
});

describe('the machine', () => {
  it('runs on Linux', () => {
    expect(() => checkPlatform('linux')).not.toThrow();
  });

  it.each(['darwin', 'win32'] as const)('refuses %s: unsupported-machine', (platform) => {
    expect(() => checkPlatform(platform)).toThrow(
      expect.objectContaining({
        code: 'unsupported-machine',
        what: 'platform',
        found: platform,
        required: 'linux',
      }),
    );
  });
});
