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
}

/** The options once checked, each with its value. */
export interface CheckedOptions {
  readonly permissionMode: PermissionMode;
  readonly permissions: PermissionRules;
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

const OPTION_NAMES: readonly string[] = ['permissionMode', 'permissions'];

/**
 * Checks the app's options for the driver.
 *
 * @param options - What the app gave, unchecked: an app in JavaScript gives anything.
 * @returns The options, with the default mode when none is given.
 * @throws `CockpitError` `invalid-options`, with every issue found, for
 * options that are no object, a mode Claude Code does not have, rules that
 * are no lists of rules, and any other option: one that a later version
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
  const { permissionMode = 'default', permissions = {} } = given as ClaudeCodeOptions;
  return { permissionMode, permissions };
}

function optionIssues(options: Record<string, unknown>): Issue[] {
  const { permissionMode, permissions, ...others } = options;
  return [
    ...Object.keys(others).map((name) =>
      issue([name], `Not an option of the driver: it takes ${OPTION_NAMES.join(' and ')}.`),
    ),
    ...modeIssues(permissionMode),
    ...permissionsIssues(permissions),
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
