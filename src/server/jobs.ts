import type { z } from 'zod';
import { CockpitError, type Issue } from '../shared/cockpit-error.js';
import type { DriverPart } from './driver.js';

/**
 * A job: one kind of work the app offers, whose run starts the agent on a
 * unit of work named by its arguments.
 *
 * @typeParam Args - The job's argument schema, zod 4.
 */
export interface Job<Args extends z.ZodType = z.ZodType> {
  /** The job's id, unique among the app's jobs. */
  readonly id: string;
  /** What the job is called, for the person. */
  readonly title: string;
  /** What the job does, for the person. */
  readonly description?: string;
  /** The schema the arguments of a run must fit. */
  readonly args: Args;
  /**
   * Names the unit of work the arguments stand for: the session's key, of
   * the form `[a-z0-9-]+`. Two runs whose arguments give one key share a
   * session.
   *
   * @param args - The arguments, as the schema gave them.
   */
  key(args: z.output<Args>): string;
  /**
   * Gives the prompt the agent starts on; without it, the job is one for
   * typing, whose run starts the agent with no prompt.
   *
   * @param args - The arguments, as the schema gave them.
   */
  prompt?(args: z.output<Args>): string;
  /**
   * The job's driver part, built by the driver's factory
   * (`claudeCode.job(…)`): the agent's own options for the job's sessions,
   * laid over the app's. The driver checks it, at `createCockpit` and at
   * each run.
   */
  readonly driver?: DriverPart;
}

/** What a job's run asks of the sessions: its key, its first prompt and its driver part. */
export interface JobLaunch {
  readonly key: string;
  readonly prompt?: string;
  readonly part?: DriverPart;
}

/**
 * Finds the job a run names.
 *
 * @param jobs - The app's jobs, by id.
 * @param jobId - The id the run names.
 * @returns The job.
 * @throws `CockpitError` `unknown-job` when no job has the id.
 */
export function jobOf(jobs: ReadonlyMap<string, Job>, jobId: string): Job {
  const job = jobs.get(jobId);
  if (job === undefined) {
    throw new CockpitError('unknown-job', `The app has no job ${JSON.stringify(jobId)}.`, {
      jobId,
    });
  }
  return job;
}

/**
 * Reads a run of a job: checks the arguments against its schema, and
 * derives the key and the prompt from what the schema gave.
 *
 * @param job - The job the run names.
 * @param args - The run's arguments, unchecked.
 * @returns The key, the prompt and the job's driver part.
 * @throws `CockpitError` `invalid-arguments`, with each issue, when the
 * arguments do not fit. What the job's own `key` or `prompt` throws.
 */
export function launchOfJob(job: Job, args: unknown): JobLaunch {
  const parsed = job.args.safeParse(args);
  if (!parsed.success) {
    throw new CockpitError(
      'invalid-arguments',
      `The arguments do not fit the job ${JSON.stringify(job.id)}.`,
      { issues: issuesOf(parsed.error.issues) },
    );
  }
  const prompt = job.prompt?.(parsed.data);
  return {
    key: job.key(parsed.data),
    ...(prompt === undefined ? {} : { prompt }),
    ...(job.driver === undefined ? {} : { part: job.driver }),
  };
}

/**
 * The issues of zod as the cockpit's: a path of names and indexes (a symbol
 * written as its description) and the message.
 */
export function issuesOf(issues: readonly z.core.$ZodIssue[]): Issue[] {
  return issues.map(({ path, message }) => ({
    path: path.map((part) => (typeof part === 'symbol' ? String(part.description) : part)),
    message,
  }));
}
