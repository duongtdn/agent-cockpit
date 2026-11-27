import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { claudeCode } from '../../src/claude-code/index.ts';
import { jobDefinitionIssues } from '../../src/server/job-definitions.ts';
import { issuesOf, type Job, jobOf, launchOfJob } from '../../src/server/jobs.ts';

const chapterArgs = z.object({
  book: z.string().meta({ label: 'Book' }),
  chapter: z.string(),
});

const draftChapter: Job<typeof chapterArgs> = {
  id: 'draft-chapter',
  title: 'Draft a chapter',
  args: chapterArgs,
  options: {
    book: () => [{ value: 'alpha' }],
    chapter: { choices: () => [{ value: 'one' }], suggestions: true },
  },
  key: ({ book, chapter }) => `chapter-${book}-${chapter}`,
  prompt: ({ book, chapter }) => `/draft ${book} ${chapter}`,
  directory: ({ book }) => `books/${book}`,
  fresh: true,
};

/** A job as an app in JavaScript may give it: any field, of any kind. */
function jobWith(fields: Record<string, unknown>): Job {
  return { ...draftChapter, ...fields } as unknown as Job;
}

describe("a job's definition, checked at createCockpit", () => {
  it('passes with option sources, suggestions, a folder and fresh', () => {
    expect(jobDefinitionIssues(draftChapter as unknown as Job)).toEqual([]);
  });

  it('passes with none of them', () => {
    expect(
      jobDefinitionIssues(jobWith({ options: undefined, directory: undefined, fresh: undefined })),
    ).toEqual([]);
  });

  it('passes an object schema with refinements across its fields', () => {
    const args = chapterArgs.refine(({ book, chapter }) => book !== chapter);

    expect(jobDefinitionIssues(jobWith({ args }))).toEqual([]);
  });

  it.each([
    ['a string', z.string()],
    ['a union of objects', z.union([chapterArgs, z.object({ other: z.string() })])],
    ['an object piped through a transform', chapterArgs.transform((args) => args)],
  ])('refuses arguments that are %s: the arguments must be an object schema', (_, args) => {
    expect(jobDefinitionIssues(jobWith({ args, options: undefined }))).toEqual([
      { path: ['args'], message: expect.stringContaining('object schema') },
    ]);
  });

  it.each([
    ['a date', z.date()],
    ['a custom type', z.custom<string>(() => true)],
    ['a bigint', z.bigint()],
    ['a bare transform', z.transform((value) => value)],
  ])('refuses a schema JSON Schema cannot describe: a field of %s', (_, field) => {
    const issues = jobDefinitionIssues(jobWith({ args: z.object({ when: field }), options: {} }));

    expect(issues).toEqual([
      { path: ['args'], message: expect.stringContaining('JSON Schema cannot describe') },
    ]);
  });

  it('refuses an option source for a field the schema does not have', () => {
    const issues = jobDefinitionIssues(jobWith({ options: { book: () => [], volume: () => [] } }));

    expect(issues).toEqual([
      { path: ['options', 'volume'], message: expect.stringContaining('no field') },
    ]);
  });

  it.each([
    ['a list', ['alpha']],
    ['an object with no choices', { suggestions: true }],
    ['suggestions not true', { choices: () => [], suggestions: false }],
    ['choices that are no function', { choices: ['alpha'], suggestions: true }],
    ['a field of a later version', { choices: () => [], suggestions: true, multiple: true }],
  ])('refuses a source that is %s', (_, source) => {
    expect(jobDefinitionIssues(jobWith({ options: { book: source } }))).toEqual([
      { path: ['options', 'book'], message: expect.stringContaining('option source') },
    ]);
  });

  it('takes a field whose source is left undefined as a field with none', () => {
    expect(jobDefinitionIssues(jobWith({ options: { book: undefined } }))).toEqual([]);
  });

  it('refuses options that are no object', () => {
    expect(jobDefinitionIssues(jobWith({ options: [() => []] }))).toEqual([
      { path: ['options'], message: expect.any(String) },
    ]);
  });

  it('refuses a folder that is no function, and fresh other than true', () => {
    expect(jobDefinitionIssues(jobWith({ directory: 'books', fresh: false }))).toEqual([
      { path: ['directory'], message: expect.any(String) },
      { path: ['fresh'], message: expect.any(String) },
    ]);
  });

  it('gives every issue at once', () => {
    const issues = jobDefinitionIssues(
      jobWith({ args: z.object({ when: z.date() }), options: { book: 1 }, fresh: 'yes' }),
    );

    expect(issues.map(({ path }) => path)).toEqual([['args'], ['options', 'book'], ['fresh']]);
  });
});

describe('the launch of a run', () => {
  const jobs = new Map<string, Job>([[draftChapter.id, draftChapter as unknown as Job]]);
  const args = { book: 'alpha', chapter: 'one' };

  it('gives the key and the prompt from the arguments the schema gave', () => {
    expect(launchOfJob(jobOf(jobs, 'draft-chapter'), args)).toEqual({
      key: 'chapter-alpha-one',
      prompt: '/draft alpha one',
      args,
    });
  });

  it('gives no prompt for a job for typing', () => {
    expect(launchOfJob(jobWith({ prompt: undefined }), args)).toEqual({
      key: 'chapter-alpha-one',
      args,
    });
  });

  it("carries the job's driver part, as the job gives it", () => {
    const part = claudeCode.job({ permissionMode: 'acceptEdits' });

    expect(launchOfJob(jobWith({ driver: part }), args)).toMatchObject({ part });
  });

  it('refuses an id no job has: unknown-job', () => {
    expect(() => jobOf(jobs, 'nothing')).toThrow(
      expect.objectContaining({ code: 'unknown-job', jobId: 'nothing' }),
    );
  });

  it('refuses arguments the schema refuses: invalid-arguments, each issue with its path', () => {
    expect(() => launchOfJob(jobWith({}), { book: 'alpha' })).toThrow(
      expect.objectContaining({
        code: 'invalid-arguments',
        issues: [{ path: ['chapter'], message: expect.any(String) }],
      }),
    );
  });

  it('writes a symbol in a path as its description', () => {
    expect(
      issuesOf([{ code: 'custom', input: 1, path: ['a', 0, Symbol('where')], message: 'no' }]),
    ).toEqual([{ path: ['a', 0, 'where'], message: 'no' }]);
  });

  it('gives the arguments as the schema gave them, beside the key and the prompt', () => {
    const args = z.object({ count: z.string().transform(Number) });
    const job = jobWith({ args, options: undefined, key: () => 'count', prompt: undefined });

    expect(launchOfJob(job, { count: '3' })).toEqual({ key: 'count', args: { count: 3 } });
  });

  it.each(['', 'Chapter-1', 'chapter_1', 'chapter 1', 'chapter/1', 'é'])(
    'refuses a key %j the job gives that is not of the form [a-z0-9-]+: invalid-options',
    (key) => {
      expect(() => launchOfJob(jobWith({ key: () => key }), { book: 'a', chapter: 'b' })).toThrow(
        expect.objectContaining({
          code: 'invalid-options',
          issues: [{ path: ['key'], message: expect.stringContaining('[a-z0-9-]+') }],
        }),
      );
    },
  );

  it('refuses a key the job gives of more than 100 characters: invalid-options', () => {
    const key = 'a'.repeat(101);
    expect(() => launchOfJob(jobWith({ key: () => key }), { book: 'a', chapter: 'b' })).toThrow(
      expect.objectContaining({
        code: 'invalid-options',
        issues: [{ path: ['key'], message: expect.stringContaining('100 characters at most') }],
      }),
    );
  });

  it('refuses a key that is no text: invalid-options', () => {
    expect(() => launchOfJob(jobWith({ key: () => 7 }), { book: 'a', chapter: 'b' })).toThrow(
      expect.objectContaining({ code: 'invalid-options' }),
    );
  });
});
