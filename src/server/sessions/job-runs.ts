import { CockpitError, type Issue } from '../../shared/cockpit-error.js';
import type { DriverPart } from '../driver.js';
import { folderInsideApp, folderOfJob, type JobFolder, makeJobFolder } from '../job-folders.js';
import { checkChoices } from '../job-options.js';
import { type Job, jobOf, launchOfJob } from '../jobs.js';

/** A run of a job, read: what the units of work act on. */
export interface JobRun {
  /** The job's id. */
  readonly jobId: string;
  /** The key of its unit of work. */
  readonly key: string;
  /** Its prompt; none for a job for typing. */
  readonly prompt?: string;
  /** The job's driver part, checked; none when it has none. */
  readonly part?: DriverPart;
  /**
   * The arguments as the run was given them, the schema's input: what the
   * key's history keeps, which an open or a send reads again with every
   * check. What the schema gives (a number from a text, a server path)
   * stays out of the record, and out of the pages it is shown to.
   */
  readonly args: unknown;
  /** The folder the job gives, not made yet. */
  readonly folder: JobFolder;
  /** Whether the job starts a new conversation on an `ended` session. */
  readonly fresh: boolean;
}

/**
 * A run of a job read as far as it can be at once: its key and its prompt
 * known, the checks that wait on the app's data and the file system still
 * to come.
 */
export interface JobRunReading {
  /** The key of its unit of work: its place among the key's operations. */
  readonly key: string;
  /** Its prompt; none for a job for typing. */
  readonly prompt?: string;
  /**
   * Checks the rest: its values against their option sources, its folder
   * inside the app's.
   *
   * @returns The run.
   * @throws `CockpitError` `not-a-choice`; `invalid-options` when a source
   * gives no list of choices, or the job gives no folder;
   * `folder-outside-app`. What the job's option sources and `directory`
   * throw.
   */
  checked(): Promise<JobRun>;
}

/**
 * The app's jobs, as the units of work read a run of one: every check of
 * a run, the same for a run and for an open or a send, which read the
 * key's last run again.
 */
export interface JobRuns {
  /**
   * Reads a run of a job: its arguments, its key, its prompt and its
   * driver part as it is launched, at once; then, through the reading,
   * its values against their option sources and its folder.
   *
   * @param jobId - The job's id.
   * @param args - The arguments, unchecked.
   * @returns The reading.
   * @throws `CockpitError` `unknown-job`, `invalid-arguments`;
   * `invalid-options` when the job gives no session key, or its driver part
   * does not fit as it is launched (its shape, or a reach beyond the
   * cockpit's lines that a cockpit opened beyond loopback does not
   * accept). What the job's own `key` and `prompt` throw.
   */
  read(jobId: string, args: unknown): JobRunReading;
  /**
   * Makes a run's folder if it is missing, then checks it again.
   *
   * @param folder - The folder, as {@link read} gave it.
   * @returns The folder, made.
   * @throws `CockpitError` `folder-outside-app` when it now lies outside the
   * app's; what the system's `mkdir` throws.
   */
  makeFolder(folder: JobFolder): Promise<JobFolder>;
  /**
   * Finds a folder a record keeps, inside the app's.
   *
   * @param relative - The folder, relative to the app's.
   * @returns The folder.
   * @throws `CockpitError` `folder-outside-app` when it lies outside.
   */
  recordedFolder(relative: string): Promise<JobFolder>;
}

/** What the jobs' runs are read with. */
export interface JobRunsOptions {
  /** The app's jobs, by id. */
  readonly jobs: ReadonlyMap<string, Job>;
  /** The app's folder, absolute. */
  readonly appFolder: string;
  /**
   * Checks a job's driver part as it is launched: its shape, and how far
   * its sessions reach against how far the cockpit is opened.
   *
   * @returns Every issue, each path from the job; none when it fits.
   */
  readonly partIssues: (job: Job) => readonly Issue[];
}

/**
 * Reads the runs of the app's jobs.
 *
 * @param options - See {@link JobRunsOptions}.
 * @returns The reader.
 */
export function createJobRuns({ jobs, appFolder, partIssues }: JobRunsOptions): JobRuns {
  return {
    read(jobId, args) {
      const job = jobOf(jobs, jobId);
      const { args: parsed, ...launch } = launchOfJob(job, args);
      refuseUnfitPart(job, partIssues(job));
      return {
        key: launch.key,
        ...(launch.prompt === undefined ? {} : { prompt: launch.prompt }),
        async checked() {
          await checkChoices(job, parsed);
          const folder = await folderOfJob(appFolder, job, parsed);
          return { jobId, ...launch, args, folder, fresh: job.fresh === true };
        },
      };
    },
    makeFolder: (folder) => makeJobFolder(appFolder, folder),
    recordedFolder: (relative) => folderInsideApp(appFolder, relative),
  };
}

/**
 * Refuses a job whose driver part does not fit as it is launched:
 * `createCockpit` checked it, but the part is the app's object, and what
 * is launched is what is checked.
 */
function refuseUnfitPart(job: Job, issues: readonly Issue[]): void {
  if (issues.length === 0) return;
  throw new CockpitError(
    'invalid-options',
    `The driver part of the job ${JSON.stringify(job.id)} does not fit.`,
    { issues: [...issues] },
  );
}
