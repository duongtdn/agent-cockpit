import { join } from 'node:path';
import {
  type Conversation,
  type Driver,
  type DriverPart,
  type DriverSettings,
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
import { createHookReader } from './hook-payloads.js';
import {
  AGENT_COMMAND,
  agentArguments,
  agentEnvironment,
  MAX_LAUNCH_PROMPT_BYTES,
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
import { readInputBox, readScreen, SCREEN_STATE_SIGNS } from './screen-reading.js';
import { settingsDocument } from './settings-document.js';
import { TESTED_RANGE } from './tested-range.js';
import { followTranscript } from './transcript-watch.js';
import { typePrompt } from './typing.js';

/**
 * How a session is ended: SIGTERM, never `/exit`, which a person's draft
 * would turn into a prompt and background tasks into a dialog. The agent
 * exits within 0.6–1.4 s, its conversation resumable; the bound leaves it
 * room under load.
 */
const ENDING = { signal: 'SIGTERM', boundMs: 5_000 } as const;

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

/** How the app accepts an open session, and what it accepts: the end of every reason. */
const ACCEPTANCE =
  "With authorize, a token read from a browser's storage works from afar: " +
  'claudeCode({ acceptOpenNetwork: true }) accepts it.';

/**
 * Why a session in `bypassPermissions` reaches the network beyond the
 * allow-list: its sandbox's proxies let a command through without asking,
 * where `default` asks.
 */
const BYPASS_NETWORK_REASON =
  'In bypassPermissions, a sandboxed command of Claude Code reaches the network beyond the ' +
  "cockpit's allow-list without asking: the app's other addresses, other local ports, the " +
  "internet, and the person's files, a browser's stored token among them.";

/**
 * The modes whose sandboxed commands were seen to ask, or to be refused,
 * before each reach beyond the allow-list — whatever a command names in
 * its `allowed_domains`.
 */
const NETWORK_CONFINED_MODES: ReadonlySet<PermissionMode> = new Set([
  'default',
  'acceptEdits',
  'dontAsk',
]);

/**
 * Why a session in this mode reaches the network beyond the allow-list
 * without asking; none when its commands ask or are refused there.
 */
function networkReason(mode: PermissionMode): string | undefined {
  if (NETWORK_CONFINED_MODES.has(mode)) return undefined;
  return mode === 'bypassPermissions' ? BYPASS_NETWORK_REASON : namedHostsReason(mode);
}

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
    "browser's stored token among them."
  );
}

/**
 * Where the file tools of each mode that writes without asking the person
 * write so. The file tools run in the agent's process, outside the
 * sandbox, and a hook may run what they wrote; the other modes ask
 * (`default`), refuse (`dontAsk`) or write nothing (`plan`).
 */
const UNASKED_WRITES: Readonly<Partial<Record<PermissionMode, string>>> = {
  acceptEdits: 'inside the work folder',
  auto: 'wherever its server-side check approves',
  bypassPermissions: "anywhere but the files the cockpit's denies name",
};

/**
 * Why a session in this mode acts as the person through its file tools;
 * none when they write nothing the person was not asked about.
 */
function unaskedWritesReason(mode: PermissionMode): string | undefined {
  const where = UNASKED_WRITES[mode];
  if (where === undefined) return undefined;
  return (
    `In ${mode}, the file tools of Claude Code write files without asking the person, ${where}: ` +
    "a script written there runs outside the sandbox once a hook of the project's or the " +
    "person's runs it, and reaches what the person's own commands reach, a browser's stored " +
    'token among them.'
  );
}

/**
 * Creates the Claude Code driver, which `createCockpit` takes as its
 * `driver`. It launches `claude` from the `PATH` of the server's
 * environment, in the session's folder, with settings of its own written in
 * the cockpit's state folder: the hooks that report to the cockpit, the
 * app's permission rules (and a job's), the sandbox when the app asks for
 * it, and the lines that keep the agent from the cockpit's state, the
 * app's ports and the files it can name that start code at the agent's
 * next launch (settings, configuration files and `.mcp.json`, the hooks'
 * scripts, agents and skills of a `.claude` folder, the person's plugins,
 * agents and skills).
 *
 * A session in `default` or `dontAsk` counts as confined: its sandboxed
 * commands were seen to ask, or to be refused, beyond the cockpit's
 * allow-list, and its file tools ask before a write or refuse it. One in
 * `plan`, `auto` or `bypassPermissions` counts as open for its network (a
 * sandboxed command was seen to reach beyond the allow-list unasked), and
 * one in `acceptEdits`, `auto` or `bypassPermissions` for its writes (the
 * file tools write without asking the person, outside the sandbox, files a
 * hook may run): an app opened beyond loopback must accept an open mode.
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
 * open mode, the model, the plugin, the sources of settings, whether
 * other MCP servers load, and the sandbox.
 * @returns The driver.
 * @throws `CockpitError` `invalid-options` when the options do not fit,
 * any other option among them.
 */
export const claudeCode: {
  (options?: ClaudeCodeOptions): Driver;
  /**
   * Builds a job's driver part, which the job carries as
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
    screenStateSigns: SCREEN_STATE_SIGNS,
    readInputBox,
    typePrompt,
    promptFitsLaunch: (prompt) => Buffer.byteLength(prompt) <= MAX_LAUNCH_PROMPT_BYTES,
    launchSettings: (part) => launchSettingsOf(checked, part),
    ending: ENDING,
    launch: async (launch) => {
      await refuseUnconfinableEnvironment(launch.environment);
      if (checked.sandbox !== undefined) await checkSandbox(launch.environment);
      return launchSession(launch, checked);
    },
    readHook: createHookReader(),
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

/**
 * What reaches a launch: the mode, the rules and the model with the job's
 * part laid over the app's, and the app's plugin, sources of settings,
 * MCP servers and sandbox. An option left out is left out here too, so
 * that the settings read back from JSON as they were.
 */
function launchSettingsOf(options: CheckedOptions, part?: DriverPart): DriverSettings {
  const { permissionMode, permissions, model } = laidOver(
    options,
    part as ClaudeCodeJobPart | undefined,
  );
  const { pluginDir, settingSources, otherMcpServers, sandbox } = options;
  return JSON.parse(
    JSON.stringify({
      permissionMode,
      permissions,
      model,
      pluginDir,
      settingSources,
      otherMcpServers,
      sandbox,
    }),
  ) as DriverSettings;
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

/**
 * The reach of a session — its commands' network and its file tools'
 * writes — by the job's mode, else the app's; the acceptance always the
 * app's.
 */
function networkOf(options: CheckedOptions, part?: DriverPart): SessionNetwork {
  const mode = laidOver(options, part as ClaudeCodeJobPart | undefined).permissionMode;
  const reasons = [networkReason(mode), unaskedWritesReason(mode)].filter(
    (reason) => reason !== undefined,
  );
  if (reasons.length === 0) return { reach: 'confined' };
  return {
    reach: 'open',
    accepted: options.acceptOpenNetwork,
    reason: [...reasons, ACCEPTANCE].join(' '),
  };
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
