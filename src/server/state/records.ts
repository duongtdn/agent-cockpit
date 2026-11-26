/**
 * The records of the units of work: what the cockpit keeps of each key in
 * its state folder, until the app removes it, so that a restarted server
 * lists its units of work and resumes them.
 *
 * @packageDocumentation
 */

import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { isSessionKey, type SessionRecord } from '../../shared/session.js';
import type { DriverSettings } from '../driver.js';
import { openOwnFolder, readOwnFile, UntrustedStateError } from './own-files.js';
import { asideTarget, writePrivateFile } from './private-files.js';

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
 * renamed, so that a record is read whole or not at all. The writes of one
 * key — puts and removes — run one after another, in the order they were
 * asked; those of different keys run side by side.
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
   * over it. `get` and `list` give it once the promise is fulfilled, as a
   * restarted store would read it back: a copy, not the object given.
   *
   * @param record - The record.
   * @throws `TypeError` when its key is not of the form `[a-z0-9-]+`, or
   * it is no record the store could read back (a value JSON cannot keep);
   * nothing is written. The file system's error when it cannot be written:
   * the record the key had stays.
   */
  put(record: UnitRecord): Promise<void>;
  /**
   * Deletes a key's record, once the writes asked before it are done: the
   * key is unknown from then on, and a later put records it anew, last in
   * the list. Nothing to do when the key has no record. Only the record is
   * deleted: the key's other files are not the store's.
   *
   * @param key - The key.
   * @throws The file system's error when its file cannot be deleted: the
   * record stays.
   */
  remove(key: string): Promise<void>;
}

/** The folder of the state folder that holds the records, one file per key. */
const RECORDS_FOLDER = 'records';

/** What a record's file name ends with, after its key. */
const RECORD_EXTENSION = '.json';

/** The version of a record's file: a file of another version is refused, not misread. */
const FILE_VERSION = 1;

const historyEntrySchema = z.object({
  operation: z.enum(['run', 'open']),
  jobId: z.string(),
  args: z.json(),
  at: z.iso.datetime(),
  action: z.enum(['started', 'resumed', 'sent']),
  reason: z
    .enum(['fresh', 'fresh-on-request', 'conversation-gone', 'settings-changed'])
    .exactOptional(),
  conversationId: z.string().min(1),
});

const unitRecordSchema: z.ZodType<UnitRecord> = z.object({
  key: z.string().refine(isSessionKey, 'Expected a session key: [a-z0-9-]+.'),
  conversationId: z.string().min(1),
  earlierConversations: z.array(z.string().min(1)),
  history: z.array(historyEntrySchema),
  directory: z.string().min(1),
  launchSettings: z.json(),
});

/** A record's file: its record, and its place in the order keys were first recorded. */
const recordFileSchema = z.object({
  version: z.literal(FILE_VERSION),
  order: z.number().int().positive(),
  record: unitRecordSchema,
});

type RecordFile = z.infer<typeof recordFileSchema>;

/**
 * Opens the records of the units of work in an app's state folder: the
 * `records` folder, made readable by the app's user alone, then every
 * record in it, `<key>.json`, loaded. What a write cut short by the death of
 * its process left aside is deleted; names that are neither are left
 * alone. Called with the app's lock held, so no other process writes them.
 *
 * @param stateFolder - The app's state folder, open.
 * @returns The store, holding every record kept.
 * @throws `UntrustedStateError` when the records' folder or a record's file
 * is a symbolic link, not the kind of entry it should be, or another user's,
 * and when a record's file holds no record the cockpit writes — torn, of
 * another version, or the record of another key. The file system's error
 * when the folder cannot be created or a file read.
 */
export async function openRecordStore(stateFolder: string): Promise<RecordStore> {
  const folder = join(stateFolder, RECORDS_FOLDER);
  await openOwnFolder(folder);
  const files: RecordFile[] = [];
  for (const name of await readdir(folder)) {
    const key = keyOfRecordFile(name);
    if (key !== undefined) {
      files.push(await readRecordFile(join(folder, name), key));
    } else if (isLeftAside(name)) {
      await rm(join(folder, name), { force: true });
    }
  }
  return new FileRecordStore(folder, files);
}

class FileRecordStore implements RecordStore {
  readonly #folder: string;
  readonly #records = new Map<string, UnitRecord>();
  /** Each key's place in the list, given at its first write and kept until it is removed. */
  readonly #orders = new Map<string, number>();
  /** Each key's last write asked, settled whatever its outcome: the next one waits for it. */
  readonly #lastWrites = new Map<string, Promise<void>>();
  #lastOrder = 0;

  constructor(folder: string, files: readonly RecordFile[]) {
    this.#folder = folder;
    for (const { order, record } of [...files].sort((a, b) => a.order - b.order)) {
      this.#records.set(record.key, record);
      this.#orders.set(record.key, order);
      this.#lastOrder = Math.max(this.#lastOrder, order);
    }
  }

  list(): readonly UnitRecord[] {
    return [...this.#records.values()].sort(
      (a, b) => (this.#orders.get(a.key) ?? 0) - (this.#orders.get(b.key) ?? 0),
    );
  }

  get(key: string): UnitRecord | undefined {
    return this.#records.get(key);
  }

  async put(record: UnitRecord): Promise<void> {
    if (!isSessionKey(record.key)) {
      throw new TypeError(`${JSON.stringify(record.key)} is no session key.`);
    }
    const kept = asReadBack(record);
    return this.#afterLastWrite(kept.key, async () => {
      const order = this.#orderOf(kept.key);
      const file: RecordFile = { version: FILE_VERSION, order, record: kept };
      await writePrivateFile(this.#pathOf(kept.key), JSON.stringify(file));
      this.#records.set(kept.key, kept);
    });
  }

  async remove(key: string): Promise<void> {
    if (!isSessionKey(key)) return;
    return this.#afterLastWrite(key, async () => {
      await rm(this.#pathOf(key), { force: true });
      this.#records.delete(key);
      this.#orders.delete(key);
    });
  }

  #pathOf(key: string): string {
    return join(this.#folder, `${key}${RECORD_EXTENSION}`);
  }

  #orderOf(key: string): number {
    let order = this.#orders.get(key);
    if (order === undefined) {
      this.#lastOrder += 1;
      order = this.#lastOrder;
      this.#orders.set(key, order);
    }
    return order;
  }

  /** Runs a write of a key once the one asked before it has settled. */
  #afterLastWrite(key: string, write: () => Promise<void>): Promise<void> {
    const written = (this.#lastWrites.get(key) ?? Promise.resolve()).then(write);
    const settled = written.catch(() => undefined);
    this.#lastWrites.set(key, settled);
    void settled.then(() => {
      if (this.#lastWrites.get(key) === settled) this.#lastWrites.delete(key);
    });
    return written;
  }
}

/** A record as a restarted store would read it back from its file. */
function asReadBack(record: UnitRecord): UnitRecord {
  const parsed = unitRecordSchema.safeParse(JSON.parse(JSON.stringify(record)));
  if (!parsed.success) {
    throw new TypeError(
      `The record of ${record.key} could not be read back: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

async function readRecordFile(path: string, key: string): Promise<RecordFile> {
  const content = await readOwnFile(path);
  const parsed = recordFileSchema.safeParse(parsedJson(content));
  if (!parsed.success) {
    throw new UntrustedStateError(
      path,
      `holds no record the cockpit writes (${z.prettifyError(parsed.error)}): move it out of the state folder while no process of the app runs, and start again.`,
    );
  }
  if (parsed.data.record.key !== key) {
    throw new UntrustedStateError(
      path,
      `holds the record of ${parsed.data.record.key}, not of ${key}: move it out of the state folder while no process of the app runs, and start again.`,
    );
  }
  return parsed.data;
}

/** The JSON a file holds; `undefined` when it holds none, which no record's schema takes. */
function parsedJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

/** The key a record's file is named for; `undefined` when the name is no record's. */
function keyOfRecordFile(name: string): string | undefined {
  if (!name.endsWith(RECORD_EXTENSION)) return undefined;
  const key = name.slice(0, -RECORD_EXTENSION.length);
  return isSessionKey(key) ? key : undefined;
}

function isLeftAside(name: string): boolean {
  const target = asideTarget(name);
  return target !== undefined && keyOfRecordFile(target) !== undefined;
}
