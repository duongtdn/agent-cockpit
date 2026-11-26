import { randomUUID } from 'node:crypto';
import { link, readFile, rename, rm, writeFile } from 'node:fs/promises';

/** Where a file is written before it is put in place: beside it, so that the move is atomic. */
function asideOf(path: string): string {
  return `${path}.${randomUUID()}`;
}

/**
 * Writes a file only the app's user can read, whole or not at all: written
 * aside, then put in place, so that no reader ever sees half of it and a file
 * written earlier never keeps wider rights.
 *
 * @param path - The file.
 * @param content - What it holds.
 */
export async function writePrivateFile(path: string, content: string): Promise<void> {
  const aside = asideOf(path);
  await writeFile(aside, content, { mode: 0o600, flag: 'wx' });
  await rename(aside, path);
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
 */
export async function createPrivateFileOnce(path: string, content: string): Promise<string> {
  const aside = asideOf(path);
  await writeFile(aside, content, { mode: 0o600, flag: 'wx' });
  try {
    await link(aside, path);
    return content;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return await readFile(path, 'utf8');
  } finally {
    await rm(aside, { force: true });
  }
}
