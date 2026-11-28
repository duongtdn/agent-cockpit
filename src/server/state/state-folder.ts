import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isSessionKey } from '../../shared/session.js';
import { appFileName } from '../app-name.js';
import type { SessionFolders } from '../sessions/sessions.js';
import { openOwnFolder, type UntrustedStateError } from './own-files.js';
import { openParentFolders, type ParentFolderOptions } from './parent-folders.js';

/** The folder under the user's state root that holds every app's state folder. */
const COCKPIT_FOLDER = 'agent-cockpit';

/** The folder of the state folder that holds a folder per session. */
const SESSIONS_FOLDER = 'sessions';

/** The sessions' folders in the state folder, which the cockpit also deletes. */
export interface RemovableSessionFolders extends SessionFolders {
  /**
   * Deletes a session's folder and all it holds — the files the driver
   * wrote there, its hook token among them. A symbolic link in it, or in its
   * place, is deleted as a link: what it leads to is left as it is. Nothing
   * to do when the key has no folder.
   *
   * @param key - The session's key.
   * @throws `TypeError` when the key is not of the form `[a-z0-9-]+`: its
   * folder could lie outside the sessions' folder, and nothing is deleted.
   * The file system's error when the folder cannot be deleted whole.
   */
  remove(key: string): Promise<void>;
}

/** The app's state folder, open. */
export interface StateFolder {
  /** Its absolute path. */
  readonly path: string;
  /** The sessions' folders in it. */
  readonly sessions: RemovableSessionFolders;
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
  return join(cockpitStateRoot(environment), appFileName(name));
}

/**
 * Gives the cockpit's default state root, which holds every app's state
 * folder: `agent-cockpit` under `$XDG_STATE_HOME`, by default and when it is
 * not an absolute path `~/.local/state`.
 *
 * @param environment - The server's environment.
 * @returns Its absolute path.
 */
export function cockpitStateRoot(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return join(stateRoot(environment), COCKPIT_FOLDER);
}

function stateRoot(environment: Readonly<Record<string, string | undefined>>): string {
  const xdg = environment.XDG_STATE_HOME;
  return xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.local', 'state');
}

/**
 * Opens an app's state folder, the cockpit's own: creates it readable by
 * the app's user alone; one that exists must be a folder of the user's —
 * never a symbolic link — and is narrowed to the user alone, as are its
 * sessions' folders. Another user able to write in it could plant the files
 * the cockpit reads, the app's token among them. The folders above it are
 * opened first, as {@link openParentFolders} says: checked, then the
 * missing ones created.
 *
 * @param path - The folder, from {@link stateFolderPath}.
 * @param options - How the folders above it are judged: see {@link ParentFolderOptions}.
 * @returns The open folder.
 * @throws {@link UntrustedStateError} when the folder, or its sessions'
 * folder, is a symbolic link, a file or another user's, or a folder above
 * it could be changed by another user; the file system's error when it
 * cannot be created.
 */
export async function openStateFolder(
  path: string,
  options: ParentFolderOptions = {},
): Promise<StateFolder> {
  await openParentFolders(dirname(path), options);
  await openOwnFolder(path);
  const sessions = join(path, SESSIONS_FOLDER);
  await openOwnFolder(sessions);
  return {
    path,
    sessions: {
      async prepare(key) {
        const folder = sessionFolderOf(sessions, key);
        await openOwnFolder(folder);
        return folder;
      },
      async remove(key) {
        // `rm` deletes a link as a link, at the top as below it: nothing is followed out.
        await rm(sessionFolderOf(sessions, key), { recursive: true, force: true });
      },
    },
  };
}

/**
 * The folder of a session's key in the sessions' folder.
 *
 * @throws `TypeError` when the key is no session key.
 */
function sessionFolderOf(sessions: string, key: string): string {
  // A key holds no `/` or `.`, so its folder never leaves the sessions' folder.
  if (!isSessionKey(key)) throw new TypeError(`${JSON.stringify(key)} is no session key.`);
  return join(sessions, key);
}
