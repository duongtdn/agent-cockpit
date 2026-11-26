import { stat } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { resolve } from 'node:path';
import { z } from 'zod';
import { CockpitError, type Issue } from '../shared/cockpit-error.js';
import type { Driver, SessionNetwork } from './driver.js';
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
  /**
   * The jobs the app offers, each with an id of its own. A job's `driver`
   * part is checked by the driver, and refused as the driver's own options
   * are when it opens the network of a cockpit opened beyond loopback.
   */
  readonly jobs: readonly Job[];
  /**
   * The names of the variables of the server's environment that no
   * session's agent gets: the app's secrets. Each launch starts from the
   * server's environment at that moment without them; the driver then
   * removes its agent's own (for Claude Code, every `CLAUDE_CODE_*` and
   * `CLAUDECODE`). The agent's own settings files, the person's, may still
   * give it variables: those are the person's. The app's tmux server is
   * not given them either, and drops them from its global environment.
   * This is hygiene, not a boundary: the agent runs as the app's user, and
   * a process of that user can read the app's own environment
   * (`/proc/<pid>/environ`).
   */
  readonly hiddenEnv?: readonly string[];
  /**
   * The folder the cockpit keeps its own files in — the folder itself, not
   * a parent of it; by default `$XDG_STATE_HOME/agent-cockpit/<name>`
   * (`~/.local/state` when `XDG_STATE_HOME` is unset). It is the cockpit's
   * own, so private: created readable by the app's user alone when
   * missing; one that exists must be a folder of the user's, never a
   * symbolic link, and is narrowed to the user alone; every folder above
   * it must be the user's or root's, writable by others only with the
   * sticky bit, by its group only so or when the group is the user's
   * private one (missing ones are created `0755`). A file the cockpit
   * reads in it must be a regular file of the user's: one others could read
   * is narrowed, the app's token minted anew. Otherwise `createCockpit`
   * rejects with `invalid-options`.
   */
  readonly stateDirectory?: string;
  /**
   * The port of the cockpit's agent-facing listener, on `127.0.0.1`; by
   * default one the system chooses at the first start, then the same one
   * at every start.
   */
  readonly agentPort?: number;
  /**
   * Opens the cockpit beyond loopback: a remote request — from another
   * address, or carrying a forwarding header — is served only when this
   * resolves `true`; it needs no app token. Without it every remote request
   * is refused. A function that throws or rejects refuses the request, and
   * the failure goes to the cockpit's `error` handlers. `authorize: (req)
   * => cockpit.verify(req)` opens remote access by the link. A driver whose
   * sessions reach an open network refuses it unless the app accepted that
   * in the driver's options. It must settle: the request waits for it, and
   * the cockpit sets no time limit on it (bounding it is the app's); one
   * still pending when the cockpit closes is answered 503. It is asked once
   * a request: a request whose admission overlaps a renewal of the token
   * (`renewToken`) is not admitted, whatever it resolves, but answered 503
   * with `Retry-After`, and asked afresh when it comes back as a new one.
   */
  readonly authorize?: (request: IncomingMessage) => boolean | Promise<boolean>;
  /**
   * The origins, beyond `127.0.0.1` and `localhost` on any port, that a
   * request's `Origin` may be and its `Host` may name: each as a browser
   * sends it (`https://app.example`, `http://10.0.0.5:8765`), no path.
   */
  readonly origins?: readonly string[];
  /**
   * The terminal's switch: `'on'` (the default) follows the other surfaces;
   * `'loopback'` refuses every remote terminal request, opened or not;
   * `'off'` refuses every terminal request, local ones included.
   */
  readonly terminal?: 'on' | 'loopback' | 'off';
  /**
   * The port, or the ports, the app's browser-facing server listens on,
   * which every session's sandbox is kept from. Required with the neutral
   * handler: a launch while no port of the app's is known is refused
   * (`no-app-port`). The Fastify adapter reads it once the server listens.
   */
  readonly port?: number | readonly number[];
}

/** The options once checked: the app's folder absolute, the access options with their values. */
export interface CheckedCockpitOptions extends CockpitOptions {
  /** The origins allowed beyond loopback; none when left out. */
  readonly origins: readonly string[];
  /** The terminal's switch; `'on'` when left out. */
  readonly terminal: 'on' | 'loopback' | 'off';
  /** The app's ports the app gave; none when left out. */
  readonly ports: readonly number[];
  /** The variables hidden from every session; none when left out. */
  readonly hiddenEnv: readonly string[];
}

const JOB_FIELDS: readonly string[] = [
  'id',
  'title',
  'description',
  'args',
  'key',
  'prompt',
  'driver',
];

const OPTION_NAMES: readonly string[] = [
  'name',
  'directory',
  'driver',
  'jobs',
  'hiddenEnv',
  'stateDirectory',
  'agentPort',
  'authorize',
  'origins',
  'terminal',
  'port',
];

const isFunction = (value: unknown): boolean => typeof value === 'function';

const DRIVER_FUNCTIONS: readonly string[] = [
  'launch',
  'readHook',
  'canResume',
  'agentVersion',
  'checkPart',
  'networkOf',
  'readScreen',
];

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
  // Its own driver checks it: the core does not know its shape.
  driver: z.unknown().optional(),
});

const driver = z.custom<Driver>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    DRIVER_FUNCTIONS.every((name) => isFunction((value as Record<string, unknown>)[name])) &&
    Array.isArray((value as { terminalKeys?: unknown }).terminalKeys),
  'Expected a driver, as claudeCode(…) gives one.',
);

const port = z.int().min(1).max(65535);

const variableName = z
  .string()
  .regex(/^[^=\0]+$/, "Expected a variable's name: not empty, with no = or NUL in it.");

const origin = z
  .string()
  .refine(
    isWebOrigin,
    'Expected an origin as a browser sends it: http: or https:, the host in lower case, a port or none, no path (https://app.example).',
  );

/** An `http:` or `https:` origin as a browser sends it: what `URL` gives back as its own origin. */
function isWebOrigin(text: string): boolean {
  const url = URL.canParse(text) ? new URL(text) : undefined;
  return (url?.protocol === 'http:' || url?.protocol === 'https:') && url.origin === text;
}

const options = z.object({
  name: z.string().min(1),
  directory: z.string().min(1),
  driver,
  jobs: z.array(job),
  hiddenEnv: z.array(variableName).optional(),
  stateDirectory: z.string().min(1).optional(),
  agentPort: port.optional(),
  authorize: z.custom(isFunction, 'Expected a function from the request to a boolean.').optional(),
  origins: z.array(origin).optional(),
  terminal: z.enum(['on', 'loopback', 'off']).optional(),
  port: z.union([port, z.array(port).min(1)]).optional(),
});

/**
 * Checks `createCockpit`'s options: what this version takes, of the right
 * kinds, the jobs' ids unique, each job's driver part fitting the driver,
 * the app's folder an existing folder, and no cockpit opened beyond
 * loopback with a driver, or a job, whose sessions reach an open network
 * the app did not accept. An option or a job's field that a later version
 * takes is refused rather than silently ignored.
 *
 * @param given - What the app gave, unchecked: an app in JavaScript gives anything.
 * @returns The options, the app's folder absolute, the access options with
 * their values.
 * @throws `CockpitError` `invalid-options` with every issue found.
 */
export async function checkCockpitOptions(given: unknown): Promise<CheckedCockpitOptions> {
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
  const driverIssues = [...openNetworkIssues(checked), ...jobsPartIssues(checked)];
  if (driverIssues.length > 0) throw invalidOptions(driverIssues);
  const directory = resolve(checked.directory);
  if (!(await isFolder(directory))) {
    throw invalidOptions([{ path: ['directory'], message: `No folder at ${directory}.` }]);
  }
  return {
    ...checked,
    directory,
    origins: checked.origins ?? [],
    terminal: checked.terminal ?? 'on',
    ports: checked.port === undefined ? [] : [checked.port].flat(),
    hiddenEnv: checked.hiddenEnv ?? [],
  };
}

/**
 * Refuses a cockpit opened beyond loopback whose driver's sessions reach
 * the network beyond the allow-list without asking: they could read a token
 * that works from afar. The app accepts it in the driver's options.
 */
function openNetworkIssues({ authorize, driver }: CockpitOptions): Issue[] {
  const refusal = openNetworkRefusal(authorize, driver.networkOf());
  if (refusal === undefined) return [];
  return [
    {
      path: ['driver'],
      message: `The cockpit is opened beyond loopback (authorize), and the driver's sessions reach an open network. ${refusal}`,
    },
  ];
}

/** Each job's part issues, their paths from the options. */
function jobsPartIssues(options: CockpitOptions): Issue[] {
  return options.jobs.flatMap((job, index) =>
    jobPartIssues(options, job).map(({ path, message }) => ({
      path: ['jobs', index, ...path],
      message,
    })),
  );
}

/**
 * Checks a job's driver part, as the cockpit launches it: the driver's
 * check of its shape, then the network its sessions reach — refused, as
 * the driver's own options are, when the cockpit is opened beyond loopback
 * and the app did not accept it (ADR-0081).
 *
 * @param options - The cockpit's options: its driver and its `authorize`.
 * @param job - The job, its `driver` unchecked.
 * @returns Every issue found, each path from the job; none for a job with
 * no part.
 */
export function jobPartIssues(
  { authorize, driver }: Pick<CockpitOptions, 'authorize' | 'driver'>,
  job: Pick<Job, 'id' | 'driver'>,
): Issue[] {
  if (job.driver === undefined) return [];
  const shape = driver
    .checkPart(job.driver)
    .map(({ path, message }) => ({ path: ['driver', ...path], message }));
  if (shape.length > 0) return shape;
  const refusal = openNetworkRefusal(authorize, driver.networkOf(job.driver));
  if (refusal === undefined) return [];
  return [
    {
      path: ['driver'],
      message: `The cockpit is opened beyond loopback (authorize), and the sessions of the job ${JSON.stringify(job.id)} reach an open network. ${refusal}`,
    },
  ];
}

/**
 * Why a cockpit opened beyond loopback must not launch sessions with this
 * network: the driver's reason, when it is open and not accepted.
 */
function openNetworkRefusal(
  authorize: CockpitOptions['authorize'],
  network: SessionNetwork,
): string | undefined {
  if (authorize === undefined || network.reach === 'confined' || network.accepted) return undefined;
  return network.reason;
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
