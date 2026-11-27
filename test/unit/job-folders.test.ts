import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  checkRecordedFolder,
  folderInsideApp,
  folderOfJob,
  makeJobFolder,
} from '../../src/server/job-folders.ts';
import type { Job } from '../../src/server/jobs.ts';

// Real paths throughout: the temporary folder may itself lie behind a link.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'job-folders-')));
const app = join(root, 'app');
const outside = join(root, 'outside');
afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeAll(() => {
  mkdirSync(join(app, 'books', 'alpha'), { recursive: true });
  mkdirSync(join(app, 'links'), { recursive: true });
  mkdirSync(join(outside, 'deep'), { recursive: true });
  mkdirSync(join(root, 'app-sibling'));
  symlinkSync(outside, join(app, 'links', 'out'));
  symlinkSync(join(app, 'books', 'alpha'), join(app, 'shortcut'));
  symlinkSync(app, join(root, 'app-link'));
  writeFileSync(join(app, 'a-file'), '');
});

const args = z.object({ folder: z.string() });

function jobIn(directory?: (args: { folder: string }) => unknown): Job {
  return {
    id: 'work',
    title: 'Work in a folder',
    args,
    key: () => 'work',
    ...(directory === undefined ? {} : { directory }),
  } as unknown as Job;
}

const inFolder = jobIn(({ folder }) => folder);

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => expect.unreachable('expected a refusal'),
    (error: unknown) => error,
  );
}

describe("a job's folder", () => {
  it("is the app's folder when the job names none", async () => {
    expect(await folderOfJob(app, jobIn(), { folder: 'x' })).toEqual({ path: app, relative: '.' });
  });

  it("is the job's folder, relative to the app's, as its real path", async () => {
    expect(await folderOfJob(app, inFolder, { folder: 'books/alpha' })).toEqual({
      path: join(app, 'books', 'alpha'),
      relative: 'books/alpha',
    });
    expect(await folderOfJob(app, inFolder, { folder: './books/../books/alpha/' })).toEqual({
      path: join(app, 'books', 'alpha'),
      relative: 'books/alpha',
    });
  });

  it("is the app's own when the job gives an empty path or `.`", async () => {
    for (const folder of ['', '.']) {
      expect(await folderOfJob(app, inFolder, { folder })).toEqual({ path: app, relative: '.' });
    }
  });

  it('follows a link that stays inside to the folder it leads to', async () => {
    expect(await folderOfJob(app, inFolder, { folder: 'shortcut' })).toEqual({
      path: join(app, 'books', 'alpha'),
      relative: 'books/alpha',
    });
  });

  it("measures against the app's real folder when the app's is given through a link", async () => {
    expect(await folderOfJob(join(root, 'app-link'), inFolder, { folder: 'books/alpha' })).toEqual({
      path: join(app, 'books', 'alpha'),
      relative: 'books/alpha',
    });
  });

  it('takes an absolute path inside the app’s folder as that folder', async () => {
    expect(await folderOfJob(app, inFolder, { folder: join(app, 'books') })).toEqual({
      path: join(app, 'books'),
      relative: 'books',
    });
  });

  it('gives a missing folder as the real path it will have, creating nothing', async () => {
    expect(await folderOfJob(app, inFolder, { folder: 'books/beta/notes' })).toEqual({
      path: join(app, 'books', 'beta', 'notes'),
      relative: 'books/beta/notes',
    });
    expect(existsSync(join(app, 'books', 'beta'))).toBe(false);
  });

  it.each([
    ['the parent', '..'],
    ['a sibling whose name starts as the app’s', '../app-sibling'],
    ['a climb out and back that the path spells', 'books/../../outside'],
    ['an absolute path outside', '/etc'],
    ['a link leading out', 'links/out'],
    ['a folder below a link leading out', 'links/out/deep'],
    ['a missing folder below a link leading out', 'links/out/new/deeper'],
  ])(
    'refuses %s: folder-outside-app, naming the folder the job gave and no path of the server',
    async (_, folder) => {
      const error = await refusal(folderOfJob(app, inFolder, { folder }));

      expect(error).toMatchObject({ code: 'folder-outside-app', folder });
      expect((error as Error).message).not.toContain(root);
    },
  );

  it('refuses a folder that is no text: invalid-options, naming the job', async () => {
    const error = await refusal(
      folderOfJob(
        app,
        jobIn(() => 7),
        { folder: 'x' },
      ),
    );

    expect(error).toMatchObject({ code: 'invalid-options', issues: [{ path: ['directory'] }] });
    expect((error as Error).message).toContain('work');
  });
});

describe('a recorded folder, at a later launch', () => {
  it('is its real path inside the app’s folder', async () => {
    expect(await folderInsideApp(app, 'books/alpha')).toEqual({
      path: join(app, 'books', 'alpha'),
      relative: 'books/alpha',
    });
  });

  it('is refused once a link took it out of the app’s folder: folder-outside-app', async () => {
    expect(await refusal(folderInsideApp(app, 'links/out'))).toMatchObject({
      code: 'folder-outside-app',
      folder: 'links/out',
    });
  });
});

describe('the folder bound to its unit of work', () => {
  const computed = { path: join(app, 'books', 'alpha'), relative: 'books/alpha' };

  it('passes when nothing is recorded yet, or the same folder is', () => {
    expect(() => checkRecordedFolder(undefined, computed)).not.toThrow();
    expect(() => checkRecordedFolder('books/alpha', computed)).not.toThrow();
  });

  it('refuses another folder: folder-changed, with the recorded and the computed', () => {
    expect(() => checkRecordedFolder('books/beta', computed)).toThrow(
      expect.objectContaining({
        code: 'folder-changed',
        recorded: 'books/beta',
        computed: 'books/alpha',
      }),
    );
  });
});

describe("making a job's folder", () => {
  it('creates a missing folder and gives its real path', async () => {
    const folder = await folderOfJob(app, inFolder, { folder: 'made/one/two' });

    expect(await makeJobFolder(app, folder)).toEqual({
      path: join(app, 'made', 'one', 'two'),
      relative: 'made/one/two',
    });
    expect(existsSync(join(app, 'made', 'one', 'two'))).toBe(true);
  });

  it('leaves an existing folder as it is', async () => {
    const folder = await folderOfJob(app, inFolder, { folder: 'books/alpha' });

    expect(await makeJobFolder(app, folder)).toEqual(folder);
  });

  it('checks the folder again once made: one a link took out meanwhile is refused', async () => {
    const folder = await folderOfJob(app, inFolder, { folder: 'moved/sub' });
    symlinkSync(outside, join(app, 'moved'));

    expect(await refusal(makeJobFolder(app, folder))).toMatchObject({
      code: 'folder-outside-app',
      folder: 'moved/sub',
    });
  });

  it('rejects when a file stands where the folder goes', async () => {
    const folder = await folderOfJob(app, inFolder, { folder: 'a-file/sub' });

    await expect(makeJobFolder(app, folder)).rejects.toThrow();
  });
});
