import { chmod, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
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
 * Opens an app's state folder: creates it and its missing parents, and
 * makes it readable by the app's user alone, whatever rights it had.
 *
 * @param path - The folder, from {@link stateFolderPath}.
 * @returns The open folder.
 * @throws The file system's error when the folder cannot be created or made
 * private — a file in its place, or a folder of another user.
 */
export async function openStateFolder(path: string): Promise<StateFolder> {
  await privateFolder(path);
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

async function privateFolder(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_FOLDER });
  await chmod(path, PRIVATE_FOLDER);
}
