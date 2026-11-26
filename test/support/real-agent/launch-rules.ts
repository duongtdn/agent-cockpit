import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { FAKE_API_KEY, TERMINAL_VARIABLES } from './environment.ts';

/**
 * The rules of a launch of the real agent, in one place: what each variable,
 * each option of the command line and each setting may be. Whatever has no
 * rule here is refused, so a later feature that needs one more of any of
 * them adds its rule to the table it belongs to, and nowhere else.
 */

/** Tells why a value is refused, or nothing when it may pass. */
export type Check<Value> = (value: Value, root: string) => string | undefined;

/** Where this file is, for the messages that send a reader here. */
export const RULES_FILE = 'test/support/real-agent/launch-rules.ts';

const allowedAsIs: Check<unknown> = () => undefined;

function refused(why: string): Check<unknown> {
  return () => `refused: ${why}`;
}

function exactly(expected: string): Check<string> {
  return (value) => (value === expected ? undefined : `not ${JSON.stringify(expected)}`);
}

/**
 * Tells whether a path is inside a folder, by the text of the two: what a
 * link on the way leads to is not looked at.
 *
 * @param path - An absolute path; a relative one is inside nothing.
 * @param folder - The folder.
 */
export function isInside(path: string, folder: string): boolean {
  if (!isAbsolute(path)) return false;
  const fromFolder = relative(resolve(folder), resolve(path));
  return fromFolder !== '' && !fromFolder.startsWith('..') && !isAbsolute(fromFolder);
}

/**
 * Tells whether a path is a folder and no link to one: a link is no folder
 * to `lstat`, since what it leads to is not what was checked.
 *
 * @param path - The path.
 */
export function isRealFolder(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

/**
 * A folder the agent reads or writes must be the run's own: one that
 * exists, written as its resolved path, so that no link on the way leads
 * out of the root.
 */
export const aRealFolderInsideTheRoot: Check<string> = (value, root) => {
  const isOwn =
    isInside(value, root) &&
    isRealFolder(value) &&
    realpathSync(value) === value &&
    isInside(value, realpathSync(root));
  return isOwn ? undefined : `not a real folder inside ${root}`;
};

/** The addresses that are the loopback interface, as a URL names its host. */
const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', '[::1]'];

function loopbackUrl(text: string): URL | undefined {
  if (!URL.canParse(text)) return undefined;
  const url = new URL(text);
  const isPlainLoopback =
    url.protocol === 'http:' &&
    LOOPBACK_HOSTS.includes(url.hostname) &&
    url.port !== '' &&
    url.username === '' &&
    url.password === '';
  return isPlainLoopback ? url : undefined;
}

/**
 * Reads an address as the origin of a plain HTTP address of the loopback
 * interface, given by address and with its port: no user, no path. A name
 * is refused, `localhost` too: what it resolves to is the machine's to say.
 *
 * @param text - The address.
 * @returns The origin, such as `http://127.0.0.1:4010`, or `undefined` for any other address.
 */
export function plainLoopbackOrigin(text: string): string | undefined {
  const url = loopbackUrl(text);
  const hasOnlyAnOrigin = url?.pathname === '/' && url.search === '' && url.hash === '';
  return hasOnlyAnOrigin ? url.origin : undefined;
}

const aLoopbackOrigin: Check<string> = (value) =>
  plainLoopbackOrigin(value) === value
    ? undefined
    : 'not the origin of a plain http address of the loopback interface, with its port';

/**
 * What a variable's rule says of it: who gives it, and what it must be. A
 * launch gives it always (`required`: without it the agent would read the
 * person's files or call hosts of its own) or when it likes (`optional`);
 * or the terminal the session runs in gives it, over whatever a launch
 * says, so that a launch never carries it.
 */
export type VariableRule =
  | { readonly given: 'required' | 'optional'; readonly check: Check<string> }
  | { readonly given: 'by the terminal' };

function required(check: Check<string>): VariableRule {
  return { given: 'required', check };
}

function optional(check: Check<string>): VariableRule {
  return { given: 'optional', check };
}

const theTerminals: VariableRule = { given: 'by the terminal' };

/**
 * Every variable the agent's process has. Any other is refused, whatever it
 * holds: a proxy, a switch to a cloud provider's API, another login or a
 * loader's option would each take the agent past what is checked here.
 */
export const VARIABLE_RULES: Readonly<Record<string, VariableRule>> = {
  HOME: required(aRealFolderInsideTheRoot),
  CLAUDE_CONFIG_DIR: required(aRealFolderInsideTheRoot),
  TMPDIR: required(aRealFolderInsideTheRoot),
  ANTHROPIC_BASE_URL: required(aLoopbackOrigin),
  ANTHROPIC_API_KEY: required(exactly(FAKE_API_KEY)),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: required(exactly('1')),
  CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: required(exactly('1')),
  DISABLE_AUTOUPDATER: required(exactly('1')),
  PATH: optional(allowedAsIs),
  LANG: optional(allowedAsIs),
  ...Object.fromEntries(TERMINAL_VARIABLES.map((name) => [name, theTerminals])),
};

function hookProblem(hook: unknown): string | undefined {
  if (!isRecord(hook)) return `a hook that is no object: ${JSON.stringify(hook)}`;
  // A command hook is the test's own program, as the test itself is.
  if (hook.type === 'command') return undefined;
  if (hook.type !== 'http') return `a hook of type ${JSON.stringify(hook.type)}`;
  const isLocal = typeof hook.url === 'string' && loopbackUrl(hook.url) !== undefined;
  return isLocal ? undefined : `an http hook to ${JSON.stringify(hook.url)}, off the loopback`;
}

/** Hooks report to the test and to nobody else: commands, and posts to the loopback interface. */
const hooksThatStayLocal: Check<unknown> = (hooks) => {
  if (!isRecord(hooks)) return 'no object of events';
  const groups = Object.values(hooks).flat() as { hooks?: unknown }[];
  if (!groups.every((group) => isRecord(group) && Array.isArray(group.hooks))) {
    return 'not a list of groups of hooks for each event';
  }
  const problems = groups.flatMap((group) => (group.hooks as unknown[]).map(hookProblem));
  return problems.find((problem) => problem !== undefined);
};

/** A domain of the sandbox's allow-list that stays local: a port of `127.0.0.1`. */
const LOOPBACK_DOMAIN = /^127\.0\.0\.1:\d{1,5}$/;

function sandboxNetworkProblem(network: unknown): string | undefined {
  if (!isRecord(network)) return 'a network that is no object';
  const { deniedDomains = [], allowedDomains = [], ...others } = network;
  const [other] = Object.keys(others);
  if (other !== undefined) return `the network's ${JSON.stringify(other)}`;
  if (!isTextList(deniedDomains)) return 'denied domains that are no list of texts';
  if (!isTextList(allowedDomains)) return 'allowed domains that are no list of texts';
  const away = allowedDomains.find((domain) => !LOOPBACK_DOMAIN.test(domain));
  return away === undefined
    ? undefined
    : `the allowed domain ${JSON.stringify(away)}, off 127.0.0.1`;
}

/**
 * The sandbox's lines may only narrow what a sandboxed command reaches:
 * any domain denied, a port of `127.0.0.1` allowed, no command let out of
 * the sandbox. Turning the sandbox on is no line of the driver's, and is
 * refused until a test needs it.
 */
const sandboxThatOnlyNarrows: Check<unknown> = (sandbox) => {
  if (!isRecord(sandbox)) return 'no object';
  const { network = {}, allowUnsandboxedCommands = false, ...others } = sandbox;
  const [other] = Object.keys(others);
  if (other !== undefined) return `refused: its ${JSON.stringify(other)} has no rule here`;
  if (allowUnsandboxedCommands !== false) return 'commands let out of the sandbox';
  return sandboxNetworkProblem(network);
};

/**
 * The settings the agent may be given, in every source it reads them from.
 * A setting with no rule is refused: what it does is not known here.
 */
export const SETTINGS_RULES: Readonly<Record<string, Check<unknown>>> = {
  hooks: hooksThatStayLocal,
  permissions: allowedAsIs,
  sandbox: sandboxThatOnlyNarrows,
  env: refused('it would replace the variables checked here'),
  apiKeyHelper: refused('it would run a program for a key'),
};

/**
 * Tells why settings are refused, or nothing when every one of them passes
 * its rule.
 *
 * @param settings - The settings, parsed.
 * @param root - The temporary folder the run owns.
 */
export const settingsProblem: Check<unknown> = (settings, root) => {
  if (!isRecord(settings)) return 'they are no object';
  for (const [name, value] of Object.entries(settings)) {
    const rule =
      ruleIn(SETTINGS_RULES, name) ?? refused(`it has no rule in SETTINGS_RULES (${RULES_FILE})`);
    const problem = rule(value, root);
    if (problem !== undefined) return `they carry ${JSON.stringify(name)}, ${problem}`;
  }
  return undefined;
};

/**
 * The settings of the command line are written out, or are a file nobody
 * can write: the agent then reads the very text that was checked, which
 * nothing can change between the check and the launch. A file is the
 * driver's own, which writes its session's settings in the cockpit's state
 * folder and names the file; the test that launches it takes the write
 * permission away before the check.
 */
const checkedSettings: Check<string> = (value, root) =>
  isAbsolute(value) ? settingsFileProblem(value, root) : settingsTextProblem(value, root);

function settingsTextProblem(text: string, root: string): string | undefined {
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    return 'they are neither written out as JSON nor a file nobody can write: a file could change after its check';
  }
  return settingsProblem(settings, root);
}

/** Any write permission, of the owner, the group or the others. */
const WRITE_PERMISSIONS = 0o222;

function settingsFileProblem(file: string, root: string): string | undefined {
  const status = lstatSync(file, { throwIfNoEntry: false });
  if (
    status?.isFile() !== true ||
    !isInside(file, root) ||
    !isInside(realpathSync(file), realpathSync(root))
  ) {
    return `${JSON.stringify(file)} is no real file inside ${root}: a link, or a file elsewhere, is not what was checked`;
  }
  if ((status.mode & WRITE_PERMISSIONS) !== 0) {
    return `${JSON.stringify(file)} can be written: it could change after its check`;
  }
  return settingsInFileProblem(file, root);
}

/**
 * Tells why the settings a file holds are refused, or nothing when every
 * one of them passes its rule.
 *
 * @param file - The settings file.
 * @param root - The temporary folder the run owns.
 */
export const settingsInFileProblem: Check<string> = (file, root) => {
  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return 'they cannot be read as JSON';
  }
  return settingsProblem(settings, root);
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A conversation is named by its id and nothing else: the agent reads a
 * value that begins with a dash as an option of its own, which no rule saw.
 */
const aUuid: Check<string> = (value) => (UUID.test(value) ? undefined : 'not a UUID');

function notNeededYet(what: string): Check<string> {
  return refused(
    `${what}, and no launch needs it yet: one that does changes its rule in OPTION_RULES (${RULES_FILE})`,
  );
}

/**
 * The options a launch may carry before `--`, each with one value, and
 * what the value must be. An option with no rule is refused.
 */
export const OPTION_RULES: Readonly<Record<string, Check<string>>> = {
  '--session-id': aUuid,
  '--resume': aUuid,
  '--settings': checkedSettings,
  '--permission-mode': allowedAsIs,
  '--model': allowedAsIs,
  '--mcp-config': notNeededYet('it would give the agent servers to call'),
  '--plugin-dir': notNeededYet('it would give the agent code to load'),
  '--setting-sources': notNeededYet('it would change which settings the agent reads'),
};

/** What ends the options of a command line: one prompt may follow. */
const PROMPT_SEPARATOR = '--';

/**
 * Tells why the arguments of a launch are refused, or nothing when each
 * option passes its rule. A prompt, after `--`, is the test's to write.
 *
 * @param args - The arguments, as the agent would get them.
 * @param root - The temporary folder the run owns.
 */
export const argumentsProblem: Check<readonly string[]> = (args, root) => {
  const separator = args.indexOf(PROMPT_SEPARATOR);
  const options = separator === -1 ? args : args.slice(0, separator);
  if (separator !== -1 && args.length - separator > 2) return 'more than one prompt follows --';
  for (let index = 0; index < options.length; index += 2) {
    const problem = optionProblem(options[index] as string, options[index + 1], root);
    if (problem !== undefined) return problem;
  }
  return undefined;
};

function optionProblem(
  option: string,
  value: string | undefined,
  root: string,
): string | undefined {
  const rule = ruleIn(OPTION_RULES, option);
  if (rule === undefined) {
    return `the argument ${JSON.stringify(option)} has no rule in OPTION_RULES (${RULES_FILE})`;
  }
  if (value === undefined) return `${option} has no value`;
  const problem = rule(value, root);
  // The settings name themselves in their problem.
  if (option === '--settings')
    return problem === undefined ? undefined : `the settings of --settings: ${problem}`;
  return problem === undefined ? undefined : `${option} is ${problem}`;
}

/**
 * Gives the rule a table has for a name, by the table's own entries: what
 * every object inherits (`constructor`, `toString`) is no rule.
 *
 * @param rules - A table of rules.
 * @param name - The variable, the option or the setting.
 * @returns Its rule, or `undefined` when the table has none.
 */
export function ruleIn<Rule>(
  rules: Readonly<Record<string, Rule>>,
  name: string,
): Rule | undefined {
  return Object.hasOwn(rules, name) ? rules[name] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTextList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
