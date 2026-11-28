import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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

/** A unit of work as a launch leaves it: its record, and its session's folder. */
async function recordedUnit(key: string): Promise<string> {
  await records.put(aRecord(key));
  return state.sessions.prepare(key);
}

/** A removal that fails, as one in a folder the user can no longer write. */
async function failingRemove(): Promise<void> {
  throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
}

describe('removeUnitFiles', () => {
  it('keeps the record while the folder could not be deleted, so that a remove asked again finishes', async () => {
    const folder = await recordedUnit('a');

    await expect(
      removeUnitFiles('a', { records, folders: { remove: failingRemove } }),
    ).rejects.toThrow('EACCES');
    expect(records.get('a')).toEqual(aRecord('a'));

    await removeUnitFiles('a', { records, folders: state.sessions });
    expect(records.get('a')).toBeUndefined();
    expect(existsSync(folder)).toBe(false);
  });

  it('has deleted the folder when the record could not be, and a remove asked again finishes', async () => {
    const folder = await recordedUnit('a');

    await expect(
      removeUnitFiles('a', { records: { remove: failingRemove }, folders: state.sessions }),
    ).rejects.toThrow('EACCES');
    expect(existsSync(folder)).toBe(false);
    expect(records.get('a')).toEqual(aRecord('a'));

    await removeUnitFiles('a', { records, folders: state.sessions });
    expect(records.get('a')).toBeUndefined();
  });
});
