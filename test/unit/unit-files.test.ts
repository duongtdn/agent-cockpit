import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openRecordStore,
  type RecordStore,
  type UnitRecord,
} from '../../src/server/state/records.ts';
import { openStateFolder, type StateFolder } from '../../src/server/state/state-folder.ts';
import { removeUnitFiles } from '../../src/server/state/unit-files.ts';

let root: string;
let state: StateFolder;
let records: RecordStore;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cockpit-unit-files-'));
  state = await openStateFolder(join(root, 'my-app'));
  records = await openRecordStore(state.path);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function aRecord(key: string): UnitRecord {
  return {
    key,
    conversationId: `conversation-of-${key}`,
    earlierConversations: [],
    history: [],
    directory: '.',
    launchSettings: null,
  };
}

/** A unit of work as a launch leaves it: its record, and its session's folder with the driver's files. */
async function recordedUnit(key: string): Promise<string> {
  await records.put(aRecord(key));
  const folder = await state.sessions.prepare(key);
  writeFileSync(join(folder, 'settings.json'), '{"token":"secret"}', { mode: 0o600 });
  writeFileSync(join(folder, 'hook-address.json'), '{"token":"secret"}', { mode: 0o600 });
  return folder;
}

describe('removeUnitFiles', () => {
  it('deletes the key’s record and its session’s folder; the key is unknown, after a restart too', async () => {
    const folder = await recordedUnit('a');
    await recordedUnit('b');

    await removeUnitFiles('a', { records, folders: state.sessions });

    expect(records.get('a')).toBeUndefined();
    expect(records.list().map((record) => record.key)).toEqual(['b']);
    expect(existsSync(folder)).toBe(false);
    expect((await openRecordStore(state.path)).get('a')).toBeUndefined();
  });

  it('leaves the agent’s transcripts where the agent keeps them', async () => {
    await recordedUnit('a');
    const transcripts = join(root, 'claude-config/projects/work');
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(join(transcripts, 'conversation-of-a.jsonl'), 'the agent’s');

    await removeUnitFiles('a', { records, folders: state.sessions });

    expect(readFileSync(join(transcripts, 'conversation-of-a.jsonl'), 'utf8')).toBe('the agent’s');
  });

  it('does nothing for a key with neither a record nor a folder', async () => {
    await recordedUnit('b');
    await removeUnitFiles('a', { records, folders: state.sessions });
    expect(records.list().map((record) => record.key)).toEqual(['b']);
  });

  it('keeps the record while the folder could not be deleted, so that a remove asked again finishes', async () => {
    const folder = await recordedUnit('a');
    const failing = {
      remove: async () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
    };

    await expect(removeUnitFiles('a', { records, folders: failing })).rejects.toThrow('EACCES');
    expect(records.get('a')).toEqual(aRecord('a'));

    await removeUnitFiles('a', { records, folders: state.sessions });
    expect(records.get('a')).toBeUndefined();
    expect(existsSync(folder)).toBe(false);
  });

  it('refuses a key that is no session key, deleting nothing', async () => {
    await recordedUnit('a');
    await expect(removeUnitFiles('..', { records, folders: state.sessions })).rejects.toThrow(
      TypeError,
    );
    expect(records.get('a')).toEqual(aRecord('a'));
    expect(existsSync(join(state.path, 'sessions/a/settings.json'))).toBe(true);
  });
});
