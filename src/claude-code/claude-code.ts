import { join } from 'node:path';
import {
  type Driver,
  HOOKS_PATH,
  type HookAddress,
  type Launch,
  type LaunchCommand,
  type SessionNetwork,
} from '../server/driver.js';
import { writePrivateFile } from '../server/state/private-files.js';
import type { KeyRule } from '../shared/wire.js';
import { agentConfigFolder, keepsConversation } from './conversations.js';
import { readHook } from './hook-payloads.js';
import {
  AGENT_COMMAND,
  agentArguments,
  agentEnvironment,
  sessionStartCommand,
} from './launching.js';
import { type CheckedOptions, type ClaudeCodeOptions, checkOptions } from './options.js';
import { settingsDocument } from './settings-document.js';

/** The session's settings, which carry the token in the HTTP hooks' header. */
const SETTINGS_FILE = 'settings.json';

/** Where the `SessionStart` hook reports, with the token: its command line names only this file. */
const ADDRESS_FILE = 'hook-address.json';

/**
 * Claude Code's one terminal key: Shift+Enter sends ESC CR, a line break in
 * its input box, where a terminal's bare CR would submit.
 */
const TERMINAL_KEYS: readonly KeyRule[] = [{ key: 'Enter', modifiers: ['shift'], send: '\x1b\r' }];

const SILENT_START_CAUSE =
  "Claude Code's SessionStart hook never reported: its hooks may be turned off " +
  '(disableAllHooks, or managed settings that allow only their own), or the agent ' +
  'stopped before it took input.';

/**
 * Why a session in `bypassPermissions` reaches the network beyond the
 * allow-list: its sandbox's proxies let a command through without asking,
 * where another mode asks.
 */
const OPEN_NETWORK_REASON =
  'In bypassPermissions, a sandboxed command of Claude Code reaches the network beyond the ' +
  "cockpit's allow-list without asking: the app's other addresses, other local ports, the " +
  "internet, and the person's files, a browser's stored token among them. With authorize, " +
  'that token works from afar: claudeCode({ acceptOpenNetwork: true }) accepts it.';

/**
 * Creates the Claude Code driver, which `createCockpit` takes as its
 * `driver`. It launches `claude` from the `PATH` of the server's
 * environment, in the session's folder, with settings of its own written in
 * the cockpit's state folder: the hooks that report to the cockpit and the
 * app's permission rules.
 *
 * @param options - The permission mode every session is launched in
 * (`default` when left out), the permission rules its settings carry, and
 * whether the app accepts the open network of `bypassPermissions`.
 * @returns The driver.
 * @throws `CockpitError` `invalid-options` when the options do not fit,
 * any option other than these three among them.
 */
export function claudeCode(options?: ClaudeCodeOptions): Driver {
  const checked = checkOptions(options);
  return {
    terminalKeys: TERMINAL_KEYS,
    silentStartCause: SILENT_START_CAUSE,
    network: networkOf(checked),
    launch: (launch) => launchSession(launch, checked),
    readHook,
    canResume: ({ conversationId }) =>
      keepsConversation(agentConfigFolder(process.env), conversationId),
  };
}

function networkOf({ permissionMode, acceptOpenNetwork }: CheckedOptions): SessionNetwork {
  if (permissionMode !== 'bypassPermissions') return { reach: 'confined' };
  return { reach: 'open', accepted: acceptOpenNetwork, reason: OPEN_NETWORK_REASON };
}

async function launchSession(launch: Launch, options: CheckedOptions): Promise<LaunchCommand> {
  const address: HookAddress = { url: hookUrl(launch.hooks.url), token: launch.hooks.token };
  const addressFile = join(launch.files, ADDRESS_FILE);
  const settingsFile = join(launch.files, SETTINGS_FILE);
  await writePrivateFile(addressFile, JSON.stringify(address));
  await writePrivateFile(
    settingsFile,
    JSON.stringify(
      settingsDocument({
        hookUrl: address.url,
        token: address.token,
        sessionStartCommand: sessionStartCommand(addressFile),
        permissions: options.permissions,
      }),
    ),
  );
  return {
    command: AGENT_COMMAND,
    args: agentArguments({
      conversationId: launch.conversationId,
      settingsFile,
      permissionMode: options.permissionMode,
      prompt: launch.prompt,
    }),
    environment: agentEnvironment(launch.environment),
  };
}

function hookUrl(base: string): string {
  return `${base.replace(/\/+$/, '')}${HOOKS_PATH}`;
}
