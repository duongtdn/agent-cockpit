import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PermissionMode, SettingSource } from './options.js';

/** The agent's program, looked up on the session's `PATH`. */
export const AGENT_COMMAND = 'claude';

/** What a launch's arguments are made of. */
export interface ArgumentParts {
  /** The conversation's id, which the core minted. */
  readonly conversationId: string;
  /** Whether the conversation exists and is resumed, rather than started under the id. */
  readonly resume?: boolean | undefined;
  /** The session's settings file. */
  readonly settingsFile: string;
  /** The mode the session runs in. */
  readonly permissionMode: PermissionMode;
  /** The session's model; none for the person's default. */
  readonly model?: string | undefined;
  /** The app's plugin folder, absolute. */
  readonly pluginDir?: string | undefined;
  /** The only sources of settings read below the session's own; none for every source. */
  readonly settingSources?: readonly SettingSource[] | undefined;
  /** Whether MCP servers other than the cockpit's load. */
  readonly otherMcpServers: boolean;
  /** The first prompt; none for a session that waits for one. */
  readonly prompt?: string | undefined;
}

/**
 * Gives the arguments of a launch: a new conversation under the id, or the
 * one of the id resumed. An option the app left out is not written, but the
 * mode. The prompt comes last, after `--`: an option that takes several
 * values would otherwise read it as one of them.
 *
 * @param parts - See {@link ArgumentParts}.
 * @returns The arguments, each a word of its own.
 */
export function agentArguments(parts: ArgumentParts): string[] {
  return [
    parts.resume === true ? '--resume' : '--session-id',
    parts.conversationId,
    '--settings',
    parts.settingsFile,
    // Always: the person's own defaultMode never applies by accident.
    '--permission-mode',
    parts.permissionMode,
    ...optionWithValue('--model', parts.model),
    ...optionWithValue('--plugin-dir', parts.pluginDir),
    // An empty list is the empty word: no source at all.
    ...optionWithValue('--setting-sources', parts.settingSources?.join(',')),
    ...(parts.otherMcpServers ? [] : ['--strict-mcp-config']),
    ...(parts.prompt === undefined ? [] : ['--', parts.prompt]),
  ];
}

function optionWithValue(option: string, value: string | undefined): string[] {
  return value === undefined ? [] : [option, value];
}

/**
 * Finds a program as a launch would: in the first folder of the `PATH`
 * that holds a file of that name that can be run. Only absolute folders
 * count: a relative one is relative to wherever the agent runs.
 *
 * @param name - The program's name.
 * @param path - The launch's `PATH`.
 * @returns The program's path; `undefined` when no folder holds it.
 */
export async function findProgram(
  name: string,
  path: string | undefined,
): Promise<string | undefined> {
  for (const folder of (path ?? '').split(delimiter)) {
    if (!isAbsolute(folder)) continue;
    const candidate = join(folder, name);
    if (await canRun(candidate)) return candidate;
  }
  return undefined;
}

async function canRun(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Whether a variable is Claude Code's own, as a session passes it to what it runs. */
function isAgentsOwn(name: string): boolean {
  return name.startsWith('CLAUDE_CODE_') || name === 'CLAUDECODE';
}

/**
 * Gives the agent's environment: the one the core gives, without Claude
 * Code's own variables. A server started from a Claude Code session has
 * them, among them that session's messaging socket and token, which no
 * launched agent may inherit. A person who sets a provider (Bedrock, a base
 * URL) in the `env` of their own Claude Code settings keeps it: the agent
 * applies that `env` itself, past this stripping, and the session's
 * settings write none over it.
 *
 * @param inherited - The environment the core gives the launch.
 * @returns The agent's whole environment.
 */
export function agentEnvironment(
  inherited: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(inherited).filter(([name]) => !isAgentsOwn(name)));
}

/**
 * The `SessionStart` hook's program, beside this module: its JavaScript in
 * the built package, its source in the package's own tests, which run on a
 * Node that strips types.
 */
const SESSION_START_HOOK = fileURLToPath(
  new URL(`./session-start-hook${extname(import.meta.url)}`, import.meta.url),
);

/**
 * Gives the shell command of the `SessionStart` hook: the Node the app runs
 * on, the hook's program, and the file it reads the session's address from.
 *
 * @param addressFile - The session's address file.
 * @returns The command, each word quoted for the shell that runs it.
 */
export function sessionStartCommand(addressFile: string): string {
  return [process.execPath, SESSION_START_HOOK, addressFile].map(shellWord).join(' ');
}

/** Quotes a word for a POSIX shell: inside single quotes nothing is special but the quote itself. */
export function shellWord(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}
