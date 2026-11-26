import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { CockpitError } from '../../shared/cockpit-error.js';
import { createPrivateFileOnce } from './private-files.js';
import { abstractSocketOwner } from './socket-owner.js';

/**
 * How long a newcomer waits for the lock's holder to exit (ADR-0056's "a few
 * seconds"). A watcher's restart passes: the old process exits, a graceful
 * close of its server included, well within it, and the newcomer takes the
 * lock within 50 ms of that exit. A second server started by mistake learns
 * why it cannot start soon enough to read the error at once.
 */
export const LOCK_WAIT_MS = 5000;

/** How often a waiting newcomer tries the lock again. */
const RETRY_MS = 50;

/** The state folder's file that holds the id the lock is named by. */
const LOCK_ID_FILE = 'lock-id';

/** What a lock's id is: 128 random bits in hexadecimal. */
const LOCK_ID = /^[0-9a-f]{32}$/;

/** The app's lock, held. */
export interface AppLock {
  /** Releases it: another process of the app may take it from now on. */
  release(): Promise<void>;
}

/** How a lock is taken. */
export interface LockOptions {
  /** How long to wait for the holder to exit; {@link LOCK_WAIT_MS} by default. */
  readonly waitMs?: number;
  /** Where the system's `/proc` is, to find who holds the lock; `/proc` by default. */
  readonly procRoot?: string;
}

/**
 * Takes the lock of an app's state folder: one cockpit that runs sessions
 * per app, user and machine. The lock is a Linux abstract unix socket,
 * `agent-cockpit-<uid>-<id>`, `<id>` a random id kept in the state folder,
 * so that the lock belongs to the folder — two WSL2 distributions, which
 * share their sockets' names, do not block each other — and its name cannot
 * be guessed by who cannot read the folder. The system frees the name the
 * moment its holder exits, however it exits; taking it is one atomic bind,
 * so of processes that race for it exactly one wins. The socket never keeps
 * the app's process alive.
 *
 * @param folder - The app's state folder, open.
 * @param options - See {@link LockOptions}.
 * @returns The lock, held.
 * @throws `CockpitError` `cockpit-locked` when the lock is still held at the
 * end of the wait: `holder` is the holder's pid as the kernel tells it, or
 * `another-user` when the socket that holds the name — listening or not —
 * is none of the user's processes.
 * `UntrustedStateError` when the id's file is a symbolic link, no regular
 * file or another user's. The file system's error when the state folder's
 * id cannot be read or created, or is damaged.
 */
export async function takeAppLock(folder: string, options: LockOptions = {}): Promise<AppLock> {
  const { waitMs = LOCK_WAIT_MS, procRoot = '/proc' } = options;
  const name = `agent-cockpit-${process.getuid?.()}-${await lockId(folder)}`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const server = await listen(name);
    if (server) return { release: () => close(server) };
    if (Date.now() >= deadline) {
      const owner = await abstractSocketOwner(name, procRoot);
      // Unbound since the bind failed: the holder has just exited; try again.
      if (owner.bound) throw lockedBy(owner.pid, folder);
    }
    await pause(RETRY_MS);
  }
}

async function lockId(folder: string): Promise<string> {
  const file = join(folder, LOCK_ID_FILE);
  const id = await createPrivateFileOnce(file, randomBytes(16).toString('hex'));
  if (!LOCK_ID.test(id)) {
    throw new Error(
      `${file} holds no lock id: remove it while no process of the app runs, and start again.`,
    );
  }
  return id;
}

/** Binds the lock's name; `undefined` when another socket holds it. */
function listen(name: string): Promise<Server | undefined> {
  return new Promise((resolve, reject) => {
    // Nothing is said to who connects: the holder is told by the kernel.
    const server = createServer((connection) => connection.destroy());
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve(undefined);
      else reject(error);
    });
    server.listen(`\0${name}`, () => {
      server.unref();
      resolve(server);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function lockedBy(pid: number | undefined, folder: string): CockpitError<'cockpit-locked'> {
  if (pid === undefined) {
    return new CockpitError(
      'cockpit-locked',
      `A process of another user holds the lock of ${folder}: the cockpit cannot start until it lets go.`,
      { holder: 'another-user' },
    );
  }
  return new CockpitError(
    'cockpit-locked',
    `Another process of the app (${pid}) runs a cockpit with sessions: it holds the lock of ${folder}.`,
    { holder: pid },
  );
}
