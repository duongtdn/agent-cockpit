import { lstatSync, realpathSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { FAKE_API_KEY, ROOT_NAME_PREFIX } from './environment.ts';

/** Everything a launch hands the agent that decides whom it calls and whose files it reads. */
export interface AgentLaunch {
  /** Every variable the agent would start with. */
  readonly environment: Readonly<Record<string, string>>;
  /** The content of its `--settings` file, parsed. */
  readonly settings: unknown;
  /** The temporary folder the run owns. */
  readonly root: string;
}

/** What the guard knows of the machine it runs on. */
export interface Machine {
  /** The machine's temporary folder, resolved. */
  readonly temporaryFolder: string;
  /** The person's home. */
  readonly home: string;
}

/** Tells why a variable's value is refused, or nothing when it may pass. */
type Rule = (value: string, root: string) => string | undefined;

const anyValue: Rule = () => undefined;

const aFolderInsideTheRoot: Rule = (value, root) =>
  isInside(value, root) ? undefined : `not a folder inside ${root}`;

const aLoopbackOrigin: Rule = (value) =>
  plainLoopbackOrigin(value) === value
    ? undefined
    : 'not the origin of a plain http address of the loopback interface, with its port';

function exactly(expected: string): Rule {
  return (value) => (value === expected ? undefined : `not ${JSON.stringify(expected)}`);
}

/**
 * The variables an agent must start with, and what each must be: without
 * any of them it would read the person's files or call hosts of its own.
 */
const REQUIRED_VARIABLES: Readonly<Record<string, Rule>> = {
  HOME: aFolderInsideTheRoot,
  CLAUDE_CONFIG_DIR: aFolderInsideTheRoot,
  TMPDIR: aFolderInsideTheRoot,
  ANTHROPIC_BASE_URL: aLoopbackOrigin,
  ANTHROPIC_API_KEY: exactly(FAKE_API_KEY),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: exactly('1'),
  CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: exactly('1'),
  DISABLE_AUTOUPDATER: exactly('1'),
};

/**
 * Every variable an agent may start with. Any other is refused, whatever it
 * holds: a proxy, a switch to a cloud provider's API, another login or a
 * loader's option would each take the agent past what is checked here.
 */
const ALLOWED_VARIABLES: Readonly<Record<string, Rule>> = {
  ...REQUIRED_VARIABLES,
  PATH: anyValue,
  LANG: anyValue,
};

/**
 * The settings an agent may be given. Any other is refused: `env` would
 * replace the variables checked here, `apiKeyHelper` would run a program
 * for a key, and what a setting not listed does is not known here.
 */
const ALLOWED_SETTINGS: readonly string[] = ['hooks', 'permissions'];

/** The addresses that are the loopback interface, as a URL names its host. */
const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', '[::1]'];

/**
 * Refuses a launch in which the agent could reach Anthropic or the person's
 * own configuration. The runner calls it before every launch: no mistake in
 * a test may cost a real request or touch a real login.
 *
 * @param launch - What the agent would be started with.
 * @param machine - The machine's temporary folder and the person's home; this machine's by default.
 * @throws Error saying what is refused: a root that is not a folder the
 * runner made in the temporary folder, or that holds the person's home;
 * settings other than hooks and permissions; a variable that is not the
 * recipe's, or one of the recipe's that is missing or holds something else —
 * `ANTHROPIC_BASE_URL` anything but a loopback origin, `HOME`,
 * `CLAUDE_CONFIG_DIR` or `TMPDIR` anything but a folder inside the root.
 */
export function assertStaysLocal(launch: AgentLaunch, machine: Machine = thisMachine()): void {
  const problem =
    rootProblem(launch.root, machine) ??
    settingsProblem(launch.settings) ??
    environmentProblem(launch.environment, launch.root);
  if (problem !== undefined) throw new Error(`The real agent is not started: ${problem}.`);
}

/**
 * Gives the origin of an API address the agent may be told of: plain HTTP,
 * on the loopback interface by address, with its port, and nothing else — no
 * user, no path. A name is refused, `localhost` too: what it resolves to is
 * the machine's to say. The agent is given the origin and never the address
 * as written, so that it cannot read the text another way than it was read here.
 *
 * @param address - The address, as a test gave it.
 * @returns The origin, such as `http://127.0.0.1:4010`.
 * @throws Error naming `ANTHROPIC_BASE_URL` for any other address.
 */
export function loopbackOrigin(address: string): string {
  const origin = plainLoopbackOrigin(address);
  if (origin === undefined) {
    throw new Error(
      `The real agent is not started: ANTHROPIC_BASE_URL would be ${JSON.stringify(address)}, not a plain http address of the loopback interface, with its port.`,
    );
  }
  return origin;
}

function plainLoopbackOrigin(text: string): string | undefined {
  if (!URL.canParse(text)) return undefined;
  const url = new URL(text);
  const hasOnlyAnOrigin =
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '';
  const isLoopback =
    url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname) && url.port !== '';
  return hasOnlyAnOrigin && isLoopback ? url.origin : undefined;
}

function thisMachine(): Machine {
  // The home of the account, not of a `HOME` a caller may have changed.
  return { temporaryFolder: realpathSync(tmpdir()), home: userInfo().homedir };
}

function rootProblem(root: string, machine: Machine): string | undefined {
  if (!isInside(root, machine.temporaryFolder)) {
    return `the root ${describe(root)} is not a folder inside the temporary folder ${machine.temporaryFolder}`;
  }
  if (root === machine.home || isInside(machine.home, root)) {
    return `the root ${describe(root)} holds the person's home`;
  }
  if (!isMadeByTheRunner(root, machine)) {
    return `the root ${describe(root)} is not a folder the runner made: a real folder of ${machine.temporaryFolder} named ${ROOT_NAME_PREFIX}…`;
  }
  return undefined;
}

function isMadeByTheRunner(root: string, machine: Machine): boolean {
  const isNamedAsOne =
    resolve(root) === root &&
    dirname(root) === machine.temporaryFolder &&
    basename(root).startsWith(ROOT_NAME_PREFIX);
  // A link is no folder to lstat: what it leads to is not what was checked.
  return isNamedAsOne && lstatSync(root, { throwIfNoEntry: false })?.isDirectory() === true;
}

function settingsProblem(settings: unknown): string | undefined {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    return 'the settings are no object';
  }
  const refused = Object.keys(settings).find((name) => !ALLOWED_SETTINGS.includes(name));
  if (refused === undefined) return undefined;
  return `the settings carry ${describe(refused)}, and an agent is given only ${ALLOWED_SETTINGS.join(' and ')}`;
}

function environmentProblem(
  environment: Readonly<Record<string, string>>,
  root: string,
): string | undefined {
  const refused = Object.keys(environment).find((name) => !Object.hasOwn(ALLOWED_VARIABLES, name));
  if (refused !== undefined) return `${refused} is no variable an agent is given`;
  for (const name of Object.keys(REQUIRED_VARIABLES)) {
    if (environment[name] === undefined) return `${name} is not set`;
  }
  for (const [name, value] of Object.entries(environment)) {
    const reason = ALLOWED_VARIABLES[name]?.(value, root);
    // The key's value stays out of a failure message, fake or not.
    if (reason !== undefined) return `${name} is ${reason}`;
  }
  return undefined;
}

function describe(value: string): string {
  return JSON.stringify(value);
}

function isInside(folder: string, root: string): boolean {
  if (!isAbsolute(folder)) return false;
  const fromRoot = relative(resolve(root), resolve(folder));
  return fromRoot !== '' && !fromRoot.startsWith('..') && !isAbsolute(fromRoot);
}
