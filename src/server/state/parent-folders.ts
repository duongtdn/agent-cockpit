import type { Stats } from 'node:fs';
import { chmod, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname } from 'node:path';
import { UntrustedStateError } from './own-files.js';

/** Where the system lists its groups, by default. */
export const GROUP_FILE = '/etc/group';

/** Rights of a folder the cockpit creates above its own: anyone may pass, only its user may write. */
const PARENT_FOLDER = 0o755;

/** The write right of others. */
const OTHERS_WRITE = 0o002;

/** The write right of the group. */
const GROUP_WRITE = 0o020;

/** The sticky bit: in such a folder only an entry's owner may rename or remove it. */
const STICKY = 0o1000;

/** The user every system folder belongs to. */
const ROOT_UID = 0;

/** How the folders above the cockpit's own are judged. */
export interface ParentFolderOptions {
  /** Where the system's groups are listed; {@link GROUP_FILE} by default. */
  readonly groupFile?: string;
}

/**
 * Opens the folders a folder of the cockpit's hangs from. Those that exist
 * are checked first, from the root down, as OpenSSH's StrictModes does:
 * each must be the user's or root's — a symbolic link judged by its own
 * owner, then the path it leads to — and writable by others only with the
 * sticky bit, by its group only with the sticky bit or when the group is
 * the user's own private one. Another user able to rename entries in one of
 * them could swap the cockpit's folder for one of theirs. Only then are the
 * missing ones created, readable by all and writable by the user alone,
 * whatever the umask: nothing is created above a refused folder.
 *
 * @param folder - The folder above the cockpit's own: its parent.
 * @param options - See {@link ParentFolderOptions}.
 * @throws {@link UntrustedStateError} naming the first folder that fails;
 * the file system's error when one cannot be read or created.
 */
export async function openParentFolders(
  folder: string,
  options: ParentFolderOptions = {},
): Promise<void> {
  const judge = new FolderJudge(options.groupFile ?? GROUP_FILE);
  const chain = fromRootDown(folder);
  let existing = 0;
  for (; existing < chain.length; existing += 1) {
    const each = chain[existing] as string;
    const found = await lstatIfThere(each);
    if (found === undefined) break;
    await judge.refuseUnsafe(each, found);
  }
  for (const each of chain.slice(existing)) await createParent(each, judge);
}

/** Judges each folder above the cockpit's own. */
class FolderJudge {
  readonly #groupFile: string;

  constructor(groupFile: string) {
    this.#groupFile = groupFile;
  }

  /** Refuses a folder, or a symbolic link to one, that another user could change. */
  async refuseUnsafe(path: string, found: Stats): Promise<void> {
    refuseForeignOwner(path, found);
    if (found.isSymbolicLink()) {
      // A realpath holds no link: its folders are judged as they are.
      for (const each of fromRootDown(await realpath(path))) {
        await this.refuseUnsafe(each, await lstat(each));
      }
      return;
    }
    if (!found.isDirectory()) throw new UntrustedStateError(path, 'is no folder.');
    if (found.mode & STICKY) return;
    if (found.mode & OTHERS_WRITE) {
      throw new UntrustedStateError(
        path,
        "can be written by others, without the sticky bit: another user could put a folder of theirs in place of the cockpit's.",
      );
    }
    if (found.mode & GROUP_WRITE) await this.#refuseSharedGroup(path, found.gid);
  }

  /** A group may write a folder above the cockpit's only when it is the user's private group. */
  async #refuseSharedGroup(path: string, gid: number): Promise<void> {
    const shared = (why: string) =>
      new UntrustedStateError(
        path,
        `can be written by its group (gid ${gid}), without the sticky bit, and ${why}: another member could put a folder of theirs in place of the cockpit's.`,
      );
    if (gid !== process.getgid?.()) throw shared("it is not the user's primary group");
    const group = (await readGroups(this.#groupFile)).get(gid);
    if (group === undefined) {
      throw shared(
        `${this.#groupFile} does not list it, so the cockpit cannot tell it is the user's private group`,
      );
    }
    const user = userInfo().username;
    if (group.name !== user) throw shared(`it is not named after the user ${user}`);
    if (group.members.some((member) => member !== user)) throw shared('it has other members');
  }
}

/** Creates a folder above the cockpit's, readable by all, writable by its user alone. */
async function createParent(path: string, judge: FolderJudge): Promise<void> {
  try {
    await mkdir(path, { mode: PARENT_FOLDER });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // Another process created it meanwhile: it is judged as any that exists.
    await judge.refuseUnsafe(path, await lstat(path));
    return;
  }
  // The umask may have narrowed it, or left the group its write right.
  await chmod(path, PARENT_FOLDER);
}

function refuseForeignOwner(path: string, found: Stats): void {
  if (found.uid !== process.getuid?.() && found.uid !== ROOT_UID) {
    throw new UntrustedStateError(
      path,
      `belongs to another user (uid ${found.uid}), above the cockpit's folder.`,
    );
  }
}

async function lstatIfThere(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** A group of the system, as its group file lists it. */
interface Group {
  readonly name: string;
  readonly members: readonly string[];
}

/** The groups of a group file (`name:password:gid:member,member`), by gid. */
async function readGroups(file: string): Promise<Map<number, Group>> {
  const groups = new Map<number, Group>();
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    const [name, , gid, members] = line.split(':');
    if (name === undefined || gid === undefined || !/^\d+$/.test(gid)) continue;
    groups.set(Number(gid), { name, members: members ? members.split(',') : [] });
  }
  return groups;
}

/** A folder and every folder above it, the root first. */
function fromRootDown(folder: string): string[] {
  const parent = dirname(folder);
  return parent === folder ? [folder] : [...fromRootDown(parent), folder];
}
