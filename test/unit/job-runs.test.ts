import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Job } from '../../src/server/jobs.ts';
import { createJobRuns, type JobRuns } from '../../src/server/sessions/job-runs.ts';
import type { Issue } from '../../src/shared/cockpit-error.ts';

// Real paths throughout: the temporary folder may itself lie behind a link.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'job-runs-')));
const app = join(root, 'app');
afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeAll(() => {
  mkdirSync(join(app, 'books'), { recursive: true });
  mkdirSync(join(root, 'outside'));
  symlinkSync(join(root, 'outside'), join(app, 'out'));
});

const PART = { permissionMode: 'plan' };

const explain: Job = {
  id: 'explain',
  title: 'Explain a file',
  args: z.object({ book: z.string(), file: z.string() }),
  key: (args) => `explain-${(args as { file: string }).file}`,
  prompt: (args) => `Explain ${(args as { file: string }).file}.`,
  options: {
    file: () => [{ value: 'a' }, { value: 'b' }],
  },
  directory: (args) => `books/${(args as { book: string }).book}`,
  driver: PART,
} as Job;

const typing: Job = {
  id: 'typing',
  title: 'Work in the app',
  args: z.object({}),
  key: () => 'typing',
  fresh: true,
};

const escaping: Job = {
  id: 'escaping',
  title: 'Escape',
  args: z.object({}),
  key: () => 'escaping',
  directory: () => 'out/deep',
};

/** A job whose schema transforms what it is given: a page number from a text, a path from a name. */
const page: Job = {
  id: 'page',
  title: 'Explain a page',
  args: z.object({
    page: z.string().transform(Number),
    file: z.string().transform((name) => `/srv/books/${name}`),
  }),
  key: (args) => `page-${(args as { page: number }).page}`,
  prompt: (args) =>
    `Explain page ${(args as { page: number }).page} of ${(args as { file: string }).file}.`,
  options: { page: () => [{ value: 3 }] },
  directory: (args) => `books/p${(args as { page: number }).page}`,
} as Job;

function runsWith(partIssues: (job: Job) => readonly Issue[] = () => []): JobRuns {
  return createJobRuns({
    jobs: new Map([explain, typing, escaping, page].map((job) => [job.id, job])),
    appFolder: app,
    partIssues,
  });
}

describe("a run's job, read with every check of a run", () => {
  it('gives the key and the prompt at once', () => {
    expect(runsWith().read('explain', { book: 'alpha', file: 'a' })).toMatchObject({
      key: 'explain-a',
      prompt: 'Explain a.',
    });
    expect(runsWith().read('typing', {})).not.toHaveProperty('prompt');
  });

  it('gives the key, prompt, driver part, parsed arguments, folder and whether the job starts fresh', async () => {
    await expect(
      runsWith().read('explain', { book: 'alpha', file: 'a' }).checked(),
    ).resolves.toEqual({
      jobId: 'explain',
      key: 'explain-a',
      prompt: 'Explain a.',
      part: PART,
      args: { book: 'alpha', file: 'a' },
      folder: { path: join(app, 'books', 'alpha'), relative: join('books', 'alpha') },
      fresh: false,
    });
    await expect(runsWith().read('typing', {}).checked()).resolves.toEqual({
      jobId: 'typing',
      key: 'typing',
      args: {},
      folder: { path: app, relative: '.' },
      fresh: true,
    });
  });

  it('keeps the arguments as given, the schema’s input: its output is what the key, prompt, choices and folder read', async () => {
    const runs = runsWith();
    const given = { page: '3', file: 'alpha.md' };

    const run = await runs.read('page', given).checked();

    expect(run).toMatchObject({
      key: 'page-3',
      prompt: 'Explain page 3 of /srv/books/alpha.md.',
      args: given,
      folder: { relative: join('books', 'p3') },
    });
    // Read again, as an open or a send reads the last run, the arguments fit as they did.
    await expect(runs.read('page', run.args).checked()).resolves.toEqual(run);
  });

  it('makes no folder', async () => {
    await runsWith().read('explain', { book: 'alpha', file: 'a' }).checked();

    expect(existsSync(join(app, 'books', 'alpha'))).toBe(false);
  });

  it('refuses an unknown job and arguments that do not fit at once, a value not among its choices once checked', async () => {
    const runs = runsWith();

    expect(() => runs.read('nothing', {})).toThrow(
      expect.objectContaining({ code: 'unknown-job' }),
    );
    expect(() => runs.read('explain', { book: 1 })).toThrow(
      expect.objectContaining({ code: 'invalid-arguments' }),
    );
    await expect(
      runs.read('explain', { book: 'alpha', file: 'c' }).checked(),
    ).rejects.toMatchObject({
      code: 'not-a-choice',
      field: 'file',
      value: 'c',
    });
  });

  it("refuses a job whose driver part does not fit as it is launched, naming the job's issues", async () => {
    const issue = { path: ['driver'], message: 'Opened beyond loopback.' };
    const runs = runsWith((job) => (job.id === 'explain' ? [issue] : []));

    expect(() => runs.read('explain', { book: 'alpha', file: 'a' })).toThrow(
      expect.objectContaining({ code: 'invalid-options', issues: [issue] }),
    );
  });

  it("refuses a folder outside the app's", async () => {
    await expect(runsWith().read('escaping', {}).checked()).rejects.toMatchObject({
      code: 'folder-outside-app',
    });
  });
});

describe("a run's folder", () => {
  it('is made at a start, and checked again', async () => {
    const runs = runsWith();
    const { folder } = await runs.read('explain', { book: 'beta', file: 'a' }).checked();

    await expect(runs.makeFolder(folder)).resolves.toEqual(folder);
    expect(existsSync(join(app, 'books', 'beta'))).toBe(true);
  });

  it("is found from the record's relative path, inside the app's folder", async () => {
    await expect(runsWith().recordedFolder('books')).resolves.toEqual({
      path: join(app, 'books'),
      relative: 'books',
    });
    await expect(runsWith().recordedFolder('out')).rejects.toMatchObject({
      code: 'folder-outside-app',
    });
  });
});
