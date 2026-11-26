import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
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

const aWholeNumber: Check<string> = (value) =>
  /^\d{1,3}$/.test(value) ? undefined : 'not a whole number of three digits at most';

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
  // How often a failed request is tried again: a test of a failed turn needs it few.
  CLAUDE_CODE_MAX_RETRIES: optional(aWholeNumber),
  PATH: optional(allowedAsIs),
  LANG: optional(allowedAsIs),
  ...Object.fromEntries(TERMINAL_VARIABLES.map((name) => [name, theTerminals])),
};

/**
 * The variables that name the folders whose files the guard checks: the
 * settings and the MCP servers under the launch's configuration folder and
 * home. Settings that set one would move the agent to files never checked,
 * whatever folder they name, the launch's own included.
 */
const CHECKED_FOLDER_VARIABLES: readonly string[] = ['HOME', 'CLAUDE_CONFIG_DIR', 'TMPDIR'];

/**
 * Variables given in settings (`env`), which the agent applies over the
 * ones it was launched with: each must have a rule that a launch may give,
 * and pass it, as if the launch gave it; none may name a folder the guard
 * checked.
 */
const variablesThatPassTheirRules: Check<unknown> = (variables, root) => {
  if (!isRecord(variables)) return 'variables that are no object';
  for (const [name, value] of Object.entries(variables)) {
    if (CHECKED_FOLDER_VARIABLES.includes(name)) {
      return `the variable ${name}, which would move the agent from the folders whose files the guard checked: only a launch gives it`;
    }
    const rule = ruleIn(VARIABLE_RULES, name);
    if (rule === undefined || rule.given === 'by the terminal') {
      return `the variable ${name}, which has no rule a launch may give in VARIABLE_RULES (${RULES_FILE})`;
    }
    if (typeof value !== 'string') return `the variable ${name}, which is no text`;
    const reason = rule.check(value, root);
    if (reason !== undefined) return `the variable ${name}, ${reason}`;
  }
  return undefined;
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
 * The switches of the sandbox that may be given, each only as `true`: the
 * sandbox on (the person's own settings turn it on, in the tests of what
 * the driver's lines do there), and a command refused where the sandbox
 * cannot run, never run unconfined instead. Either only narrows.
 */
const NARROWING_SWITCHES: readonly string[] = ['enabled', 'failIfUnavailable'];

function switchProblem(sandbox: Record<string, unknown>): string | undefined {
  const loose = NARROWING_SWITCHES.find((name) => name in sandbox && sandbox[name] !== true);
  return loose === undefined ? undefined : `its ${JSON.stringify(loose)} other than true`;
}

/**
 * The sandbox's lines may only narrow what a sandboxed command reaches:
 * any domain denied, a port of `127.0.0.1` allowed, no command let out of
 * the sandbox, the sandbox on and failing where it cannot run.
 */
const sandboxThatOnlyNarrows: Check<unknown> = (sandbox) => {
  if (!isRecord(sandbox)) return 'no object';
  const { network = {}, allowUnsandboxedCommands = false, ...others } = sandbox;
  const [other] = Object.keys(others).filter((name) => !NARROWING_SWITCHES.includes(name));
  if (other !== undefined) return `refused: its ${JSON.stringify(other)} has no rule here`;
  if (allowUnsandboxedCommands !== false) return 'commands let out of the sandbox';
  return switchProblem(sandbox) ?? sandboxNetworkProblem(network);
};

/**
 * The settings the agent may be given, in every source it reads them from.
 * A setting with no rule is refused: what it does is not known here.
 */
export const SETTINGS_RULES: Readonly<Record<string, Check<unknown>>> = {
  hooks: hooksThatStayLocal,
  permissions: allowedAsIs,
  sandbox: sandboxThatOnlyNarrows,
  // The warning a session in bypassPermissions opens with, accepted once as a person does: the
  // mode itself is the launch's, which its own rule checks.
  skipDangerousModePermissionPrompt: (value) => (value === true ? undefined : 'not true'),
  // WebFetch asks api.anthropic.com about each host before it fetches, whatever the API's
  // address: a test whose agent fetches turns that off, and the setting may do nothing else.
  skipWebFetchPreflight: (value) => (value === true ? undefined : 'not true'),
  // The person's own variables, which the agent applies over its environment: each passes the
  // rule the launch's variable of that name passes.
  env: variablesThatPassTheirRules,
  // Every hook off, the cockpit's too: a session then reports nothing, and calls nobody more.
  disableAllHooks: (value) => (value === true ? undefined : 'not true'),
  apiKeyHelper: refused('it would run a program for a key'),
  // The person's plugins switched on or off: what each holds is checked where it is installed,
  // in the configuration folder (pluginsProblem).
  enabledPlugins: (value) =>
    isRecord(value) && Object.values(value).every((enabled) => typeof enabled === 'boolean')
      ? undefined
      : 'not an object of plugins, each true or false',
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

/** The sources of settings `--setting-sources` may name, beside the command line's own. */
const SETTING_SOURCES: readonly string[] = ['user', 'project', 'local'];

/**
 * Fewer sources of settings only take settings away, each of which the
 * guard checks whether the agent reads it or not.
 */
const someSettingSources: Check<string> = (value) => {
  // The empty word is no source at all.
  const sources = value === '' ? [] : value.split(',');
  const unknown = sources.filter((source) => !SETTING_SOURCES.includes(source));
  return unknown.length === 0 ? undefined : `naming ${unknown.join(', ')}, no source of settings`;
};

/** What a plugin's manifest may say of it: who it is, nothing that runs or connects. */
const PLUGIN_MANIFEST_KEYS: readonly string[] = ['name', 'description', 'version'];

/** A plugin's manifest, from its folder. */
const PLUGIN_MANIFEST = '.claude-plugin/plugin.json';

/** A plugin's command: a Markdown file the agent reads as a prompt. */
const PLUGIN_COMMAND = /^commands\/[^/]+\.md$/;

/** A plugin's hooks. */
const PLUGIN_HOOKS = 'hooks/hooks.json';

/**
 * A plugin of commands only, the run's own: a real folder inside the root
 * holding its manifest, which names it and nothing more, and a folder of
 * commands, each a Markdown file the agent reads as a prompt. A plugin's
 * hooks, MCP servers, agents or anything else have no rule.
 */
const aPluginOfCommands: Check<string> = (value, root) =>
  aRealFolderInsideTheRoot(value, root) ??
  pluginStraysProblem(value, (entry) => PLUGIN_COMMAND.test(entry), 'only commands') ??
  pluginManifestProblem(value);

/**
 * A plugin the person installed, the run's own: as a plugin of commands,
 * with hooks too, each of which stays local as the settings' hooks do.
 */
const aPluginOfCommandsAndHooks: Check<string> = (value, root) =>
  aRealFolderInsideTheRoot(value, root) ??
  pluginStraysProblem(
    value,
    (entry) => PLUGIN_COMMAND.test(entry) || entry === PLUGIN_HOOKS,
    'only commands and hooks',
  ) ??
  pluginManifestProblem(value) ??
  pluginHooksProblem(value, root);

function pluginStraysProblem(
  folder: string,
  hasRule: (entry: string) => boolean,
  what: string,
): string | undefined {
  const strays = entriesIn(folder).filter((entry) => entry !== PLUGIN_MANIFEST && !hasRule(entry));
  return strays.length === 0
    ? undefined
    : `a plugin holding ${strays.join(', ')}: ${what} have a rule`;
}

function pluginManifestProblem(folder: string): string | undefined {
  const manifest = readJson(join(folder, PLUGIN_MANIFEST));
  if (manifest === undefined) return 'a plugin whose manifest cannot be read as JSON';
  if (!isRecord(manifest)) return 'a plugin whose manifest is no object';
  const other = Object.keys(manifest).find((key) => !PLUGIN_MANIFEST_KEYS.includes(key));
  return other === undefined ? undefined : `a plugin whose manifest says ${JSON.stringify(other)}`;
}

function pluginHooksProblem(folder: string, root: string): string | undefined {
  const file = join(folder, PLUGIN_HOOKS);
  if (lstatSync(file, { throwIfNoEntry: false }) === undefined) return undefined;
  const content = readJson(file);
  if (!isRecord(content)) return 'a plugin whose hooks cannot be read as an object of JSON';
  const problem = hooksThatStayLocal(content.hooks, root);
  return problem === undefined ? undefined : `a plugin whose hooks hold ${problem}`;
}

/** Reads a file as JSON; `undefined` when it cannot be. */
function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Every file and link under a folder, by its path from it: a link is not followed. */
function entriesIn(folder: string): string[] {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)));
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
  '--plugin-dir': aPluginOfCommands,
  '--setting-sources': someSettingSources,
};

/**
 * The options a launch may carry before `--` that take no value. Each only
 * takes something away from the agent.
 */
export const FLAG_RULES: readonly string[] = [
  // Only the servers of --mcp-config, which has its own rule.
  '--strict-mcp-config',
];

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
  let index = 0;
  while (index < options.length) {
    const option = options[index] as string;
    const isFlag = FLAG_RULES.includes(option);
    const problem = isFlag ? undefined : optionProblem(option, options[index + 1], root);
    if (problem !== undefined) return problem;
    index += isFlag ? 1 : 2;
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

/** What an MCP server the agent may start says: the program it runs, as a command hook does. */
const MCP_SERVER_KEYS: readonly string[] = ['type', 'command', 'args'];

/**
 * MCP servers the agent may start: each a program of the test's, run with
 * its arguments (`type` `stdio`, or none), as a command hook is. A server
 * reached by an address, or given variables or anything else, has no rule.
 *
 * @param servers - A file's `mcpServers`.
 */
export const mcpServersThatAreLocalPrograms: Check<unknown> = (servers) => {
  if (!isRecord(servers)) return 'MCP servers that are no object';
  for (const [name, server] of Object.entries(servers)) {
    const problem = mcpServerProblem(server);
    if (problem !== undefined) return `the MCP server ${JSON.stringify(name)}, ${problem}`;
  }
  return undefined;
};

function mcpServerProblem(server: unknown): string | undefined {
  if (!isRecord(server)) return 'which is no object';
  const other = Object.keys(server).find((key) => !MCP_SERVER_KEYS.includes(key));
  if (other !== undefined) return `which says ${JSON.stringify(other)}: only a program has a rule`;
  if (server.type !== undefined && server.type !== 'stdio') {
    return `of type ${JSON.stringify(server.type)}: only a program has a rule`;
  }
  if (typeof server.command !== 'string' || server.command === '') return 'with no program';
  const args = server.args ?? [];
  return isTextList(args) ? undefined : 'whose arguments are no list of texts';
}

/**
 * Tells why a project's `.mcp.json` is refused, or nothing when each of its
 * servers is a program the agent may start.
 *
 * @param file - The file.
 */
export const mcpServerFileProblem: Check<string> = (file, root) => {
  const content = readJson(file);
  if (!isRecord(content)) return 'it cannot be read as JSON of an object';
  const { mcpServers = {}, ...others } = content;
  const [other] = Object.keys(others);
  if (other !== undefined) return `it says ${JSON.stringify(other)}, which has no rule`;
  return mcpServersThatAreLocalPrograms(mcpServers, root);
};

/**
 * Tells why the agent's configuration file (`.claude.json`) is refused, or
 * nothing when its MCP servers, the person's and each project's, are
 * programs the agent may start. The rest is the agent's own state.
 *
 * @param file - The file.
 */
export const configurationFileProblem: Check<string> = (file, root) => {
  const content = readJson(file);
  if (!isRecord(content)) return 'it cannot be read as JSON of an object';
  const projects = isRecord(content.projects) ? Object.values(content.projects) : [];
  for (const servers of [content.mcpServers, ...projects.map(serversOfProject)]) {
    if (servers === undefined) continue;
    const problem = mcpServersThatAreLocalPrograms(servers, root);
    if (problem !== undefined) return problem;
  }
  return undefined;
};

function serversOfProject(project: unknown): unknown {
  return isRecord(project) ? project.mcpServers : undefined;
}

/** What a marketplace's list may say of a plugin: who it is and where it is, nothing that runs. */
const MARKETPLACE_PLUGIN_KEYS: readonly string[] = ['name', 'source', 'description', 'version'];

/** A marketplace's list of plugins, from the marketplace's folder. */
const MARKETPLACE_LIST = '.claude-plugin/marketplace.json';

/**
 * Tells why the person's plugins are refused, or nothing when the agent
 * would load no plugin from anywhere but folders of the run, each checked:
 * every marketplace it knows is a folder of the run, every plugin it
 * installed is in the plugins' folder, every plugin a marketplace lists
 * says only who it is and where, a folder inside the marketplace, and
 * every plugin folder in the plugins' folder or in a marketplace holds
 * commands and hooks that stay local, nothing else (no `.mcp.json`).
 *
 * @param folder - The plugins' folder of the agent's configuration folder.
 * @param root - The temporary folder the run owns.
 */
export const pluginsProblem: Check<string> = (folder, root) => {
  if (!isRealFolder(folder)) return undefined;
  const known = join(folder, 'known_marketplaces.json');
  const problem =
    knownMarketplacesProblem(known, root) ??
    installedPluginsProblem(join(folder, 'installed_plugins.json'), folder, root);
  if (problem !== undefined) return problem;
  // A marketplace that is a folder of the run elsewhere is read where it is: its plugins too.
  for (const scanned of new Set([folder, ...marketplaceFoldersOf(known)])) {
    const found = marketplaceListsProblem(scanned, root) ?? pluginFolderProblem(scanned, root);
    if (found !== undefined) return found;
  }
  return undefined;
};

/** The places a marketplace names for itself: where it comes from, and where the agent keeps it. */
function placesOf(marketplace: unknown): { source: unknown; installLocation: unknown } {
  if (!isRecord(marketplace)) return { source: undefined, installLocation: undefined };
  return { source: marketplace.source, installLocation: marketplace.installLocation };
}

function knownMarketplacesProblem(file: string, root: string): string | undefined {
  if (lstatSync(file, { throwIfNoEntry: false }) === undefined) return undefined;
  const marketplaces = readJson(file);
  if (!isRecord(marketplaces)) return `${file} cannot be read as JSON of an object`;
  for (const [name, marketplace] of Object.entries(marketplaces)) {
    const { source, installLocation } = placesOf(marketplace);
    const isOwnFolder =
      isRecord(source) &&
      source.source === 'directory' &&
      typeof source.path === 'string' &&
      aRealFolderInsideTheRoot(source.path, root) === undefined;
    if (!isOwnFolder) {
      return `the marketplace ${JSON.stringify(name)} is no real folder inside ${root}: the agent would fetch it`;
    }
    const isKeptInTheRun =
      installLocation === undefined ||
      (typeof installLocation === 'string' &&
        aRealFolderInsideTheRoot(installLocation, root) === undefined);
    if (!isKeptInTheRun) {
      return `the marketplace ${JSON.stringify(name)} is installed at ${JSON.stringify(installLocation)}, no real folder inside ${root}`;
    }
  }
  return undefined;
}

/** The folders of the marketplaces the agent knows, once their file passed its check. */
function marketplaceFoldersOf(file: string): string[] {
  const marketplaces = readJson(file);
  if (!isRecord(marketplaces)) return [];
  return Object.values(marketplaces).flatMap((marketplace) => {
    const { source, installLocation } = placesOf(marketplace);
    const path = isRecord(source) ? source.path : undefined;
    return [path, installLocation].filter((place): place is string => typeof place === 'string');
  });
}

/**
 * Every plugin the agent installed is in the plugins' folder, a real folder
 * of the run, where the scan of that folder checks it: the agent loads a
 * plugin from its `installPath`, wherever that is.
 */
function installedPluginsProblem(file: string, folder: string, root: string): string | undefined {
  if (lstatSync(file, { throwIfNoEntry: false }) === undefined) return undefined;
  const content = readJson(file);
  const plugins = isRecord(content) ? content.plugins : undefined;
  if (!isRecord(plugins)) return `${file} cannot be read as JSON of an object of plugins`;
  for (const [name, installs] of Object.entries(plugins)) {
    if (!Array.isArray(installs)) return `${file} gives the plugin ${JSON.stringify(name)} no list`;
    for (const install of installs) {
      const problem = installPathProblem(
        isRecord(install) ? install.installPath : undefined,
        folder,
        root,
      );
      if (problem !== undefined) return `the plugin ${JSON.stringify(name)} ${problem}`;
    }
  }
  return undefined;
}

function installPathProblem(
  installPath: unknown,
  folder: string,
  root: string,
): string | undefined {
  if (typeof installPath !== 'string') return 'has no install path';
  const where = `is installed at ${JSON.stringify(installPath)}`;
  if (!isInside(installPath, folder)) return `${where}, outside ${folder}: it would not be checked`;
  return aRealFolderInsideTheRoot(installPath, root) === undefined
    ? undefined
    : `${where}, no real folder inside ${root}`;
}

function marketplaceListsProblem(folder: string, root: string): string | undefined {
  for (const list of entriesIn(folder).filter((entry) => entry.endsWith(MARKETPLACE_LIST))) {
    const marketplace = dirname(dirname(join(folder, list)));
    const content = readJson(join(folder, list));
    const plugins = isRecord(content) ? content.plugins : undefined;
    if (!Array.isArray(plugins)) return `${list} lists no plugins`;
    for (const plugin of plugins) {
      const problem = listedPluginProblem(plugin, marketplace, root);
      if (problem !== undefined) return `${list} ${problem}`;
    }
  }
  return undefined;
}

/** A plugin a marketplace lists says who it is, and where: a folder inside the marketplace. */
function listedPluginProblem(
  plugin: unknown,
  marketplace: string,
  root: string,
): string | undefined {
  if (!isRecord(plugin)) return 'says what is no object of a plugin';
  const other = Object.keys(plugin).find((key) => !MARKETPLACE_PLUGIN_KEYS.includes(key));
  if (other !== undefined) return `says ${JSON.stringify(other)} of a plugin`;
  const { source } = plugin;
  const isLocalFolder =
    typeof source === 'string' &&
    source.startsWith('./') &&
    isInside(resolve(marketplace, source), marketplace) &&
    aRealFolderInsideTheRoot(resolve(marketplace, source), root) === undefined;
  return isLocalFolder
    ? undefined
    : `gives the plugin ${JSON.stringify(plugin.name)} a source ${JSON.stringify(source)}: only a real folder inside the marketplace is local`;
}

function pluginFolderProblem(folder: string, root: string): string | undefined {
  const plugins = entriesIn(folder)
    .filter((entry) => entry.endsWith(PLUGIN_MANIFEST))
    // A manifest's folder is the plugin's own .claude-plugin, inside the plugin.
    .map((entry) => dirname(dirname(join(folder, entry))));
  for (const plugin of plugins) {
    const problem = aPluginOfCommandsAndHooks(plugin, root);
    if (problem !== undefined) return `the plugin ${plugin}: ${problem}`;
  }
  return undefined;
}
