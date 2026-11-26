import { randomUUID } from 'node:crypto';
import { link, rename, rm, writeFile } from 'node:fs/promises';
import { readOwnFile, type UntrustedStateError } from './own-files.js';

/** What follows a file's name in the name of the file written aside for it. */
const ASIDE_SUFFIX = /\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Where a file is written before it is put in place: beside it, so that the move is atomic. */
function asideOf(path: string): string {
  return `${path}.${randomUUID()}`;
}

/**
 * Tells which file a file was written aside for: one a write left there
 * when its process died before putting it in place.
 *
 * @param name - A file's name in a folder.
 * @returns The name of the file it was written for; `undefined` when it is
 * no file written aside.
 */
export function asideTarget(name: string): string | undefined {
  const suffix = ASIDE_SUFFIX.exec(name);
  return suffix && suffix.index > 0 ? name.slice(0, suffix.index) : undefined;
}

/**
 * Writes a file only the app's user can read, whole or not at all: written
 * aside, then put in place, so that no reader ever sees half of it and a file
 * written earlier never keeps wider rights.
 *
 * @param path - The file.
 * @param content - What it holds.
 * @throws The file system's error when it cannot be written or put in
 * place: the file there stays as it was, and nothing is left aside.
 */
export async function writePrivateFile(path: string, content: string): Promise<void> {
  const aside = asideOf(path);
  try {
    await writeFile(aside, content, { mode: 0o600, flag: 'wx' });
    await rename(aside, path);
  } catch (error) {
    await rm(aside, { force: true });
    throw error;
  }
}

/**
 * Creates a file only the app's user can read, unless one is there: the
 * first of several writers wins, at once and whole, and every writer reads
 * the winner's content. The file is written aside, then linked in place,
 * which fails if the name is taken.
 *
 * @param path - The file.
 * @param content - What it holds if this writer creates it.
 * @returns What the file holds: this writer's content, or the winner's.
 * @throws {@link UntrustedStateError} when the file there is no regular
 * file of the user's; it is narrowed to the user alone when others had rights on it.
 */
export async function createPrivateFileOnce(path: string, content: string): Promise<string> {
  const aside = asideOf(path);
  await writeFile(aside, content, { mode: 0o600, flag: 'wx' });
  try {
    await link(aside, path);
    return content;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return await readOwnFile(path);
  } finally {
    await rm(aside, { force: true });
  }
}
