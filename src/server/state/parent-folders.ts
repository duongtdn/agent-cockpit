import type { Stats } from 'node:fs';
import { chmod, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname } from 'node:path';
import { UntrustedStateError } from './own-files.js';

/** Where the system lists its groups, by default. */
export const GROUP_FILE = '/etc/group';

/** Where the system lists its users, by default. */
export const PASSWD_FILE = '/etc/passwd';

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
  /** Where the system's users are listed, with their primary groups; {@link PASSWD_FILE} by default. */
  readonly passwdFile?: string;
}

/**
 * Opens the folders a folder of the cockpit's hangs from. Those that exist
 * are checked first, from the root down, as OpenSSH's StrictModes does:
 * each must be the user's or root's — a symbolic link judged by its own
 * owner, then the path it leads to — and writable by others only with the
 * sticky bit, by its group only with the sticky bit or when the group is
 * the user's own private one: the user's primary group, listed once in the
 * group file, named after the user, with no other member there and no
 * other user's primary group in the passwd file. Another user able to rename entries in one of
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
  const judge = new FolderJudge(options.groupFile ?? GROUP_FILE, options.passwdFile ?? PASSWD_FILE);
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
  readonly #passwdFile: string;

  constructor(groupFile: string, passwdFile: string) {
    this.#groupFile = groupFile;
    this.#passwdFile = passwdFile;
  }

  /** Refuses a folder, or a symbolic link to one, that another user could change. */
  async refuseUnsafe(path: string, found: Stats): Promise<void> {
    refuseForeignOwner(path, found);
    if (found.isSymbolicLink()) {
      // A realpath holds no link: its folders are judged as they are.
      for (const each of fromRootDown(await leadsTo(path))) {
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
    const listed = (await readGroups(this.#groupFile)).filter((group) => group.gid === gid);
    if (listed.length === 0) {
      throw shared(
        `${this.#groupFile} does not list it, so the cockpit cannot tell it is the user's private group`,
      );
    }
    if (listed.length > 1) throw shared(`${this.#groupFile} lists it more than once`);
    const [group] = listed as [Group];
    const user = userInfo().username;
    if (group.name !== user) throw shared(`it is not named after the user ${user}`);
    if (group.members.some((member) => member !== user)) throw shared('it has other members');
    const others = (await readPrimaryGroups(this.#passwdFile))
      .filter((account) => account.gid === gid && account.name !== user)
      .map((account) => account.name);
    if (others.length > 0) {
      throw shared(`it is the primary group of other users too (${others.join(', ')})`);
    }
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
  // The umask can only narrow the mode mkdir gives, so the folder is never
  // wider than 0755; under a narrow umask (077) this widens it back, so that
  // what is above the cockpit's folder can be passed through as usual.
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

/** Where a symbolic link above the cockpit's folder leads; one that leads nowhere is refused. */
async function leadsTo(link: string): Promise<string> {
  try {
    return await realpath(link);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code !== 'ENOENT' && code !== 'ELOOP') throw error;
    throw new UntrustedStateError(link, `is a symbolic link that leads to no folder (${code}).`);
  }
}

/** A group of the system, as its group file lists it. */
interface Group {
  readonly name: string;
  readonly gid: number;
  readonly members: readonly string[];
}

/** A user of the system and its primary group, as the passwd file lists them. */
interface Account {
  readonly name: string;
  readonly gid: number;
}

/** The groups of a group file (`name:password:gid:member,member`), in its order. */
async function readGroups(file: string): Promise<Group[]> {
  return (await readEntries(file)).flatMap(([name, , gid, members]) =>
    name && gid && /^\d+$/.test(gid)
      ? [{ name, gid: Number(gid), members: (members ?? '').split(',').filter(Boolean) }]
      : [],
  );
}

/** The users of a passwd file (`name:password:uid:gid:…`) with their primary groups. */
async function readPrimaryGroups(file: string): Promise<Account[]> {
  return (await readEntries(file)).flatMap(([name, , , gid]) =>
    name && gid && /^\d+$/.test(gid) ? [{ name, gid: Number(gid) }] : [],
  );
}

/** The fields of each line of a system file, its line ends CRLF or LF. */
async function readEntries(file: string): Promise<string[][]> {
  return (await readFile(file, 'utf8'))
    .split('\n')
    .map((line) => line.replace(/\r$/, '').split(':'));
}

/** A folder and every folder above it, the root first. */
function fromRootDown(folder: string): string[] {
  const parent = dirname(folder);
  return parent === folder ? [folder] : [...fromRootDown(parent), folder];
}
