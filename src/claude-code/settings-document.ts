import type { Confinement } from '../server/driver.js';
import { sandboxLines, stateRootDenies } from './confinement-lines.js';
import { HTTP_HOOK_EVENTS } from './hook-payloads.js';
import type { PermissionRules } from './options.js';

/** What a session's settings are written from. */
export interface SettingsParts {
  /** Where the HTTP hooks post: the session's hook URL, the driver's path included. */
  readonly hookUrl: string;
  /** The session's token for this launch, written literally in the hooks' header. */
  readonly token: string;
  /** The shell command that runs the `SessionStart` hook. */
  readonly sessionStartCommand: string;
  /**
   * The app's permission rules; a list left out is not written, but `deny`,
   * which always carries the confinement's.
   */
  readonly permissions: PermissionRules;
  /** What the agent must not reach, written whatever the app's rules say. */
  readonly confinement: Confinement;
}

/**
 * Writes the settings a session is launched with (`--settings`): the hooks
 * that report to the cockpit, the app's permission rules, and the
 * confinement's lines. Claude Code merges them above the person's and the
 * project's settings, hooks too; a deny wins over any allow of any of them.
 *
 * `SessionStart` is a command hook, since Claude Code never posts it as an
 * HTTP hook; the others are HTTP hooks with the token in their
 * `Authorization` header. A group with no matcher is for every tool.
 *
 * The confinement is written into every session, sandboxed or not: the
 * person's own settings may turn the sandbox on, and without it the
 * sandbox's lines change nothing.
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
  const permissions = {
    ...parts.permissions,
    deny: [...(parts.permissions.deny ?? []), ...stateRootDenies(parts.confinement.stateRoots)],
  };
  return { hooks, permissions, sandbox: sandboxLines(parts.confinement) };
}
