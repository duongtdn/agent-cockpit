import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { claudeCode } from '../../src/claude-code/index.ts';
import { describeJob } from '../../src/server/job-descriptions.ts';
import type { Job } from '../../src/server/jobs.ts';

const args = z.object({
  book: z.string().meta({ label: 'Book', hint: 'a mapped book' }),
  chapter: z.string().meta({ label: 'Chapter' }),
  level: z.enum(['short', 'long']).optional(),
  pages: z.number().int().default(10),
  words: z.string().transform(Number).optional(),
  tag: z.string().optional(),
});

const draftChapter: Job<typeof args> = {
  id: 'draft-chapter',
  title: 'Draft a chapter',
  description: 'Writes the first draft of a chapter.',
  args,
  options: {
    book: () => [],
    chapter: () => [],
    tag: { choices: () => [], suggestions: true },
  },
  key: ({ book, chapter }) => `chapter-${book}-${chapter}`,
  prompt: ({ book, chapter }) => `/draft ${book} ${chapter}`,
  directory: ({ book }) => `books/${book}`,
  fresh: true,
  driver: claudeCode.job({ permissionMode: 'acceptEdits' }),
};

const describe_ = (job: Job<typeof args>) => describeJob(job as unknown as Job);

describe("a job's description, for the browser", () => {
  it('gives the id, the title, the description, which fields have sources and that it has a prompt', () => {
    const { schema: _, ...rest } = describe_(draftChapter);

    expect(rest).toEqual({
      id: 'draft-chapter',
      title: 'Draft a chapter',
      description: 'Writes the first draft of a chapter.',
      options: { book: 'choices', chapter: 'choices', tag: 'suggestions' },
      hasPrompt: true,
    });
  });

  it('gives the schema as JSON Schema of its input, labels and hints on their fields', () => {
    expect(describe_(draftChapter).schema).toMatchObject({
      type: 'object',
      properties: {
        book: { type: 'string', label: 'Book', hint: 'a mapped book' },
        chapter: { type: 'string', label: 'Chapter' },
        level: { type: 'string', enum: ['short', 'long'] },
        pages: { type: 'integer', default: 10 },
        words: { type: 'string' },
        tag: { type: 'string' },
      },
      required: ['book', 'chapter'],
    });
  });

  it('is JSON, and carries no key, prompt, folder, fresh or driver part', () => {
    const description = describe_(draftChapter);

    expect(JSON.parse(JSON.stringify(description))).toEqual(description);
    expect(Object.keys(description).sort()).toEqual(
      ['description', 'hasPrompt', 'id', 'options', 'schema', 'title'].sort(),
    );
  });

  it('says a job for typing has no prompt, and leaves out what the job does not give', () => {
    const { prompt: _, description: __, options: ___, ...typing } = draftChapter;
    const description = describe_(typing);

    expect(description.hasPrompt).toBe(false);
    expect(description.options).toEqual({});
    expect('description' in description).toBe(false);
  });
});
