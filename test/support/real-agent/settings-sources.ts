import { lstatSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The folders a launch has the agent read settings from. */
export interface SettingsFolders {
  /** The agent's configuration folder: the user's settings. */
  readonly configFolder: string;
  /** The folder the session works in: the project's settings. */
  readonly workFolder: string;
  /** The folders the machine keeps settings in that an organization manages. */
  readonly managedSettingsFolders: readonly string[];
}

/** The project's settings and its local ones, in a folder's `.claude`. */
const PROJECT_SETTINGS = ['settings.json', 'settings.local.json'];

/** The folder of a managed settings folder that holds more files of them. */
const MANAGED_DROP_INS = 'managed-settings.d';

/**
 * Lists every settings file the agent would read at a launch, beside the
 * settings of its command line. Seen of the pinned agent: the user's
 * settings in its configuration folder; the project's settings and its
 * local settings in the work folder; the local settings of the git
 * repository the work folder is in, which is a folder above it. So every
 * folder above the work folder counts, up to the top, in the root or above
 * it: which of them the agent reads is not this list's to guess. Then what
 * the agent keeps of an organization's settings in its configuration
 * folder, and the machine's managed settings (`/etc/claude-code` on Linux,
 * the Windows folder a WSL machine may inherit), with their drop-in files.
 *
 * Not listed, since no file holds them: the policy keys of the Windows
 * registry, which the agent asks for on WSL.
 *
 * @param folders - Where the launch has the agent read settings.
 * @returns The paths of the files that exist, a link that leads nowhere included.
 */
export function settingsFilesOf(folders: SettingsFolders): string[] {
  const candidates = [
    join(folders.configFolder, 'settings.json'),
    join(folders.configFolder, 'remote-settings.json'),
    ...withFoldersAbove(folders.workFolder).flatMap((folder) =>
      PROJECT_SETTINGS.map((name) => join(folder, '.claude', name)),
    ),
    ...folders.managedSettingsFolders.flatMap(managedFilesOf),
  ];
  return candidates.filter((path) => lstatSync(path, { throwIfNoEntry: false }) !== undefined);
}

function withFoldersAbove(folder: string): string[] {
  const above = dirname(folder);
  return above === folder ? [folder] : [folder, ...withFoldersAbove(above)];
}

function managedFilesOf(folder: string): string[] {
  const dropIns = join(folder, MANAGED_DROP_INS);
  return [
    join(folder, 'managed-settings.json'),
    ...namesIn(dropIns)
      .filter((name) => name.endsWith('.json'))
      .map((name) => join(dropIns, name)),
  ];
}

function namesIn(folder: string): string[] {
  try {
    return readdirSync(folder);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
