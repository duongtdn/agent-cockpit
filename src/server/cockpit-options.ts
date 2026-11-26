import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { CockpitError, type Issue } from '../shared/cockpit-error.js';
import type { Driver } from './driver.js';
import { issuesOf, type Job } from './jobs.js';

/** What `createCockpit` takes. */
export interface CockpitOptions {
  /**
   * The app's name: its tmux socket, its state folder and its lock are
   * named after it. Any non-empty text.
   */
  readonly name: string;
  /**
   * The app's folder, where its sessions run: an existing folder, absolute
   * or relative to the server's working folder.
   */
  readonly directory: string;
  /** The driver of the agent the sessions run: `claudeCode(…)`. */
  readonly driver: Driver;
  /** The jobs the app offers, each with an id of its own. */
  readonly jobs: readonly Job[];
  /**
   * Where the cockpit keeps its own files; by default
   * `$XDG_STATE_HOME/agent-cockpit/<name>` (`~/.local/state` when
   * `XDG_STATE_HOME` is unset).
   */
  readonly stateDirectory?: string;
  /**
   * The port of the cockpit's agent-facing listener, on `127.0.0.1`; by
   * default one the system chooses at the first start, then the same one
   * at every start.
   */
  readonly agentPort?: number;
}

const JOB_FIELDS: readonly string[] = ['id', 'title', 'description', 'args', 'key', 'prompt'];

const OPTION_NAMES: readonly string[] = [
  'name',
  'directory',
  'driver',
  'jobs',
  'stateDirectory',
  'agentPort',
];

const isFunction = (value: unknown): boolean => typeof value === 'function';

const schemaLike = z.custom<z.ZodType>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    isFunction((value as { safeParse?: unknown }).safeParse),
  'Expected a zod schema.',
);

const job = z.object({
  id: z.string().min(1),
  title: z.string(),
  description: z.string().optional(),
  args: schemaLike,
  key: z.custom(isFunction, 'Expected a function from the arguments to the key.'),
  prompt: z.custom(isFunction, 'Expected a function from the arguments to the prompt.').optional(),
});

const driver = z.custom<Driver>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    ['launch', 'readHook', 'canResume'].every((name) =>
      isFunction((value as Record<string, unknown>)[name]),
    ) &&
    Array.isArray((value as { terminalKeys?: unknown }).terminalKeys),
  'Expected a driver, as claudeCode(…) gives one.',
);

const options = z.object({
  name: z.string().min(1),
  directory: z.string().min(1),
  driver,
  jobs: z.array(job),
  stateDirectory: z.string().min(1).optional(),
  agentPort: z.int().min(1).max(65535).optional(),
});

/**
 * Checks `createCockpit`'s options: what this version takes, of the right
 * kinds, the jobs' ids unique, the app's folder an existing folder. An
 * option or a job's field that a later version takes is refused rather than
 * silently ignored.
 *
 * @param given - What the app gave, unchecked: an app in JavaScript gives anything.
 * @returns The options, the app's folder absolute.
 * @throws `CockpitError` `invalid-options` with every issue found.
 */
export async function checkCockpitOptions(given: unknown): Promise<CockpitOptions> {
  if (typeof given !== 'object' || given === null) {
    throw invalidOptions([{ path: [], message: 'Expected the options, an object.' }]);
  }
  const parsed = options.safeParse(given);
  const issues = [
    ...unknownNames(given, OPTION_NAMES, [], 'Not an option of this version of the cockpit.'),
    ...jobIssues((given as { jobs?: unknown }).jobs),
    ...(parsed.success ? [] : issuesOf(parsed.error.issues)),
  ];
  if (!parsed.success || issues.length > 0) throw invalidOptions(issues);
  const checked = given as CockpitOptions;
  const directory = resolve(checked.directory);
  if (!(await isFolder(directory))) {
    throw invalidOptions([{ path: ['directory'], message: `No folder at ${directory}.` }]);
  }
  return { ...checked, directory };
}

/** The issues of the jobs beyond their schema: fields of a later version, ids given twice. */
function jobIssues(jobs: unknown): Issue[] {
  if (!Array.isArray(jobs)) return [];
  const seen = new Set<unknown>();
  return jobs.flatMap((each: unknown, index) => {
    if (typeof each !== 'object' || each === null) return [];
    const { id } = each as { id?: unknown };
    const twice = seen.has(id)
      ? [{ path: ['jobs', index, 'id'], message: `Another job has the id ${JSON.stringify(id)}.` }]
      : [];
    seen.add(id);
    return [
      ...unknownNames(
        each,
        JOB_FIELDS,
        ['jobs', index],
        'Not a job field of this version of the cockpit.',
      ),
      ...twice,
    ];
  });
}

function unknownNames(
  value: object,
  known: readonly string[],
  path: readonly (string | number)[],
  message: string,
): Issue[] {
  return Object.keys(value)
    .filter((name) => !known.includes(name))
    .map((name) => ({ path: [...path, name], message }));
}

async function isFolder(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function invalidOptions(issues: readonly Issue[]): CockpitError<'invalid-options'> {
  return new CockpitError('invalid-options', "The cockpit's options do not fit.", { issues });
}
