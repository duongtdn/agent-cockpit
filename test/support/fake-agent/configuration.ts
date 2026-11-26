import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';

/** The file of the configuration folder that keeps what the person answered at a start. */
const STATE_FILE = '.claude.json';

/** The person's own settings, in the configuration folder. */
const PERSONS_SETTINGS_FILE = 'settings.json';

/** How many of a key's last characters the configuration names an approved or rejected key by. */
const KEY_SUFFIX_LENGTH = 20;

/**
 * Gives the part of an API key by which the configuration names it, and the
 * question about it shows it.
 *
 * @param apiKey - The key; none gives an empty text.
 */
export function keySuffixOf(apiKey: string | undefined): string {
  return apiKey?.slice(-KEY_SUFFIX_LENGTH) ?? '';
}

/** The settings of the person's own the fake agent plays; any other is refused. */
const PLAYED_PERSONS_SETTINGS: readonly string[] = [
  'skipDangerousModePermissionPrompt',
  'disableAllHooks',
];

/** A dialog Claude Code shows at a start, before any hook. */
export type StartUpDialogKind = 'trust-folder' | 'api-key' | 'bypass-permissions';

/** What a session is started with, as far as the configuration decides what it shows. */
export interface StartingSession {
  /** The agent's configuration folder. */
  readonly configFolder: string;
  /** The folder the session runs in, resolved. */
  readonly cwd: string;
  /** The session's permission mode. */
  readonly permissionMode: string;
  /** The API key of the environment, if any. */
  readonly apiKey: string | undefined;
}

/** The configuration of a session's agent: what it shows at the start, and what the answers write. */
export interface AgentConfiguration {
  /** The start-up dialogs the session shows, in the order Claude Code shows them. */
  readonly startUpDialogs: readonly StartUpDialogKind[];
  /** Whether the person's settings turn every hook off. */
  readonly hooksOff: boolean;
  /** Whether the person declined the environment's API key: every turn then fails on the login. */
  readonly keyRejected: boolean;
  /** Writes the answer that keeps a dialog from showing again, as Claude Code does on a Yes. */
  accept(dialog: StartUpDialogKind): void;
  /** Writes that the person declined the key, as Claude Code does on a No to its question. */
  rejectKey(): void;
}

/**
 * Reads a session's configuration as Claude Code does: the folder's trust,
 * the answer about the key and the onboarding in `.claude.json`, the
 * person's own `settings.json`. A configuration folder with no
 * `.claude.json` is played as the tests' recipe for a start with no dialog
 * (the onboarding done, the folder trusted, the key approved), which is what
 * the fake agent played before it read the file; the person's settings are
 * read either way.
 *
 * @param session - See {@link StartingSession}.
 * @returns The configuration.
 * @throws `Error` for what the fake agent does not play: an onboarding not
 * done (its theme picker, then a login), a session with no API key (a
 * login), the question about the key together with another dialog (their
 * order was not observed), a setting of the person's other than the
 * warning of `bypassPermissions` accepted and the hooks turned off.
 */
export function readConfiguration(session: StartingSession): AgentConfiguration {
  const statePath = join(session.configFolder, STATE_FILE);
  const settingsPath = join(session.configFolder, PERSONS_SETTINGS_FILE);
  const settings = personsSettings(settingsPath);
  const state = existsSync(statePath) ? readState(statePath) : undefined;
  const key = keyStanding(state, session.apiKey);
  const dialogs: StartUpDialogKind[] = [
    ...(state === undefined || isTrusted(state, session.cwd) ? [] : ['trust-folder' as const]),
    ...(key === 'unanswered' ? ['api-key' as const] : []),
    ...(session.permissionMode === 'bypassPermissions' &&
    settings.skipDangerousModePermissionPrompt !== true
      ? ['bypass-permissions' as const]
      : []),
  ];
  if (dialogs.includes('api-key') && dialogs.length > 1) {
    throw new Error(
      `the start shows the question about the API key with ${dialogs.filter((d) => d !== 'api-key').join(' and ')}: in which order was not observed`,
    );
  }
  const keySuffix = keySuffixOf(session.apiKey);
  return {
    startUpDialogs: dialogs,
    hooksOff: settings.disableAllHooks === true,
    keyRejected: key === 'rejected',
    accept(dialog) {
      if (dialog === 'trust-folder') changeState(statePath, (s) => trust(s, session.cwd));
      if (dialog === 'api-key') changeState(statePath, (s) => answerKey(s, keySuffix, 'approved'));
      if (dialog === 'bypass-permissions') acceptBypass(settingsPath);
    },
    rejectKey: () => changeState(statePath, (s) => answerKey(s, keySuffix, 'rejected')),
  };
}

type Json = Record<string, unknown>;

function readJson(path: string): Json {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(value)) throw new Error(`${path} holds no object`);
  return value;
}

function personsSettings(path: string): Json {
  if (!existsSync(path)) return {};
  const settings = readJson(path);
  const unplayed = Object.keys(settings).find((name) => !PLAYED_PERSONS_SETTINGS.includes(name));
  if (unplayed !== undefined) {
    throw new Error(
      `the person's settings carry ${JSON.stringify(unplayed)}: it plays ${PLAYED_PERSONS_SETTINGS.join(' and ')} only`,
    );
  }
  return settings;
}

function readState(path: string): Json {
  const state = readJson(path);
  if (state.hasCompletedOnboarding !== true) {
    throw new Error(
      'the configuration has the onboarding to do: its theme picker and login are not played',
    );
  }
  return state;
}

/** Seen of Claude Code: a folder inside a trusted folder is trusted, by its resolved path. */
function isTrusted(state: Json, cwd: string): boolean {
  const projects = isRecord(state.projects) ? state.projects : {};
  return Object.entries(projects).some(
    ([folder, project]) =>
      (cwd === folder || cwd.startsWith(folder + sep)) &&
      isRecord(project) &&
      project.hasTrustDialogAccepted === true,
  );
}

function keyStanding(
  state: Json | undefined,
  apiKey: string | undefined,
): 'approved' | 'rejected' | 'unanswered' {
  if (state === undefined) return 'approved';
  if (apiKey === undefined) {
    throw new Error('the session has no API key: the login it would ask for is not played');
  }
  const suffix = keySuffixOf(apiKey);
  const responses = isRecord(state.customApiKeyResponses) ? state.customApiKeyResponses : {};
  if (listOf(responses.approved).includes(suffix)) return 'approved';
  if (listOf(responses.rejected).includes(suffix)) return 'rejected';
  return 'unanswered';
}

function changeState(path: string, change: (state: Json) => Json): void {
  const state = existsSync(path) ? readJson(path) : {};
  writeFileSync(path, JSON.stringify(change(state), null, 2));
}

function trust(state: Json, cwd: string): Json {
  const projects = isRecord(state.projects) ? state.projects : {};
  const project = isRecord(projects[cwd]) ? projects[cwd] : {};
  return {
    ...state,
    projects: { ...projects, [cwd]: { ...project, hasTrustDialogAccepted: true } },
  };
}

/** Seen of Claude Code: an answer puts the key in one list and leaves the other there, emptied of it. */
function answerKey(state: Json, suffix: string, answer: 'approved' | 'rejected'): Json {
  const responses = isRecord(state.customApiKeyResponses) ? state.customApiKeyResponses : {};
  const other = answer === 'approved' ? 'rejected' : 'approved';
  return {
    ...state,
    customApiKeyResponses: {
      [answer]: [...listOf(responses[answer]), suffix],
      [other]: listOf(responses[other]).filter((kept) => kept !== suffix),
    },
  };
}

function acceptBypass(path: string): void {
  const settings = existsSync(path) ? readJson(path) : {};
  writeFileSync(
    path,
    JSON.stringify({ ...settings, skipDangerousModePermissionPrompt: true }, null, 2),
  );
}

function listOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
