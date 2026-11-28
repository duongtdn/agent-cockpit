/**
 * What the cockpit wrote for a unit of work, deleted as one: its record and
 * its session's folder. The agent's own files — its transcripts — are not
 * the cockpit's, and are left where the agent keeps them.
 *
 * @packageDocumentation
 */

import type { RecordStore } from './records.js';
import type { RemovableSessionFolders } from './state-folder.js';

/** Where a unit of work's files are kept. */
export interface UnitFiles {
  /** The records of the units of work. */
  readonly records: Pick<RecordStore, 'remove'>;
  /** The sessions' folders. */
  readonly folders: Pick<RemovableSessionFolders, 'remove'>;
}

/**
 * Deletes everything the cockpit wrote for a key: its session's folder —
 * the driver's settings files and the hook token in them — then its record.
 * The key is unknown once the promise is fulfilled. Nothing to do for a key
 * that has neither.
 *
 * @param key - The key.
 * @param files - Where its files are kept.
 * @throws `TypeError` when the key is not of the form `[a-z0-9-]+`; nothing
 * is deleted. The file system's error when a file cannot be deleted: the
 * record then stays, and the remove can be asked again.
 */
export async function removeUnitFiles(key: string, files: UnitFiles): Promise<void> {
  // The record goes last: while it stays the key is known, so a remove cut
  // short is asked again and finishes. Gone first, it would leave an
  // unknown key's folder, token and all, that no remove would look for.
  await files.folders.remove(key);
  await files.records.remove(key);
}
