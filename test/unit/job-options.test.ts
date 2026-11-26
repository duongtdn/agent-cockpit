import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { checkChoices, choicesOf, optionKindsOf } from '../../src/server/job-options.ts';
import type { Job } from '../../src/server/jobs.ts';
import { isCockpitError } from '../../src/shared/cockpit-error.ts';

const CHAPTERS: Record<string, string[]> = { alpha: ['one', 'two'], beta: ['three'] };

const args = z
  .object({
    book: z.string().min(1),
    chapter: z.string(),
    tag: z.string().optional(),
    pages: z.number().int().default(10),
  })
  .strict()
  .refine(({ book, chapter }) => book !== chapter, 'A chapter is not its book.');

const chapterSource = vi.fn(({ book }: { book?: string }) =>
  (CHAPTERS[book ?? ''] ?? []).map((value) => ({ value, label: value.toUpperCase() })),
);

function draftChapter(): Job<typeof args> {
  return {
    id: 'draft-chapter',
    title: 'Draft a chapter',
    args,
    options: {
      book: async () => [{ value: 'alpha', label: 'Alpha' }, { value: 'beta' }],
      chapter: chapterSource,
      tag: { choices: () => [{ value: 'draft' }, { value: 'final' }], suggestions: true },
    },
    key: ({ book, chapter }) => `chapter-${book}-${chapter}`,
  };
}

const job = () => draftChapter() as unknown as Job;

/** The job with one field's source replaced, as an app in JavaScript may give it. */
function withSource(field: string, source: unknown): Job {
  const base = draftChapter();
  return { ...base, options: { ...base.options, [field]: source } } as unknown as Job;
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => expect.unreachable('expected a refusal'),
    (error: unknown) => error,
  );
}

describe('the kinds of option a job offers', () => {
  it('names each field with a source, choices or suggestions, in the order given', () => {
    expect(optionKindsOf(job())).toEqual({
      book: 'choices',
      chapter: 'choices',
      tag: 'suggestions',
    });
    expect(Object.keys(optionKindsOf(job()))).toEqual(['book', 'chapter', 'tag']);
  });

  it('names none for a job without sources, or a source left undefined', () => {
    expect(optionKindsOf({ ...job(), options: undefined } as unknown as Job)).toEqual({});
    expect(optionKindsOf(withSource('book', undefined))).toEqual({
      chapter: 'choices',
      tag: 'suggestions',
    });
  });
});

describe("reading a field's choices", () => {
  it('gives the choices of a source, sync or async', async () => {
    expect(await choicesOf(job(), 'book', {})).toEqual([
      { value: 'alpha', label: 'Alpha' },
      { value: 'beta' },
    ]);
    expect(await choicesOf(job(), 'tag', undefined)).toEqual([
      { value: 'draft' },
      { value: 'final' },
    ]);
  });

  it('gives dependent choices from the arguments so far, as the partial schema gave them', async () => {
    chapterSource.mockClear();

    expect(await choicesOf(job(), 'chapter', { book: 'alpha' })).toEqual([
      { value: 'one', label: 'ONE' },
      { value: 'two', label: 'TWO' },
    ]);
    expect(chapterSource).toHaveBeenCalledWith({ book: 'alpha', pages: 10 });
  });

  it('never shows a source the value of its own field, as at a run', async () => {
    chapterSource.mockClear();

    await choicesOf(job(), 'chapter', { book: 'beta', chapter: 'thr' });

    expect(chapterSource).toHaveBeenCalledWith({ book: 'beta', pages: 10 });
  });

  it('takes no arguments so far as none filled', async () => {
    chapterSource.mockClear();

    expect(await choicesOf(job(), 'chapter')).toEqual([]);
    expect(chapterSource).toHaveBeenCalledWith({ pages: 10 });
  });

  it('refuses a field with no source: invalid-arguments, its path the field', async () => {
    for (const field of ['pages', 'nothing']) {
      expect(await refusal(choicesOf(job(), field, {}))).toMatchObject({
        code: 'invalid-arguments',
        issues: [{ path: [field], message: expect.stringContaining('no option source') }],
      });
    }
  });

  it.each([
    ['a filled field that does not fit', { book: '' }, ['book']],
    ['a field the schema does not have', { volume: 2 }, []],
    ['no object', 'alpha', []],
  ])(
    'refuses arguments so far with %s, before the source sees them: invalid-arguments',
    async (_, argsSoFar, path) => {
      chapterSource.mockClear();

      expect(await refusal(choicesOf(job(), 'chapter', argsSoFar))).toMatchObject({
        code: 'invalid-arguments',
        issues: [{ path }],
      });
      expect(chapterSource).not.toHaveBeenCalled();
    },
  );

  it('does not hold arguments so far to the rules across fields, which need them all', async () => {
    expect(await choicesOf(job(), 'tag', { book: 'same', chapter: 'same' })).toHaveLength(2);
  });

  it("rejects with what the source throws or rejects with, as the app's own failure", async () => {
    const thrown = new Error('the books are offline');

    for (const source of [
      () => {
        throw thrown;
      },
      () => Promise.reject(thrown),
    ]) {
      await expect(choicesOf(withSource('book', source), 'book', {})).rejects.toBe(thrown);
    }
  });

  it.each([
    ['no list', 'alpha', []],
    ['a bare value', ['alpha'], [0]],
    ['a value of no kind a field takes', [{ value: { id: 1 } }], [0, 'value']],
    ['a label that is no text', [{ value: 'alpha', label: 1 }], [0, 'label']],
  ])('refuses choices that are %s: invalid-options, naming the source', async (_, given, at) => {
    const error = await refusal(
      choicesOf(
        withSource('book', () => given),
        'book',
        {},
      ),
    );

    expect(isCockpitError(error, 'invalid-options')).toBe(true);
    expect(error).toMatchObject({ issues: [{ path: ['options', 'book', ...at] }] });
    expect((error as Error).message).toContain('draft-chapter');
  });

  it('gives each choice as a choice, nothing more', async () => {
    const source = () => [{ value: 3, label: 'Three', extra: true }, { value: false }];

    expect(await choicesOf(withSource('book', source), 'book', {})).toEqual([
      { value: 3, label: 'Three' },
      { value: false },
    ]);
  });
});

describe("a run's values against their sources", () => {
  const run = { book: 'alpha', chapter: 'two', pages: 10 };

  it('passes values among their choices, each source called with the other arguments', async () => {
    chapterSource.mockClear();

    await expect(checkChoices(job(), run)).resolves.toBeUndefined();
    expect(chapterSource).toHaveBeenCalledWith({ book: 'alpha', pages: 10 });
  });

  it('refuses a value not among the choices: not-a-choice, with the field and the value', async () => {
    expect(await refusal(checkChoices(job(), { ...run, book: 'gamma' }))).toMatchObject({
      code: 'not-a-choice',
      field: 'book',
      value: 'gamma',
    });
    expect(await refusal(checkChoices(job(), { ...run, book: 'beta' }))).toMatchObject({
      code: 'not-a-choice',
      field: 'chapter',
      value: 'two',
    });
  });

  it('compares values exactly: a number is not its text', async () => {
    const pages = () => [{ value: 10 }];

    await expect(checkChoices(withSource('pages', pages), run)).resolves.toBeUndefined();
    expect(
      await refusal(checkChoices(withSource('pages', pages), { ...run, pages: '10' })),
    ).toMatchObject({
      code: 'not-a-choice',
      field: 'pages',
    });
  });

  it('accepts any value of a field whose source only suggests', async () => {
    await expect(checkChoices(job(), { ...run, tag: 'anything' })).resolves.toBeUndefined();
  });

  it('does not check a field left out', async () => {
    const book = vi.fn(() => []);

    await expect(checkChoices(withSource('tag', book), run)).resolves.toBeUndefined();
    expect(book).not.toHaveBeenCalled();
  });

  it('rejects with what a source throws, and refuses choices that do not fit', async () => {
    const thrown = new Error('offline');

    await expect(
      checkChoices(
        withSource('book', () => Promise.reject(thrown)),
        run,
      ),
    ).rejects.toBe(thrown);
    expect(
      await refusal(
        checkChoices(
          withSource('book', () => 'alpha'),
          run,
        ),
      ),
    ).toMatchObject({
      code: 'invalid-options',
    });
  });
});
