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
   * Whether a command the sandbox refuses may run outside it instead, once
   * the person approves; `false` when left out.
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
   * accident.
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
   * Runs every session in the agent's sandbox: `true`, or the sandbox's
   * exceptions. It may only turn the sandbox on: left out, the person's own
   * settings decide. A launch where the sandbox cannot run fails
   * (`sandbox-unavailable`), never running unsandboxed instead.
   */
  readonly sandbox?: true | ClaudeCodeSandbox;
}

/** The options once checked, each with its value. */
export interface CheckedOptions {
  readonly permissionMode: PermissionMode;
  readonly permissions: PermissionRules;
  readonly acceptOpenNetwork: boolean;
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

const OPTION_NAMES: readonly string[] = ['permissionMode', 'permissions', 'acceptOpenNetwork'];

const JOB_PART_NAMES: readonly string[] = ['permissionMode', 'permissions', 'model'];

/**
 * Checks the app's options for the driver.
 *
 * @param options - What the app gave, unchecked: an app in JavaScript gives anything.
 * @returns The options, with the default mode when none is given, and an
 * open network not accepted.
 * @throws `CockpitError` `invalid-options`, with every issue found, for
 * options that are no object, a mode Claude Code does not have, rules that
 * are no lists of rules, an acceptance that is no boolean, and any other option: one that a later version
 * takes (a model, a plugin) is refused rather than silently ignored.
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
  } = given as ClaudeCodeOptions;
  return { permissionMode, permissions, acceptOpenNetwork };
}

function optionIssues(options: Record<string, unknown>): Issue[] {
  const { permissionMode, permissions, acceptOpenNetwork, ...others } = options;
  return [
    ...Object.keys(others).map((name) =>
      issue([name], `Not an option of the driver: it takes ${OPTION_NAMES.join(', ')}.`),
    ),
    ...modeIssues(permissionMode),
    ...permissionsIssues(permissions),
    ...acceptanceIssues(acceptOpenNetwork),
  ];
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

function acceptanceIssues(accept: unknown): Issue[] {
  if (accept === undefined || typeof accept === 'boolean') return [];
  return [issue(['acceptOpenNetwork'], 'Expected true or false.')];
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
      ? ruleListIssues(name, rules)
      : [issue(['permissions', name], `Not a list of rules: they are ${RULE_LISTS.join(', ')}.`)],
  );
}

function ruleListIssues(name: string, rules: unknown): Issue[] {
  if (!Array.isArray(rules)) return [issue(['permissions', name], 'Not a list of rules.')];
  return rules.flatMap((rule, index) =>
    typeof rule === 'string' && rule !== ''
      ? []
      : [issue(['permissions', name, index], 'A rule is a text, not empty.')],
  );
}

function issue(path: readonly (string | number)[], message: string): Issue {
  return { path, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
