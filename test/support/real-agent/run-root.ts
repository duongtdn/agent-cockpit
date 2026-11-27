import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { basename, join } from 'node:path';
import { cameTrue } from '../eventually.ts';
import { PATIENCE } from '../patience.ts';
import {
  type AgentFolders,
  agentConfiguration,
  type RecipePiece,
  ROOT_NAME_PREFIX,
} from './environment.ts';

/**
 * Makes the temporary root of a run of the real agent, and its folders: the
 * agent's `HOME`, its configuration folder with a configuration that starts
 * it at its input prompt, a trusted work folder, its temporary folder.
 *
 * @param leftOut - The pieces of that configuration left out; none by default.
 * @returns The folders; the caller removes the root.
 */
export async function createAgentFolders(
  leftOut: readonly RecipePiece[] = [],
): Promise<AgentFolders> {
  // Resolved: the agent looks a folder's trust up by its resolved path.
  const root = await mkdtemp(join(await realpath(tmpdir()), ROOT_NAME_PREFIX));
  const inside = {
    home: join(root, 'home'),
    configFolder: join(root, 'config'),
    workFolder: join(root, 'work'),
    temporaryFolder: join(root, 'tmp'),
  };
  for (const folder of Object.values(inside)) await mkdir(folder);
  const folders = { root, ...inside };
  await writeFile(
    join(folders.configFolder, '.claude.json'),
    JSON.stringify(agentConfiguration(folders, leftOut)),
  );
  return folders;
}

/**
 * Lists the folders an agent made for sessions under a root in the machine's
 * temporary folder: it names each after the session's working folder, so
 * each carries the root's name.
 *
 * @param root - The run's temporary root.
 * @returns The folders' paths; none when everything stayed in the root.
 */
export function agentFoldersOutside(root: string): string[] {
  const agentFolder = join(tmpdir(), `claude-${userInfo().uid}`);
  if (!existsSync(agentFolder)) return [];
  return readdirSync(agentFolder)
    .filter((name) => name.includes(basename(root)))
    .map((name) => join(agentFolder, name));
}

/** What a run ends. */
export interface RunToEnd {
  /** Ends the sessions and their tmux server. */
  readonly endSessions: () => Promise<void>;
  /** The agents' processes, waited for once their sessions are gone. */
  readonly processIds: readonly number[];
  /** The run's temporary root, removed last. */
  readonly root: string;
}

/**
 * Ends a run: its sessions, then its agents' processes, then its root.
 * Every step is tried, whatever the one before did: a failed test must
 * leave nothing behind either.
 *
 * @param run - See {@link RunToEnd}.
 */
export async function tearDownRun({ endSessions, processIds, root }: RunToEnd): Promise<void> {
  try {
    await endSessions();
  } finally {
    try {
      // An agent still writes its files while it exits.
      await Promise.all(processIds.map(exited));
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    }
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits for a process to exit once its terminal is gone, and kills one that does not. */
async function exited(pid: number): Promise<void> {
  if (!(await cameTrue(() => !isRunning(pid), PATIENCE.exit))) process.kill(pid, 'SIGKILL');
}
