import { mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CockpitError } from '../shared/cockpit-error.js';
import type { Job } from './jobs.js';

/** The folder a unit of work runs in. */
export interface JobFolder {
  /**
   * Its real path, every link followed: where the agent is launched. A
   * folder not made yet has the path it will have.
   */
  readonly path: string;
  /**
   * Its path relative to the app's real folder, `.` for the app's own:
   * what a key's record keeps, so that it stays valid if the app's folder
   * moves.
   */
  readonly relative: string;
}

/**
 * Gives the folder a run of a job works in: the one its `directory` gives,
 * relative to the app's folder; the app's folder when it gives none. It
 * makes nothing: {@link makeJobFolder} does, at a start.
 *
 * @param appFolder - The app's folder, absolute.
 * @param job - The job.
 * @param args - The run's arguments, as the job's schema gave them.
 * @returns The folder.
 * @throws `CockpitError` `folder-outside-app`, naming the folder the job
 * gave, when its real path lies outside the app's real folder;
 * `invalid-options`, its issue at `directory`, when the job gives no text.
 * What the job's own `directory` throws.
 */
export async function folderOfJob(appFolder: string, job: Job, args: unknown): Promise<JobFolder> {
  const folder: unknown = job.directory === undefined ? '.' : job.directory(args);
  if (typeof folder !== 'string') {
    throw new CockpitError(
      'invalid-options',
      `The job ${JSON.stringify(job.id)} gives no folder.`,
      {
        issues: [
          { path: ['directory'], message: `Expected a path: got ${JSON.stringify(folder)}.` },
        ],
      },
    );
  }
  return folderInsideApp(appFolder, folder);
}

/**
 * Resolves a folder against the app's: its real path, every link followed
 * (of a folder not made yet, every link of the part that exists), which must
 * lie inside the app's real folder. A recorded folder is checked so at each
 * launch: a link may have taken it out since.
 *
 * @param appFolder - The app's folder, absolute.
 * @param folder - The folder, relative to the app's (an absolute one is
 * taken as it is).
 * @returns The folder.
 * @throws `CockpitError` `folder-outside-app`, naming the folder as given,
 * when it lies outside.
 */
export async function folderInsideApp(appFolder: string, folder: string): Promise<JobFolder> {
  const app = await realpath(appFolder);
  const path = await realPathOf(resolve(app, folder));
  const inside = relative(app, path);
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new CockpitError(
      'folder-outside-app',
      // Named as given alone: the server's paths stay off the wire and the pages.
      `The folder ${JSON.stringify(folder)} lies outside the app's folder.`,
      { folder },
    );
  }
  return { path, relative: inside === '' ? '.' : inside };
}

/**
 * Makes a job's folder, with the folders above it that are missing, then
 * checks it again: a link put in its way since it was checked would have
 * led the making out of the app's folder.
 *
 * @param appFolder - The app's folder, absolute.
 * @param folder - The folder, as {@link folderOfJob} gave it.
 * @returns The folder, made.
 * @throws `CockpitError` `folder-outside-app`, naming its relative path,
 * when it now lies outside. What the system's `mkdir` throws: a file in its
 * way, a folder the app may not write in.
 */
export async function makeJobFolder(appFolder: string, folder: JobFolder): Promise<JobFolder> {
  await mkdir(folder.path, { recursive: true });
  return folderInsideApp(appFolder, folder.relative);
}

/**
 * Holds a unit of work to its folder: a run of its key whose job gives
 * another folder than the one recorded at its first start is refused.
 *
 * @param recorded - The folder the key's record keeps, relative to the
 * app's; none before the first start, or for a fresh start.
 * @param computed - The folder the run's job gives.
 * @throws `CockpitError` `folder-changed`, with both relative paths, when
 * they differ.
 */
export function checkRecordedFolder(recorded: string | undefined, computed: JobFolder): void {
  if (recorded === undefined || recorded === computed.relative) return;
  throw new CockpitError(
    'folder-changed',
    `The job gives the folder ${JSON.stringify(computed.relative)}, and the unit of work started in ${JSON.stringify(recorded)}.`,
    { recorded, computed: computed.relative },
  );
}

/** The real path of the part that exists, the rest of the path below it. */
async function realPathOf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    const parent = dirname(path);
    if (!isMissing(error) || parent === path) throw error;
    return join(await realPathOf(parent), basename(path));
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
