import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UntrustedStateError } from '../../src/server/state/own-files.ts';
import { openRecordStore, type UnitRecord } from '../../src/server/state/records.ts';

/** Paths the file system says another user owns. */
const foreign = vi.hoisted(() => new Set<string>());

/** Paths whose next rename fails, as a full disk or a crash before it would. */
const failingRenames = vi.hoisted(() => new Set<string>());

/** Paths whose next deletion fails, as a folder the user can no longer write. */
const failingRemovals = vi.hoisted(() => new Set<string>());

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    lstat: async (path: string) => {
      const found = await fs.lstat(path);
      return foreign.has(String(path))
        ? Object.assign(Object.create(Object.getPrototypeOf(found)), found, { uid: 4242 })
        : found;
    },
    rename: async (from: string, to: string) => {
      if (failingRenames.delete(String(to))) {
        throw Object.assign(new Error(`ENOSPC: ${to}`), { code: 'ENOSPC' });
      }
      return fs.rename(from, to);
    },
    rm: async (path: string, options?: Parameters<typeof fs.rm>[1]) => {
      if (failingRemovals.delete(String(path))) {
        throw Object.assign(new Error(`EACCES: ${path}`), { code: 'EACCES' });
      }
      return fs.rm(path, options);
    },
  };
});

let folder: string;
let records: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'cockpit-records-'));
  records = join(folder, 'records');
});

afterEach(() => {
  foreign.clear();
  failingRenames.clear();
  failingRemovals.clear();
  rmSync(folder, { recursive: true, force: true });
});

const modeOf = (path: string) => statSync(path).mode & 0o777;

function aRecord(key: string, changes: Partial<UnitRecord> = {}): UnitRecord {
  return {
    key,
    conversationId: `conversation-of-${key}`,
    earlierConversations: [],
    history: [
      {
        operation: 'run',
        jobId: 'explain',
        args: { file: 'src/a.ts', depth: 2 },
        at: '2026-11-27T10:00:00.000Z',
        action: 'started',
        conversationId: `conversation-of-${key}`,
      },
    ],
    directory: '.',
    launchSettings: { permissionMode: 'plan', allow: ['Read'], sandbox: null },
    ...changes,
  };
}

/** A record's file as the store writes it, for a test that plants one. */
function fileOf(record: UnitRecord, order = 1): string {
  return JSON.stringify({ version: 1, order, record });
}

function plant(name: string, content: string, mode = 0o600): string {
  mkdirSync(records, { recursive: true, mode: 0o700 });
  const path = join(records, name);
  writeFileSync(path, content, { mode });
  return path;
}

describe('opening the record store', () => {
  it('starts empty, its folder made for the app’s user alone', async () => {
    const store = await openRecordStore(folder);
    expect(store.list()).toEqual([]);
    expect(store.get('a')).toBeUndefined();
    expect(modeOf(records)).toBe(0o700);
  });

  it('loads the records an earlier store kept, as they were put', async () => {
    const first = await openRecordStore(folder);
    const a = aRecord('a', {
      earlierConversations: ['older'],
      history: [
        ...aRecord('a').history,
        {
          operation: 'open',
          jobId: 'explain',
          args: { file: 'src/a.ts', depth: 2 },
          at: '2026-11-27T11:00:00.000Z',
          action: 'started',
          reason: 'conversation-gone',
          conversationId: 'conversation-of-a',
        },
      ],
    });
    await first.put(a);
    await first.put(aRecord('b', { directory: 'work/b' }));

    const second = await openRecordStore(folder);
    expect(second.get('a')).toEqual(a);
    expect(second.list()).toEqual([a, aRecord('b', { directory: 'work/b' })]);
  });

  it('refuses a record’s file that is a symbolic link, even to a record of the user’s', async () => {
    const elsewhere = join(folder, 'elsewhere');
    writeFileSync(elsewhere, fileOf(aRecord('a')), { mode: 0o600 });
    mkdirSync(records, { mode: 0o700 });
    symlinkSync(elsewhere, join(records, 'a.json'));
    await expect(openRecordStore(folder)).rejects.toThrow(UntrustedStateError);
  });

  it('refuses a record’s name that is no regular file', async () => {
    mkdirSync(join(records, 'a.json'), { recursive: true });
    await expect(openRecordStore(folder)).rejects.toThrow(UntrustedStateError);
  });

  it('refuses a record’s file of another user', async () => {
    foreign.add(plant('a.json', fileOf(aRecord('a'))));
    await expect(openRecordStore(folder)).rejects.toThrow(/belongs to another user/);
  });

  it('refuses a records folder that is a symbolic link', async () => {
    const elsewhere = join(folder, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, records);
    await expect(openRecordStore(folder)).rejects.toThrow(UntrustedStateError);
  });

  it('refuses a torn record, naming its file', async () => {
    const path = plant('a.json', fileOf(aRecord('a')).slice(0, 40));
    const opening = openRecordStore(folder);
    await expect(opening).rejects.toThrow(UntrustedStateError);
    await expect(opening).rejects.toMatchObject({ path });
  });

  it('refuses a file that holds no record the cockpit writes', async () => {
    plant('a.json', JSON.stringify({ version: 1, order: 1, record: { key: 'a' } }));
    await expect(openRecordStore(folder)).rejects.toThrow(UntrustedStateError);
  });

  it('refuses a record kept in the file of another key', async () => {
    plant('a.json', fileOf(aRecord('b')));
    await expect(openRecordStore(folder)).rejects.toThrow(/record of b/);
  });

  it('refuses a record of a version it does not know', async () => {
    plant('a.json', JSON.stringify({ version: 2, order: 1, record: aRecord('a') }));
    await expect(openRecordStore(folder)).rejects.toThrow(UntrustedStateError);
  });

  it('narrows a record’s file others had rights on to the user alone', async () => {
    const path = plant('a.json', fileOf(aRecord('a')), 0o644);
    chmodSync(path, 0o644);
    const store = await openRecordStore(folder);
    expect(store.get('a')).toEqual(aRecord('a'));
    expect(modeOf(path)).toBe(0o600);
  });

  it('removes what a write cut short left aside, keeping the record whole', async () => {
    plant('a.json', fileOf(aRecord('a')));
    plant(
      'a.json.0b6f1c52-4bd5-4a53-9a0e-3c8e9c1f2d7a',
      fileOf(aRecord('a', { conversationId: 'newer' })).slice(0, 50),
    );
    const store = await openRecordStore(folder);
    expect(store.get('a')).toEqual(aRecord('a'));
    expect(readdirSync(records)).toEqual(['a.json']);
  });

  it('leaves alone what is no record of its', async () => {
    plant('notes.txt', 'not a record');
    const store = await openRecordStore(folder);
    expect(store.list()).toEqual([]);
    expect(readdirSync(records)).toEqual(['notes.txt']);
  });
});

describe('putting a record', () => {
  it('keeps it in a file of its key for the app’s user alone, and nothing else', async () => {
    const store = await openRecordStore(folder);
    await store.put(aRecord('a'));
    expect(store.get('a')).toEqual(aRecord('a'));
    expect(readdirSync(records)).toEqual(['a.json']);
    expect(modeOf(join(records, 'a.json'))).toBe(0o600);
  });

  it('replaces the record the key had', async () => {
    const store = await openRecordStore(folder);
    await store.put(aRecord('a'));
    await store.put(aRecord('a', { conversationId: 'next', earlierConversations: ['first'] }));
    const replaced = aRecord('a', { conversationId: 'next', earlierConversations: ['first'] });
    expect(store.get('a')).toEqual(replaced);
    expect((await openRecordStore(folder)).get('a')).toEqual(replaced);
  });

  it('gives what a restarted store would read, not the object it was given', async () => {
    const store = await openRecordStore(folder);
    const record = { ...aRecord('a'), launchSettings: { model: 'opus', dropped: undefined } };
    await store.put(record as unknown as UnitRecord);
    record.launchSettings.model = 'changed afterwards';
    expect(store.get('a')?.launchSettings).toEqual({ model: 'opus' });
    expect(store.get('a')).toEqual((await openRecordStore(folder)).get('a'));
  });

  it('lists the records in the order their keys were first recorded, before and after a restart', async () => {
    const store = await openRecordStore(folder);
    await Promise.all(['c', 'a', 'b'].map((key) => store.put(aRecord(key))));
    await store.put(aRecord('a', { directory: 'moved' }));
    const keys = (list: readonly UnitRecord[]) => list.map((record) => record.key);
    expect(keys(store.list())).toEqual(['c', 'a', 'b']);
    const restarted = await openRecordStore(folder);
    expect(keys(restarted.list())).toEqual(['c', 'a', 'b']);
    await restarted.put(aRecord('d'));
    expect(keys(restarted.list())).toEqual(['c', 'a', 'b', 'd']);
  });

  it('refuses a key that could not name a file of its own, writing nothing', async () => {
    const store = await openRecordStore(folder);
    for (const key of ['../a', 'A', '', 'a/b', 'a.json']) {
      await expect(store.put(aRecord(key))).rejects.toThrow(TypeError);
      expect(store.get(key)).toBeUndefined();
    }
    expect(readdirSync(records)).toEqual([]);
  });

  it('refuses a record it could not read back, writing nothing', async () => {
    const store = await openRecordStore(folder);
    const unreadable = { ...aRecord('a'), history: [{ operation: 'typed' }] };
    await expect(store.put(unreadable as unknown as UnitRecord)).rejects.toThrow(TypeError);
    expect(store.get('a')).toBeUndefined();
    expect(readdirSync(records)).toEqual([]);
  });

  it('writes the puts of one key one after another: the last put is the record, in memory and on disk', async () => {
    const store = await openRecordStore(folder);
    // The first puts are the largest: written at once, they would finish last.
    const puts = Array.from({ length: 30 }, (_, i) =>
      aRecord('a', { conversationId: `c-${i}`, directory: 'd'.repeat((30 - i) * 20_000) }),
    );
    await Promise.all(puts.map((record) => store.put(record)));
    expect(store.get('a')).toEqual(puts.at(-1));
    expect((await openRecordStore(folder)).get('a')).toEqual(puts.at(-1));
  });

  it('keeps the record the key had when a write fails, leaving nothing aside, and writes the next', async () => {
    const store = await openRecordStore(folder);
    await store.put(aRecord('a'));
    failingRenames.add(join(records, 'a.json'));
    const failed = store.put(aRecord('a', { conversationId: 'lost' }));
    const next = store.put(aRecord('a', { conversationId: 'kept' }));
    await expect(failed).rejects.toThrow(/ENOSPC/);
    await next;
    expect(store.get('a')).toEqual(aRecord('a', { conversationId: 'kept' }));
    expect(readdirSync(records)).toEqual(['a.json']);
  });

  it('keeps the record in memory and on disk as it was when its write fails', async () => {
    const store = await openRecordStore(folder);
    await store.put(aRecord('a'));
    failingRenames.add(join(records, 'a.json'));
    await expect(store.put(aRecord('a', { conversationId: 'lost' }))).rejects.toThrow();
    expect(store.get('a')).toEqual(aRecord('a'));
    expect(JSON.parse(readFileSync(join(records, 'a.json'), 'utf8')).record).toEqual(aRecord('a'));
  });
});

describe('removing a record', () => {
  it('deletes the key’s record, in memory and on disk', async () => {
    const store = await openRecordStore(folder);
    await store.put(aRecord('a'));
    await store.put(aRecord('b'));
    await store.remove('a');
    expect(store.get('a')).toBeUndefined();
    expect(store.list()).toEqual([aRecord('b')]);
    expect(readdirSync(records)).toEqual(['b.json']);
    expect((await openRecordStore(folder)).get('a')).toBeUndefined();
  });

  it('does nothing for a key with no record, a key no file could have included', async () => {
    const store = await openRecordStore(folder);
    await store.remove('a');
    await store.remove('../a');
    expect(store.list()).toEqual([]);
  });

  it('keeps the record, in memory and on disk, when its file cannot be deleted', async () => {
    const store = await openRecordStore(folder);
    await store.put(aRecord('a'));
    failingRemovals.add(join(records, 'a.json'));
    await expect(store.remove('a')).rejects.toThrow('EACCES');
    expect(store.list()).toEqual([aRecord('a')]);
    expect((await openRecordStore(folder)).get('a')).toEqual(aRecord('a'));
  });

  it('acts after the puts asked before it, and a put after it records the key anew, last', async () => {
    const store = await openRecordStore(folder);
    await store.put(aRecord('a'));
    await store.put(aRecord('b'));
    const put = store.put(aRecord('a', { conversationId: 'next' }));
    const removed = store.remove('a');
    await Promise.all([put, removed]);
    expect(store.get('a')).toBeUndefined();
    expect(readdirSync(records)).toEqual(['b.json']);
    await store.put(aRecord('a'));
    expect(store.list().map((record) => record.key)).toEqual(['b', 'a']);
  });
});
