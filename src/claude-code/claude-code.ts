import { join } from 'node:path';
import {
  type Conversation,
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
import { agentVersionReader } from './agent-version.js';
import { agentConfigFolder, keepsConversation, type TranscriptLookup } from './conversations.js';
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
  laidOver,
  type PermissionMode,
} from './options.js';
import { personsFolderIssues, personsStartUpFiles } from './persons-files.js';
import { sandboxChecker } from './sandbox-check.js';
import { readScreen } from './screen-reading.js';
import { settingsDocument } from './settings-document.js';
import { TESTED_RANGE } from './tested-range.js';
import { followTranscript } from './transcript-watch.js';

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
 * app's permission rules (and a job's), the sandbox when the app asks for
 * it, and the lines that keep the agent from the cockpit's state, the
 * app's ports and every file that starts code at the agent's next launch
 * (settings, configuration files and `.mcp.json`, plugins).
 *
 * A session in `default`, `acceptEdits` or `dontAsk` counts as keeping
 * its network to the cockpit's allow-list (its sandboxed commands were
 * seen to ask, or to be refused, beyond it); one in `plan`, `auto` or
 * `bypassPermissions` counts as open, which an app opened beyond loopback
 * must accept.
 *
 * A launch with the sandbox asked for rejects with `CockpitError`
 * `sandbox-unavailable` when the agent would not find what the sandbox
 * needs (on Linux, `bwrap` and `socat` on its `PATH`), or `bwrap` cannot
 * make what it must (probed once per driver, nested as the agent's sandbox
 * does: an AppArmor-confined `bwrap` is caught here, not seen as a session
 * that ends at once): it never runs unsandboxed instead. A launch rejects
 * with `invalid-options` when its environment names a configuration folder
 * or a home its deny rules could miss (relative, or holding a character a
 * rule reads as its own), as `createCockpit` does.
 *
 * `claudeCode.job(…)` builds a job's driver part.
 *
 * @param options - See {@link ClaudeCodeOptions}: the permission mode
 * (`default` when left out), the permission rules, the acceptance of an
 * open network, the model, the plugin, the sources of settings, whether
 * other MCP servers load, and the sandbox.
 * @returns The driver.
 * @throws `CockpitError` `invalid-options` when the options do not fit,
 * any other option among them.
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
  const checkSandbox = sandboxChecker();
  return {
    terminalKeys: TERMINAL_KEYS,
    silentStartCause: SILENT_START_CAUSE,
    testedRange: TESTED_RANGE,
    agentVersion: agentVersionReader(TESTED_RANGE),
    checkPart: checkJobPart,
    environmentIssues: personsFolderIssues,
    networkOf: (part) => networkOf(checked, part),
    readScreen,
    launch: async (launch) => {
      await refuseUnconfinableEnvironment(launch.environment);
      if (checked.sandbox !== undefined) await checkSandbox(launch.environment);
      return launchSession(launch, checked);
    },
    readHook,
    follow: (conversation, report) => followTranscript(lookupOf(conversation), report).stop,
    canResume: (conversation) => keepsConversation(lookupOf(conversation)),
  };
}

/**
 * Where the agent of a session keeps its conversation: the configuration
 * folder of the environment it was launched with, never the server's,
 * which may hold a `CLAUDE_CONFIG_DIR` the app hid from its sessions.
 */
function lookupOf({ conversationId, directory, environment }: Conversation): TranscriptLookup {
  return { configFolder: agentConfigFolder(environment), conversationId, directory };
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
  const mode = laidOver(options, part as ClaudeCodeJobPart | undefined).permissionMode;
  if (CONFINED_MODES.has(mode)) return { reach: 'confined' };
  const reason = mode === 'bypassPermissions' ? BYPASS_REASON : namedHostsReason(mode);
  return { reach: 'open', accepted: options.acceptOpenNetwork, reason };
}

async function launchSession(launch: Launch, options: CheckedOptions): Promise<LaunchCommand> {
  const session = laidOver(options, launch.part as ClaudeCodeJobPart | undefined);
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
        permissions: session.permissions,
        confinement: launch.confinement,
        ...(await personsStartUpFiles(launch.environment)),
        sandbox: options.sandbox,
      }),
    ),
  );
  return {
    command: AGENT_COMMAND,
    args: agentArguments({
      conversationId: launch.conversationId,
      resume: launch.resume,
      settingsFile,
      permissionMode: session.permissionMode,
      model: session.model,
      pluginDir: options.pluginDir,
      settingSources: options.settingSources,
      otherMcpServers: options.otherMcpServers,
      prompt: launch.prompt,
    }),
    environment: agentEnvironment(launch.environment),
  };
}

/**
 * Refuses a launch whose environment names a configuration folder or a
 * home the denies of the person's files could miss: `createCockpit`
 * checked the server's environment, but a launch reads it anew.
 */
async function refuseUnconfinableEnvironment(
  environment: Readonly<Record<string, string>>,
): Promise<void> {
  const issues = await personsFolderIssues(environment);
  if (issues.length === 0) return;
  throw new CockpitError(
    'invalid-options',
    "The agent's files cannot be kept from it in the environment it is launched with.",
    { issues },
  );
}

function hookUrl(base: string): string {
  return `${base.replace(/\/+$/, '')}${HOOKS_PATH}`;
}
