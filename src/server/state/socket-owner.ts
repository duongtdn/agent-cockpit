import { readdir, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';

/** `/proc/net/unix`'s flag of a socket that listens (`__SO_ACCEPTCON`). */
const LISTENING = '00010000';

/** Who listens on an abstract unix socket, as the kernel says. */
export type SocketOwner =
  /** Nothing listens on the name. */
  | { readonly listening: false }
  /** A process listens: `pid` when it is one the user can read, else absent. */
  | { readonly listening: true; readonly pid?: number };

/**
 * Finds the process that listens on an abstract unix socket, from the
 * kernel rather than from what that process says: `/proc/net/unix` gives the
 * listening socket's inode, and the process that holds it is looked for
 * among the processes whose descriptors the user may read — their own.
 *
 * @param name - The socket's abstract name, without its leading NUL.
 * @param procRoot - Where the system's `/proc` is.
 * @returns Who listens.
 */
export async function abstractSocketOwner(name: string, procRoot: string): Promise<SocketOwner> {
  const inodes = await listeningInodes(`@${name}`, procRoot);
  if (inodes.size === 0) return { listening: false };
  const pid = await processHolding(inodes, procRoot);
  return pid === undefined ? { listening: true } : { listening: true, pid };
}

async function listeningInodes(path: string, procRoot: string): Promise<Set<string>> {
  const table = await readFile(join(procRoot, 'net/unix'), 'utf8');
  const inodes = new Set<string>();
  // Num RefCount Protocol Flags Type St Inode Path
  for (const line of table.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields[3] === LISTENING && fields[7] === path && fields[6]) inodes.add(fields[6]);
  }
  return inodes;
}

async function processHolding(inodes: Set<string>, procRoot: string): Promise<number | undefined> {
  const sockets = new Set([...inodes].map((inode) => `socket:[${inode}]`));
  for (const entry of await readdir(procRoot)) {
    if (!/^\d+$/.test(entry)) continue;
    const descriptors = join(procRoot, entry, 'fd');
    for (const descriptor of await readable(descriptors)) {
      const target = await readlink(join(descriptors, descriptor)).catch(() => '');
      if (sockets.has(target)) return Number(entry);
    }
  }
  return undefined;
}

/** A folder's entries; none when it cannot be read — another user's process, or one gone. */
async function readable(folder: string): Promise<string[]> {
  return await readdir(folder).catch(() => []);
}
