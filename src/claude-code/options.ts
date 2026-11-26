import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { CockpitError, type Issue } from '../shared/cockpit-error.js';

/**
 * The permission modes of Claude Code, as `--permission-mode` takes them:
 * which tool calls run without asking, and whether the session plans first.
 */
export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'auto'
  | 'dontAsk'
  | 'bypassPermissions';

/**
 * Permission rules, as Claude Code's settings write them (`Read`,
 * `Bash(git push:*)`, `mcp__server`). Claude Code weighs them deny first,
 * then ask, then allow, across every settings file it reads: an allow never
 * lifts a deny or an ask of the person's or the project's.
 */
export interface PermissionRules {
  /** Tool calls that run without asking. */
  readonly allow?: readonly string[];
  /** Tool calls that always ask, whatever allows them. */
  readonly ask?: readonly string[];
  /** Tool calls that never run. */
  readonly deny?: readonly string[];
}

/**
 * A source of settings Claude Code reads below the session's own: the
 * person's (`user`), the project's (`project`), the project's own local
 * ones (`local`).
 */
export type SettingSource = 'user' | 'project' | 'local';

/**
 * The agent's sandbox, as the app asks for it: its commands run confined,
 * with these exceptions. The cockpit's own lines are written beside them.
 */
export interface ClaudeCodeSandbox {
  /**
   * Commands that run outside the sandbox (its `excludedCommands`): each is
   * unconfined, the cockpit's lines included.
   */
  readonly excludedCommands?: readonly string[];
  /**
   * Whether a command the sandbox refuses may run outside it instead, with
   * none of the cockpit's lines; `false` when left out. In `default` and
   * `acceptEdits` the person approves each such command first; in
   * `bypassPermissions` and `auto` it runs with no person asked.
   */
  readonly allowUnsandboxedCommands?: boolean;
}

/**
 * A job's driver part for Claude Code (ADR-0051), as `claudeCode.job(…)`
 * builds it: laid over the app's options for the job's sessions. The
 * plugin, the environment and the acceptance of an open network stay the
 * app's.
 */
export interface ClaudeCodeJobPart {
  /** The mode the job's sessions are launched in, in place of the app's. */
  readonly permissionMode?: PermissionMode;
  /** Rules added to the app's: the app's deny and ask rules always hold. */
  readonly permissions?: PermissionRules;
  /** The model of the job's sessions (`--model`), over the app's and the person's. */
  readonly model?: string;
}

/** The app's options for the Claude Code driver. */
export interface ClaudeCodeOptions {
  /**
   * The mode every session is launched in; `default` when left out. It is
   * always passed, so the person's own `defaultMode` never applies by
   * accident. In `bypassPermissions` nothing asks before a file is written:
   * the agent's own file tools act as the person, and the denies on the
   * files that start code at its next launch are defense in depth, not a
   * boundary (a script a hook runs, a shell's startup file, is no file the
   * cockpit can name).
   */
  readonly permissionMode?: PermissionMode;
  /** Rules every session's settings carry, above the person's and the project's. */
  readonly permissions?: PermissionRules;
  /**
   * Accepts that a session in `plan`, `auto` or `bypassPermissions` reaches
   * the network beyond the cockpit's allow-list without asking the person —
   * other local ports, the internet, the person's files — even when the
   * app opens the cockpit beyond loopback (it gives `authorize`), where
   * such a session could read a token that works from afar. Each was seen
   * to: `bypassPermissions` always, `plan` and `auto` for the hosts an
   * approved command names in its `allowed_domains`. `default`,
   * `acceptEdits` and `dontAsk` ask or refuse, and need no acceptance.
   * `false` when left out: `createCockpit` then refuses an open mode with
   * `authorize`.
   */
  readonly acceptOpenNetwork?: boolean;
  /**
   * The model of every session (`--model`), unless a job names its own;
   * left out, the person's own default applies, as in their terminal.
   */
  readonly model?: string;
  /**
   * The app's plugin (`--plugin-dir`), for its sessions only: a folder,
   * made absolute from the folder the server runs in, which must exist.
   */
  readonly pluginDir?: string;
  /**
   * The only sources of settings the sessions read below their own
   * (`--setting-sources`): of `'user'`, `'project'`, `'local'`, none for an
   * empty list. A source left out takes its settings, rules, hooks and MCP
   * servers with it, and for `project` the project's `CLAUDE.md`. Left out,
   * every source loads. The cockpit's hooks and the plugin load either way.
   */
  readonly settingSources?: readonly ('user' | 'project' | 'local')[];
  /**
   * `false` keeps every MCP server but the cockpit's out of the sessions
   * (`--strict-mcp-config`); `true` when left out.
   */
  readonly otherMcpServers?: boolean;
  /**
   * Runs every session in the agent's sandbox: `true`, or the sandbox's
   * exceptions. It may only turn the sandbox on: left out, the person's own
   * settings decide. A launch where the sandbox cannot run fails
   * (`sandbox-unavailable`), never running unsandboxed instead.
   */
  readonly sandbox?: true | ClaudeCodeSandbox;
}

/** The options once checked, each with its value: `undefined` for one the app left to the person. */
export interface CheckedOptions {
  readonly permissionMode: PermissionMode;
  readonly permissions: PermissionRules;
  readonly acceptOpenNetwork: boolean;
  readonly model: string | undefined;
  /** An absolute path. */
  readonly pluginDir: string | undefined;
  readonly settingSources: readonly SettingSource[] | undefined;
  readonly otherMcpServers: boolean;
  /** The sandbox turned on, with the app's exceptions; `undefined`: the person's choice. */
  readonly sandbox: ClaudeCodeSandbox | undefined;
}

/** What a session runs with, once a job's part is laid over the app's options. */
export interface SessionChoices {
  readonly permissionMode: PermissionMode;
  readonly permissions: PermissionRules;
  readonly model: string | undefined;
}

const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions',
];

const RULE_LISTS: readonly (keyof PermissionRules)[] = ['allow', 'ask', 'deny'];

const SETTING_SOURCES: readonly SettingSource[] = ['user', 'project', 'local'];

const OPTION_NAMES: readonly string[] = [
  'permissionMode',
  'permissions',
  'acceptOpenNetwork',
  'model',
  'pluginDir',
  'settingSources',
  'otherMcpServers',
  'sandbox',
];

const SANDBOX_EXCEPTIONS: readonly string[] = ['excludedCommands', 'allowUnsandboxedCommands'];

const JOB_PART_NAMES: readonly string[] = ['permissionMode', 'permissions', 'model'];

/**
 * Checks the app's options for the driver.
 *
 * @param options - What the app gave, unchecked: an app in JavaScript gives anything.
 * @returns The options, with the default mode when none is given, an open
 * network not accepted, the other MCP servers loaded, the plugin's folder
 * absolute, and the sandbox `undefined` when left to the person (`{}` for
 * `true`).
 * @throws `CockpitError` `invalid-options`, with every issue found, for
 * options that are no object, a mode Claude Code does not have, rules that
 * are no lists of rules, a model that is no text, a plugin folder that does
 * not exist, a source of settings Claude Code does not read, a switch that
 * is no boolean, the sandbox turned off or given exceptions it does not
 * have, and any other option, refused rather than silently ignored.
 */
export function checkOptions(options: unknown): CheckedOptions {
  const given = options === undefined ? {} : options;
  const issues = isRecord(given) ? optionIssues(given) : [issue([], 'The options are no object.')];
  if (issues.length > 0) {
    throw new CockpitError('invalid-options', "The Claude Code driver's options do not fit.", {
      issues,
    });
  }
  const {
    permissionMode = 'default',
    permissions = {},
    acceptOpenNetwork = false,
    model,
    pluginDir,
    settingSources,
    otherMcpServers = true,
    sandbox,
  } = given as ClaudeCodeOptions;
  return {
    permissionMode,
    permissions,
    acceptOpenNetwork,
    model,
    pluginDir: pluginDir === undefined ? undefined : resolve(pluginDir),
    settingSources,
    otherMcpServers,
    sandbox: sandbox === true ? {} : sandbox,
  };
}

function optionIssues(options: Record<string, unknown>): Issue[] {
  const {
    permissionMode,
    permissions,
    acceptOpenNetwork,
    model,
    pluginDir,
    settingSources,
    otherMcpServers,
    sandbox,
    ...others
  } = options;
  return [
    ...Object.keys(others).map((name) =>
      issue([name], `Not an option of the driver: it takes ${OPTION_NAMES.join(', ')}.`),
    ),
    ...modeIssues(permissionMode),
    ...permissionsIssues(permissions),
    ...booleanIssues(['acceptOpenNetwork'], acceptOpenNetwork),
    ...modelIssues(model),
    ...pluginDirIssues(pluginDir),
    ...settingSourcesIssues(settingSources),
    ...booleanIssues(['otherMcpServers'], otherMcpServers),
    ...sandboxIssues(sandbox),
  ];
}

/**
 * Lays a job's driver part over the app's options (ADR-0051): the part's
 * mode and model replace the app's, its rules are added after the app's,
 * list by list, so that the app's deny and ask rules always hold.
 *
 * @param options - The app's options, checked.
 * @param part - The job's part, checked; none for a session of the app's own options.
 * @returns What the session runs with.
 */
export function laidOver(options: CheckedOptions, part: ClaudeCodeJobPart = {}): SessionChoices {
  return {
    permissionMode: part.permissionMode ?? options.permissionMode,
    permissions: rulesAdded(options.permissions, part.permissions ?? {}),
    model: part.model ?? options.model,
  };
}

function rulesAdded(first: PermissionRules, then: PermissionRules): PermissionRules {
  return Object.fromEntries(
    RULE_LISTS.flatMap((list) => {
      const rules = [...(first[list] ?? []), ...(then[list] ?? [])];
      return first[list] === undefined && then[list] === undefined ? [] : [[list, rules]];
    }),
  );
}

/**
 * Checks a job's driver part: what `claudeCode.job` builds, or what an app in
 * JavaScript wrote by hand.
 *
 * @param part - The part, unchecked.
 * @returns Every issue found, each path from the part: a part that is no
 * object, a mode Claude Code does not have, rules that are no lists of
 * rules, a model that is no text or an empty one, and anything a job may
 * not set.
 */
export function checkJobPart(part: unknown): Issue[] {
  if (!isRecord(part)) return [issue([], "A job's driver part is an object.")];
  const { permissionMode, permissions, model, ...others } = part;
  return [
    ...Object.keys(others).map((name) =>
      issue([name], `Not for a job to set: it sets ${JOB_PART_NAMES.join(', ')}.`),
    ),
    ...modeIssues(permissionMode),
    ...permissionsIssues(permissions),
    ...modelIssues(model),
  ];
}

function modelIssues(model: unknown): Issue[] {
  if (model === undefined || (typeof model === 'string' && model !== '')) return [];
  return [issue(['model'], "A model's name is a text, not empty.")];
}

function booleanIssues(path: readonly string[], value: unknown): Issue[] {
  if (value === undefined || typeof value === 'boolean') return [];
  return [issue(path, 'Expected true or false.')];
}

function pluginDirIssues(pluginDir: unknown): Issue[] {
  if (pluginDir === undefined) return [];
  if (typeof pluginDir !== 'string' || pluginDir === '') {
    return [issue(['pluginDir'], "A folder's path is a text, not empty.")];
  }
  const folder = resolve(pluginDir);
  if (statSync(folder, { throwIfNoEntry: false })?.isDirectory() === true) return [];
  return [issue(['pluginDir'], `Not an existing folder: ${folder}.`)];
}

function settingSourcesIssues(sources: unknown): Issue[] {
  if (sources === undefined) return [];
  if (!Array.isArray(sources)) return [issue(['settingSources'], 'Not a list of sources.')];
  return sources.flatMap((source, index) =>
    SETTING_SOURCES.includes(source)
      ? []
      : [issue(['settingSources', index], `Not one of ${SETTING_SOURCES.join(', ')}.`)],
  );
}

function sandboxIssues(sandbox: unknown): Issue[] {
  if (sandbox === undefined || sandbox === true) return [];
  if (sandbox === false) {
    return [
      issue(
        ['sandbox'],
        "The app may only turn the sandbox on: left out, the person's own settings decide.",
      ),
    ];
  }
  if (!isRecord(sandbox))
    return [issue(['sandbox'], "Expected true, or the sandbox's exceptions.")];
  const { excludedCommands, allowUnsandboxedCommands, ...others } = sandbox;
  return [
    ...Object.keys(others).map((name) =>
      issue(
        ['sandbox', name],
        `Not an exception of the sandbox: they are ${SANDBOX_EXCEPTIONS.join(', ')}.`,
      ),
    ),
    ...textListIssues(['sandbox', 'excludedCommands'], excludedCommands, 'command'),
    ...booleanIssues(['sandbox', 'allowUnsandboxedCommands'], allowUnsandboxedCommands),
  ];
}

function modeIssues(mode: unknown): Issue[] {
  if (mode === undefined || PERMISSION_MODES.includes(mode as PermissionMode)) return [];
  return [issue(['permissionMode'], `Not one of ${PERMISSION_MODES.join(', ')}.`)];
}

function permissionsIssues(permissions: unknown): Issue[] {
  if (permissions === undefined) return [];
  if (!isRecord(permissions)) return [issue(['permissions'], 'The permissions are no object.')];
  return Object.entries(permissions).flatMap(([name, rules]) =>
    RULE_LISTS.includes(name as keyof PermissionRules)
      ? textListIssues(['permissions', name], rules, 'rule')
      : [issue(['permissions', name], `Not a list of rules: they are ${RULE_LISTS.join(', ')}.`)],
  );
}

/** Issues of a list of texts, none of them empty, each a `what`; none for a list left out. */
function textListIssues(path: readonly string[], list: unknown, what: string): Issue[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) return [issue(path, `Not a list of ${what}s.`)];
  return list.flatMap((text, index) =>
    typeof text === 'string' && text !== ''
      ? []
      : [issue([...path, index], `A ${what} is a text, not empty.`)],
  );
}

function issue(path: readonly (string | number)[], message: string): Issue {
  return { path, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
