import { join } from 'node:path';
import {
  type Driver,
  type DriverPart,
  HOOKS_PATH,
  type HookAddress,
  type Launch,
  type LaunchCommand,
  type SessionNetwork,
} from '../server/driver.js';
import { writePrivateFile } from '../server/state/private-files.js';
import { CockpitError } from '../shared/cockpit-error.js';
import type { KeyRule } from '../shared/wire.js';
import { readAgentVersion } from './agent-version.js';
import { agentConfigFolder, keepsConversation } from './conversations.js';
import { readHook } from './hook-payloads.js';
import {
  AGENT_COMMAND,
  agentArguments,
  agentEnvironment,
  sessionStartCommand,
} from './launching.js';
import {
  type CheckedOptions,
  type ClaudeCodeJobPart,
  type ClaudeCodeOptions,
  checkJobPart,
  checkOptions,
  type PermissionMode,
} from './options.js';
import { readScreen } from './screen-reading.js';
import { settingsDocument } from './settings-document.js';
import { TESTED_RANGE } from './tested-range.js';

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

/** How the app accepts an open network, and what it accepts: the end of every reason. */
const ACCEPTANCE =
  "With authorize, a token read from a browser's storage works from afar: " +
  'claudeCode({ acceptOpenNetwork: true }) accepts it.';

/**
 * Why a session in `bypassPermissions` reaches the network beyond the
 * allow-list: its sandbox's proxies let a command through without asking,
 * where `default` asks.
 */
const BYPASS_REASON =
  'In bypassPermissions, a sandboxed command of Claude Code reaches the network beyond the ' +
  "cockpit's allow-list without asking: the app's other addresses, other local ports, the " +
  "internet, and the person's files, a browser's stored token among them. " +
  ACCEPTANCE;

/**
 * The modes whose sandboxed commands were seen to ask, or to be refused,
 * before each reach beyond the allow-list — whatever a command names in
 * its `allowed_domains`.
 */
const CONFINED_MODES: ReadonlySet<PermissionMode> = new Set(['default', 'acceptEdits', 'dontAsk']);

/**
 * Why a session in `plan` or `auto` reaches the network beyond the
 * allow-list: a command may name hosts in its `allowed_domains`, and once
 * the command is approved — by `auto`'s server-side check, with no person
 * asked — they are reached with no ask of the network.
 */
function namedHostsReason(mode: PermissionMode): string {
  return (
    `In ${mode}, a sandboxed command of Claude Code was measured reaching hosts beyond the ` +
    "cockpit's allow-list with no ask of the network once the command naming them in its " +
    'allowed_domains is approved, which the server-side check of auto mode (run in plan too) ' +
    "does without asking the person: other local ports, the internet, and the person's files, a " +
    `browser's stored token among them. ${ACCEPTANCE}`
  );
}

/**
 * Creates the Claude Code driver, which `createCockpit` takes as its
 * `driver`. It launches `claude` from the `PATH` of the server's
 * environment, in the session's folder, with settings of its own written in
 * the cockpit's state folder: the hooks that report to the cockpit, the
 * app's permission rules, and the lines that keep the agent from the
 * cockpit's state and the app's ports.
 *
 * A session in `default`, `acceptEdits` or `dontAsk` counts as keeping
 * its network to the cockpit's allow-list (its sandboxed commands were
 * seen to ask, or to be refused, beyond it); one in `plan`, `auto` or
 * `bypassPermissions` counts as open, which an app opened beyond loopback
 * must accept.
 *
 * `claudeCode.job(…)` builds a job's driver part.
 *
 * @param options - The permission mode every session is launched in
 * (`default` when left out), the permission rules its settings carry, and
 * whether the app accepts the open network of `plan`, `auto` or
 * `bypassPermissions`.
 * @returns The driver.
 * @throws `CockpitError` `invalid-options` when the options do not fit,
 * any option other than these three among them.
 */
export const claudeCode: {
  (options?: ClaudeCodeOptions): Driver;
  /**
   * Builds a job's driver part (ADR-0051), which the job carries as
   * `driver`: its permission mode replaces the app's, its rules are added
   * to the app's, its model is the sessions' own.
   *
   * @param part - The mode, the rules and the model, each optional.
   * @returns The part, as given.
   * @throws `CockpitError` `invalid-options`, with every issue found, when
   * it does not fit: anything else a job may not set among them.
   */
  job(part: ClaudeCodeJobPart): ClaudeCodeJobPart;
} = Object.assign(createDriver, { job: jobPart });

function createDriver(options?: ClaudeCodeOptions): Driver {
  const checked = checkOptions(options);
  return {
    terminalKeys: TERMINAL_KEYS,
    silentStartCause: SILENT_START_CAUSE,
    testedRange: TESTED_RANGE,
    agentVersion: (environment) => readAgentVersion(environment, TESTED_RANGE),
    checkPart: checkJobPart,
    networkOf: (part) => networkOf(checked, part),
    readScreen,
    launch: (launch) => launchSession(launch, checked),
    readHook,
    canResume: ({ conversationId }) =>
      keepsConversation(agentConfigFolder(process.env), conversationId),
  };
}

function jobPart(part: ClaudeCodeJobPart): ClaudeCodeJobPart {
  const issues = checkJobPart(part);
  if (issues.length > 0) {
    throw new CockpitError('invalid-options', "A job's Claude Code driver part does not fit.", {
      issues,
    });
  }
  return part;
}

/** The network of a session: the job's mode, else the app's; the acceptance always the app's. */
function networkOf(options: CheckedOptions, part?: DriverPart): SessionNetwork {
  const permissionMode = (part as ClaudeCodeJobPart | undefined)?.permissionMode;
  const mode = permissionMode ?? options.permissionMode;
  if (CONFINED_MODES.has(mode)) return { reach: 'confined' };
  const reason = mode === 'bypassPermissions' ? BYPASS_REASON : namedHostsReason(mode);
  return { reach: 'open', accepted: options.acceptOpenNetwork, reason };
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
        confinement: launch.confinement,
      }),
    ),
  );
  return {
    command: AGENT_COMMAND,
    args: agentArguments({
      conversationId: launch.conversationId,
      resume: launch.resume,
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
