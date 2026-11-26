import type { Stats } from 'node:fs';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Rights of a folder of the cockpit's: its user's alone. */
const PRIVATE_FOLDER = 0o700;

/** Rights of a file of the cockpit's: its user's alone. */
const PRIVATE_FILE = 0o600;

/** The write rights of a group and of others. */
const OTHERS_WRITE = 0o022;

/** The sticky bit: in such a folder only an entry's owner may rename or remove it. */
const STICKY = 0o1000;

/** The user every system folder belongs to. */
const ROOT_UID = 0;

/** The rights of a group and of others: any of them makes a file or folder reachable by another user. */
const OTHERS_RIGHTS = 0o077;

/**
 * A path of the state folder the cockpit cannot trust: a symbolic link, not
 * the kind of entry it should be, or another user's. Another user could
 * have planted it, and would know what it holds — the app's token.
 */
export class UntrustedStateError extends Error {
  override readonly name = 'UntrustedStateError';
  /** The path refused. */
  readonly path: string;

  /**
   * @param path - The path refused.
   * @param why - Why, in English, for developers.
   */
  constructor(path: string, why: string) {
    super(`${path} ${why}`);
    this.path = path;
  }
}

/** A file of the cockpit's, read. */
export interface OwnFile {
  /** What it holds. */
  readonly content: string;
  /** Whether a group or others had rights on it: what it holds may be known beyond its user. */
  readonly exposed: boolean;
}

/**
 * Opens a folder of the cockpit's own: creates it readable by its user
 * alone, or takes the one there when it is a folder of the user's, narrowed
 * to its user alone. Nothing is followed: a symbolic link is refused.
 *
 * @param path - The folder; its parent exists.
 * @throws {@link UntrustedStateError} when a symbolic link, a file or
 * another user's folder is there; the file system's error when it cannot be
 * created or narrowed.
 */
export async function openOwnFolder(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: PRIVATE_FOLDER });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const found = await lstat(path);
  refuseUnlessOwnFolder(path, found);
  if (found.mode & OTHERS_RIGHTS) await chmod(path, PRIVATE_FOLDER);
}

/**
 * Checks the folders a folder of the cockpit's hangs from, as OpenSSH's
 * StrictModes does: from the root down, through the path as given and the
 * path its symbolic links lead to, each must be the user's or root's, and
 * writable by its group or others only with the sticky bit. Another user
 * able to rename entries in one of them could swap the cockpit's folder for
 * a folder of theirs.
 *
 * @param folder - The folder above the cockpit's own: its parent, existing.
 * @throws {@link UntrustedStateError} naming the first folder that fails;
 * the file system's error when one cannot be read.
 */
export async function refuseUnsafeParents(folder: string): Promise<void> {
  const chain = new Set([...fromRootDown(folder), ...fromRootDown(await realpath(folder))]);
  for (const each of chain) {
    const found = await stat(each);
    if (found.uid !== process.getuid?.() && found.uid !== ROOT_UID) {
      throw new UntrustedStateError(
        each,
        `belongs to another user (uid ${found.uid}), above the cockpit's folder.`,
      );
    }
    if (found.mode & OTHERS_WRITE && !(found.mode & STICKY)) {
      throw new UntrustedStateError(
        each,
        "can be written by its group or others, without the sticky bit: another user could put a folder of theirs in place of the cockpit's.",
      );
    }
  }
}

/** A folder and every folder above it, the root first. */
function fromRootDown(folder: string): string[] {
  const parent = dirname(folder);
  return parent === folder ? [folder] : [...fromRootDown(parent), folder];
}

/**
 * Reads a file of the cockpit's own, telling whether others had rights on
 * it. Nothing is followed: a symbolic link is refused.
 *
 * @param path - The file.
 * @returns What it holds, and whether it was exposed.
 * @throws {@link UntrustedStateError} when it is a symbolic link, no
 * regular file, or another user's; the file system's error when it cannot
 * be read, `ENOENT` when it is missing.
 */
export async function inspectOwnFile(path: string): Promise<OwnFile> {
  const found = await lstat(path);
  refuseUnlessOwnFile(path, found);
  // O_NOFOLLOW: a link put in its place since the check is refused too.
  const content = await readFile(path, {
    encoding: 'utf8',
    flag: constants.O_RDONLY | constants.O_NOFOLLOW,
  });
  return { content, exposed: (found.mode & OTHERS_RIGHTS) !== 0 };
}

/**
 * Reads a file of the cockpit's own, as {@link inspectOwnFile} does, and
 * narrows it to its user alone when others had rights on it: what it holds
 * is no secret, only the cockpit's to change.
 *
 * @param path - The file.
 * @returns What it holds.
 * @throws As {@link inspectOwnFile}; the file system's error when it cannot be narrowed.
 */
export async function readOwnFile(path: string): Promise<string> {
  const { content, exposed } = await inspectOwnFile(path);
  if (exposed) await chmod(path, PRIVATE_FILE);
  return content;
}

function refuseUnlessOwnFolder(path: string, found: Stats): void {
  refuseLink(path, found);
  if (!found.isDirectory()) throw new UntrustedStateError(path, 'is no folder.');
  refuseStranger(path, found);
}

function refuseUnlessOwnFile(path: string, found: Stats): void {
  refuseLink(path, found);
  if (!found.isFile()) throw new UntrustedStateError(path, 'is no regular file.');
  refuseStranger(path, found);
}

function refuseLink(path: string, found: Stats): void {
  if (found.isSymbolicLink()) throw new UntrustedStateError(path, 'is a symbolic link.');
}

function refuseStranger(path: string, found: Stats): void {
  if (found.uid !== process.getuid?.()) {
    throw new UntrustedStateError(path, `belongs to another user (uid ${found.uid}).`);
  }
}
