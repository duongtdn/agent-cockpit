import { lstatSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The folders a launch has the agent read settings from. */
export interface SettingsFolders {
  /** The agent's configuration folder: the user's settings. */
  readonly configFolder: string;
  /** The agent's home. */
  readonly homeFolder: string;
  /** The folder the session works in: the project's settings. */
  readonly workFolder: string;
  /** The folders the machine keeps settings in that an organization manages. */
  readonly managedSettingsFolders: readonly string[];
}

/** The project's settings and its local ones, in a folder's `.claude`. */
const PROJECT_SETTINGS = ['settings.json', 'settings.local.json'];

/** The file of a folder that gives a project MCP servers. */
const PROJECT_MCP_SERVERS = '.mcp.json';

/** The file of a managed settings folder that gives a machine MCP servers. */
const MANAGED_MCP_SERVERS = 'managed-mcp.json';

/** The agent's configuration file: its own state, and the person's and each project's MCP servers. */
const CONFIGURATION_FILE = '.claude.json';

/** The folder of the configuration folder that holds the person's plugins. */
const PLUGINS_FOLDER = 'plugins';

/** What marks a folder as a git work tree: a folder for a repository, a file for a worktree of one elsewhere. */
const GIT_MARKER = '.git';

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
 * registry, which the agent asks for on WSL. Not listed either: the local
 * settings of a repository elsewhere, which the agent reads when the work
 * folder is in a git worktree of it — {@link worktreeMarkerOf} finds those.
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
  return candidates.filter(exists);
}

/**
 * Lists the files that give a project MCP servers: `.mcp.json` in the
 * work folder and every folder above it.
 *
 * @param folders - Where the launch has the agent read settings.
 * @returns The paths of the files that exist, a link that leads nowhere included.
 */
export function projectMcpServerFilesOf(folders: SettingsFolders): string[] {
  return withFoldersAbove(folders.workFolder)
    .map((folder) => join(folder, PROJECT_MCP_SERVERS))
    .filter(exists);
}

/**
 * Lists the files that give the machine MCP servers an organization manages.
 *
 * @param folders - Where the launch has the agent read settings.
 * @returns The paths of the files that exist, a link that leads nowhere included.
 */
export function managedMcpServerFilesOf(folders: SettingsFolders): string[] {
  return folders.managedSettingsFolders
    .map((folder) => join(folder, MANAGED_MCP_SERVERS))
    .filter(exists);
}

/**
 * Lists the agent's configuration files, which hold the person's MCP
 * servers and each project's: `.claude.json` in the configuration folder
 * (which the pinned agent reads when `CLAUDE_CONFIG_DIR` is set) and in the
 * home (which it reads otherwise).
 *
 * @param folders - Where the launch has the agent read settings.
 * @returns The paths of the files that exist, a link that leads nowhere included.
 */
export function configurationFilesOf(folders: SettingsFolders): string[] {
  return [folders.configFolder, folders.homeFolder]
    .map((folder) => join(folder, CONFIGURATION_FILE))
    .filter(exists);
}

/**
 * Gives the folder of the person's plugins, where the agent finds the
 * marketplaces it knows and the plugins installed from them.
 *
 * @param folders - Where the launch has the agent read settings.
 * @returns Its path, whether it exists or not.
 */
export function pluginsFolderOf(folders: SettingsFolders): string {
  return join(folders.configFolder, PLUGINS_FOLDER);
}

/**
 * Finds what makes a folder part of a git worktree: a `.git` that is no
 * real folder — a file that names a repository elsewhere, or a link — in the
 * folder or any folder above it. The agent reads the local settings of that
 * repository, which is none of the folders above the work folder.
 *
 * @param workFolder - The folder the session works in.
 * @returns The path of the first such `.git`, or `undefined` when there is none.
 */
export function worktreeMarkerOf(workFolder: string): string | undefined {
  return withFoldersAbove(workFolder)
    .map((folder) => join(folder, GIT_MARKER))
    .find((marker) => exists(marker) && !lstatSync(marker).isDirectory());
}

function exists(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
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
