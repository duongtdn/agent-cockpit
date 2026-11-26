import type { PermissionRules } from './options.js';

/** The events posted to the cockpit as HTTP hooks: every one the driver reads but `SessionStart`. */
export const HTTP_HOOK_EVENTS: readonly string[] = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionEnd',
];

/** What a session's settings are written from. */
export interface SettingsParts {
  /** Where the HTTP hooks post: the session's hook URL, the driver's path included. */
  readonly hookUrl: string;
  /** The session's token for this launch, written literally in the hooks' header. */
  readonly token: string;
  /** The shell command that runs the `SessionStart` hook. */
  readonly sessionStartCommand: string;
  /** The app's permission rules; a list left out is not written. */
  readonly permissions: PermissionRules;
}

/**
 * Writes the settings a session is launched with (`--settings`): the hooks
 * that report to the cockpit, and the app's permission rules. Claude Code
 * merges them above the person's and the project's settings, hooks too.
 *
 * `SessionStart` is a command hook, since Claude Code never posts it as an
 * HTTP hook; the others are HTTP hooks with the token in their
 * `Authorization` header. A group with no matcher is for every tool.
 *
 * @param parts - See {@link SettingsParts}.
 * @returns The settings, to write as JSON.
 */
export function settingsDocument(parts: SettingsParts): object {
  const httpHook = {
    type: 'http',
    url: parts.hookUrl,
    headers: { Authorization: `Bearer ${parts.token}` },
  };
  const hooks = {
    SessionStart: [{ hooks: [{ type: 'command', command: parts.sessionStartCommand }] }],
    ...Object.fromEntries(HTTP_HOOK_EVENTS.map((event) => [event, [{ hooks: [httpHook] }]])),
  };
  const hasRules = Object.keys(parts.permissions).length > 0;
  return hasRules ? { hooks, permissions: parts.permissions } : { hooks };
}
