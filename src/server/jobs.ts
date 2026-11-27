import type { z } from 'zod';
import { CockpitError, type Issue } from '../shared/cockpit-error.js';
import type { Choice } from '../shared/job.js';
import { isSessionKey, SESSION_KEY_MAX_LENGTH } from '../shared/session.js';
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
   * the form `[a-z0-9-]+`, 100 characters at most. Two runs whose arguments give one key share a
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
   * The fields whose values come from the app's data, by name: a source
   * gives a field's choices from the arguments filled so far (dependent
   * choices), and a run's value must be one of them; a source given as
   * `{ choices, suggestions: true }` only suggests, and any value fits.
   */
  readonly options?: JobOptions<Args>;
  /**
   * Gives the folder the agent works in, relative to the app's folder and
   * inside it; without it, the app's folder. The first start of a key
   * records it, and so does a fresh start (a run with `fresh`, a `fresh`
   * job's on an `ended` session, an open with `fresh`); any other run that
   * gives another is refused (`folder-changed`), and so is an open or a
   * send to an `ended` session, which read the key's last run again.
   *
   * @param args - The arguments, as the schema gave them.
   */
  directory?(args: z.output<Args>): string;
  /**
   * Starts a new conversation when a run finds the key's session `ended`,
   * rather than resuming it (the default).
   */
  readonly fresh?: true;
  /**
   * The job's driver part, built by the driver's factory
   * (`claudeCode.job(…)`): the agent's own options for the job's sessions,
   * laid over the app's. The driver checks it, at `createCockpit`, at each
   * run, and at an open or a send to an `ended` session, which launch with
   * the key's last run.
   */
  readonly driver?: DriverPart;
}

/**
 * Gives a field's choices from the app's data, given the arguments filled so
 * far, each checked against the schema: none, some or all of them. A
 * method's signature, so that a job of any schema is a `Job`.
 */
export type OptionSource<Args extends z.ZodType = z.ZodType> = {
  source(argsSoFar: Partial<z.output<Args>>): readonly Choice[] | Promise<readonly Choice[]>;
}['source'];

/** A field's option source: one whose choices bind, or one that only suggests. */
export type FieldOptions<Args extends z.ZodType = z.ZodType> =
  | OptionSource<Args>
  | { readonly choices: OptionSource<Args>; readonly suggestions: true };

/** A job's option sources, by the name of the field each gives the choices of. */
export type JobOptions<Args extends z.ZodType = z.ZodType> = {
  readonly [Field in keyof z.output<Args> & string]?: FieldOptions<Args>;
};

/**
 * What a job's run asks of the sessions: its key, its first prompt and its
 * driver part; and the arguments as the schema gave them, which the option
 * and folder checks read.
 */
export interface JobLaunch {
  readonly key: string;
  readonly prompt?: string;
  readonly part?: DriverPart;
  readonly args: unknown;
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
 * @returns The key, the prompt, the job's driver part and the arguments as
 * the schema gave them.
 * @throws `CockpitError` `invalid-arguments`, with each issue, when the
 * arguments do not fit; `invalid-options`, its issue at `key`, when the
 * job's `key` gives no session key (`[a-z0-9-]+`, 100 characters at
 * most). What the job's own `key`
 * or `prompt` throws.
 */
export function launchOfJob(job: Job, args: unknown): JobLaunch {
  const parsed = checkedArguments(job, job.args, args);
  const prompt = job.prompt?.(parsed);
  return {
    key: keyOf(job, parsed),
    ...(prompt === undefined ? {} : { prompt }),
    ...(job.driver === undefined ? {} : { part: job.driver }),
    args: parsed,
  };
}

/**
 * Checks arguments against a schema of a job's: its own, or one made from
 * it.
 *
 * @param job - The job, for the error's message.
 * @param schema - The schema the arguments must fit.
 * @param args - The arguments, unchecked.
 * @returns The arguments as the schema gave them.
 * @throws `CockpitError` `invalid-arguments`, with each issue, when they do
 * not fit.
 */
export function checkedArguments(job: Pick<Job, 'id'>, schema: z.ZodType, args: unknown): unknown {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw new CockpitError(
      'invalid-arguments',
      `The arguments do not fit the job ${JSON.stringify(job.id)}.`,
      { issues: issuesOf(parsed.error.issues) },
    );
  }
  return parsed.data;
}

/**
 * The key a job gives: a key names a tmux session, a folder and a segment
 * of the wire's paths, so a job's mistake there is refused before it
 * reaches any of them.
 */
function keyOf(job: Job, args: unknown): string {
  const key: unknown = job.key(args);
  if (typeof key === 'string' && isSessionKey(key)) return key;
  throw new CockpitError(
    'invalid-options',
    `The job ${JSON.stringify(job.id)} gives no session key.`,
    {
      issues: [
        {
          path: ['key'],
          message: `Expected a session key, [a-z0-9-]+ of ${SESSION_KEY_MAX_LENGTH} characters at most: got ${JSON.stringify(key)}.`,
        },
      ],
    },
  );
}

/**
 * Gives a job's schema as the object schema it must be, its fields the
 * job's arguments.
 *
 * @param args - The job's argument schema.
 * @returns The schema as an object schema; `undefined` when it is another
 * kind of schema (a string, a union, a pipe).
 */
export function objectSchemaOf(args: z.ZodType): z.ZodObject | undefined {
  // The schema's own kind, not `instanceof`: the app's zod may be another
  // copy of the library than the cockpit's.
  const kind: unknown = (args as { def?: { type?: unknown } }).def?.type;
  return kind === 'object' ? (args as unknown as z.ZodObject) : undefined;
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
