import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { claudeCode } from '../../src/claude-code/index.ts';
import { checkCockpitOptions } from '../../src/server/cockpit-options.ts';
import { checkPlatform, linkTo } from '../../src/server/create-cockpit.ts';
import { issuesOf, type Job, launchOfJob } from '../../src/server/jobs.ts';
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
    });

    expect(issues.map(({ path }) => path).sort()).toEqual(
      [['agentPort'], ['directory'], ['driver'], ['jobs'], ['name'], ['stateDirectory']].sort(),
    );
  });

  it.each([
    'channel',
    'port',
    'hiddenEnv',
    'idleTimeout',
    'maxSessions',
    'elicitations',
    'authorize',
    'origins',
    'terminal',
    'typo',
  ])('refuse %s, an option this version does not take, rather than ignore it', async (name) => {
    expect(await optionIssues({ ...valid(), [name]: undefined })).toEqual([
      { path: [name], message: 'Not an option of this version of the cockpit.' },
    ]);
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

  it.each(['options', 'directory', 'fresh', 'driver'])(
    'refuse a job’s %s, a field this version does not take',
    async (field) => {
      expect(await optionIssues({ ...valid(), jobs: [{ ...explain, [field]: true }] })).toEqual([
        { path: ['jobs', 0, field], message: 'Not a job field of this version of the cockpit.' },
      ]);
    },
  );

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

describe('a run of a job', () => {
  const jobs = new Map<string, Job>([[explain.id, explain as unknown as Job]]);

  it('gives the key and the prompt from the arguments the schema gave', () => {
    expect(launchOfJob(jobs, 'explain', { file: 'README.md' })).toEqual({
      key: 'explain-readme-md',
      prompt: 'Explain README.md',
    });
  });

  it('gives no prompt for a job for typing', () => {
    const typing = { ...explain, id: 'type' } as Partial<typeof explain>;
    delete typing.prompt;

    expect(
      launchOfJob(new Map([['type', typing as unknown as Job]]), 'type', { file: 'a' }),
    ).toEqual({
      key: 'explain-a',
    });
  });

  it('refuses an id no job has: unknown-job', () => {
    expect(() => launchOfJob(jobs, 'nothing', {})).toThrow(
      expect.objectContaining({ code: 'unknown-job', jobId: 'nothing' }),
    );
  });

  it('refuses arguments the schema refuses: invalid-arguments, each issue with its path', () => {
    expect(() => launchOfJob(jobs, 'explain', { file: '' })).toThrow(
      expect.objectContaining({
        code: 'invalid-arguments',
        issues: [{ path: ['file'], message: expect.any(String) }],
      }),
    );
  });

  it('writes a symbol in a path as its description', () => {
    expect(
      issuesOf([{ code: 'custom', input: 1, path: ['a', 0, Symbol('where')], message: 'no' }]),
    ).toEqual([{ path: ['a', 0, 'where'], message: 'no' }]);
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
