import type { Confinement } from '../server/driver.js';
import { sandboxLines, startUpFileDenies, stateRootDenies } from './confinement-lines.js';
import { HTTP_HOOK_EVENTS } from './hook-payloads.js';
import type { ClaudeCodeSandbox, PermissionRules } from './options.js';

/** What a session's settings are written from. */
export interface SettingsParts {
  /** Where the HTTP hooks post: the session's hook URL, the driver's path included. */
  readonly hookUrl: string;
  /** The session's token for this launch, written literally in the hooks' header. */
  readonly token: string;
  /** The shell command that runs the `SessionStart` hook. */
  readonly sessionStartCommand: string;
  /**
   * The session's permission rules, the app's with a job's added; a list
   * left out is not written, but `deny`, which always carries the
   * confinement's.
   */
  readonly permissions: PermissionRules;
  /** What the agent must not reach, written whatever the app's rules say. */
  readonly confinement: Confinement;
  /**
   * The person's own files that start code at the agent's next launch, by
   * every path that names each: their settings and configuration files.
   * The agent may not edit them.
   */
  readonly personsFiles: readonly string[];
  /** The person's own folders of such files, by every path that names each: their plugins. */
  readonly personsFolders: readonly string[];
  /**
   * The sandbox the app asks for, with its exceptions; left out, the
   * person's own settings decide whether it runs.
   */
  readonly sandbox?: ClaudeCodeSandbox | undefined;
  /**
   * The name of the session's channel server, allowed in every mode; left
   * out for a session with no channel.
   */
  readonly channelServer?: string | undefined;
}

/**
 * Writes the settings a session is launched with (`--settings`): the hooks
 * that report to the cockpit, the session's permission rules, the
 * confinement's lines, the sandbox the app asks for, and the channel's
 * allow rule when the session has a channel. Claude Code merges them above
 * the person's and the project's settings, hooks too; a deny wins over any
 * allow of any of them. They hold no `env` (the person's own still
 * applies) and no answer to a start-up dialog (the person answers those).
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
  return { hooks: hooksOf(parts), permissions: permissionsOf(parts), sandbox: sandboxOf(parts) };
}

function hooksOf(parts: SettingsParts): object {
  const httpHook = {
    type: 'http',
    url: parts.hookUrl,
    headers: { Authorization: `Bearer ${parts.token}` },
  };
  return {
    SessionStart: [{ hooks: [{ type: 'command', command: parts.sessionStartCommand }] }],
    ...Object.fromEntries(HTTP_HOOK_EVENTS.map((event) => [event, [{ hooks: [httpHook] }]])),
  };
}

function permissionsOf(parts: SettingsParts): PermissionRules {
  const { allow, deny, ...others } = parts.permissions;
  // The channel's tools ask, or are denied, in most modes without it.
  const channel = parts.channelServer === undefined ? [] : [`mcp__${parts.channelServer}`];
  const allowed = [...(allow ?? []), ...channel];
  return {
    ...others,
    ...(allow === undefined && channel.length === 0 ? {} : { allow: allowed }),
    deny: [
      ...(deny ?? []),
      ...stateRootDenies(parts.confinement.stateRoots),
      ...startUpFileDenies(parts.personsFiles, parts.personsFolders),
    ],
  };
}

/**
 * The sandbox's section: the cockpit's lines, and when the app asks for the
 * sandbox, the sandbox on, refusing to start where it cannot run rather than
 * running unconfined, with the app's exceptions.
 */
function sandboxOf({ confinement, sandbox }: SettingsParts): object {
  const lines = sandboxLines(confinement);
  if (sandbox === undefined) return lines;
  const { excludedCommands, allowUnsandboxedCommands = false } = sandbox;
  return {
    enabled: true,
    failIfUnavailable: true,
    ...(excludedCommands === undefined ? {} : { excludedCommands }),
    ...lines,
    allowUnsandboxedCommands,
  };
}
