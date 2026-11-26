import { chmod, mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { appFileName } from '../app-name.js';
import type { SessionFolders } from '../sessions/sessions.js';

/** The folder under the user's state root that holds every app's state folder. */
const COCKPIT_FOLDER = 'agent-cockpit';

/** The folder of the state folder that holds a folder per session. */
const SESSIONS_FOLDER = 'sessions';

/** What a session's key may hold, so that its folder never leaves the sessions' folder. */
const SESSION_KEY = /^[a-z0-9-]+$/;

/** Rights of a folder of the cockpit's: its user's alone. */
const PRIVATE_FOLDER = 0o700;

/** The app's state folder, open. */
export interface StateFolder {
  /** Its absolute path. */
  readonly path: string;
  /** The sessions' folders in it. */
  readonly sessions: SessionFolders;
}

/**
 * Gives the path of an app's state folder: the folder the app gives, or
 * `agent-cockpit/<app>` under `$XDG_STATE_HOME` — by default, and when it
 * is not an absolute path, `~/.local/state` — `<app>` being the name the
 * app's tmux socket is named by.
 *
 * @param name - The app's name.
 * @param stateDirectory - The folder the app gives, if any; a relative one
 * is resolved against the server's working folder.
 * @param environment - The server's environment.
 * @returns The folder's absolute path.
 */
export function stateFolderPath(
  name: string,
  stateDirectory: string | undefined,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (stateDirectory !== undefined) return resolve(stateDirectory);
  return join(stateRoot(environment), COCKPIT_FOLDER, appFileName(name));
}

function stateRoot(environment: Readonly<Record<string, string | undefined>>): string {
  const xdg = environment.XDG_STATE_HOME;
  return xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.local', 'state');
}

/**
 * Opens an app's state folder: creates it, readable by the app's user
 * alone, and its missing parents as any folder. A folder that exists keeps
 * its rights: the app may have named a folder of its own, whose rights are
 * its to choose. What the cockpit keeps in it is private however the folder
 * is: its files are the user's alone, and so are its sessions' folders.
 *
 * @param path - The folder, from {@link stateFolderPath}.
 * @returns The open folder.
 * @throws The file system's error when the folder cannot be created — a
 * parent that is a file, or a folder of another user; an `Error` when a
 * file stands in its place.
 */
export async function openStateFolder(path: string): Promise<StateFolder> {
  await createFolderPrivate(path);
  return {
    path,
    sessions: {
      async prepare(key) {
        if (!SESSION_KEY.test(key))
          throw new TypeError(`${JSON.stringify(key)} is no session key.`);
        const folder = join(path, SESSIONS_FOLDER, key);
        await privateFolder(join(path, SESSIONS_FOLDER));
        await privateFolder(folder);
        return folder;
      },
    },
  };
}

/** Creates a folder readable by its user alone, unless one is there: that one is left as it is. */
async function createFolderPrivate(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await mkdir(path, { mode: PRIVATE_FOLDER });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!(await stat(path)).isDirectory()) throw new Error(`${path} is no folder.`);
  }
}

/** Makes a folder of the cockpit's own readable by its user alone, whatever rights it had. */
async function privateFolder(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_FOLDER });
  await chmod(path, PRIVATE_FOLDER);
}
