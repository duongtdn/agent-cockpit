/**
 * The records of the units of work: what the cockpit keeps of each key in
 * its state folder, until the app removes it, so that a restarted server
 * lists its units of work and resumes them.
 *
 * @packageDocumentation
 */

import type { SessionRecord } from '../../shared/session.js';
import type { DriverSettings } from '../driver.js';

/**
 * What the cockpit keeps of one unit of work: its record as the app sees
 * it, and what only the cockpit needs — the folder bound to the key and
 * the settings its live session was launched with.
 */
export interface UnitRecord extends SessionRecord {
  /** The key it is the record of. */
  readonly key: string;
  /**
   * The folder its sessions run in, relative to the app's folder (`.` for
   * the app's own), as its first start, or its last fresh one, recorded
   * it: every later launch runs there.
   */
  readonly directory: string;
  /**
   * What the driver's settings were at the launch of its session, as
   * `Driver.launchSettings` gave them: a run with other settings restarts
   * an `idle` session. The folder is not among them: it is bound to the
   * key, and a run that gives another is refused.
   */
  readonly launchSettings: DriverSettings;
}

/**
 * The records of the app's units of work, in its state folder: each kept in
 * a file of its own, readable by the app's user alone, written aside then
 * renamed, so that a record is read whole or not at all.
 */
export interface RecordStore {
  /**
   * Every record, as the store holds it now.
   *
   * @returns The records, in the order their keys were first recorded.
   */
  list(): readonly UnitRecord[];
  /**
   * The record of a key.
   *
   * @param key - The key.
   * @returns Its record; `undefined` when it has none.
   */
  get(key: string): UnitRecord | undefined;
  /**
   * Writes a key's record, in place of the one it had: aside, then renamed
   * over it. `get` and `list` give it once the promise is fulfilled.
   *
   * @param record - The record.
   * @throws The file system's error when it cannot be written: the record
   * the key had stays.
   */
  put(record: UnitRecord): Promise<void>;
}
