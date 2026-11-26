import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PermissionMode } from './options.js';

/** The agent's program, looked up on the session's `PATH`. */
export const AGENT_COMMAND = 'claude';

/** What a launch's arguments are made of. */
export interface ArgumentParts {
  /** The conversation's id, which the core minted. */
  readonly conversationId: string;
  /** The session's settings file. */
  readonly settingsFile: string;
  /** The mode the session runs in. */
  readonly permissionMode: PermissionMode;
  /** The first prompt; none for a session that waits for one. */
  readonly prompt?: string | undefined;
}

/**
 * Gives the arguments of a launch of a new conversation. The prompt comes
 * last, after `--`: an option that takes several values would otherwise
 * read it as one of them.
 *
 * @param parts - See {@link ArgumentParts}.
 * @returns The arguments, each a word of its own.
 */
export function agentArguments(parts: ArgumentParts): string[] {
  return [
    '--session-id',
    parts.conversationId,
    '--settings',
    parts.settingsFile,
    // Always: the person's own defaultMode never applies by accident.
    '--permission-mode',
    parts.permissionMode,
    ...(parts.prompt === undefined ? [] : ['--', parts.prompt]),
  ];
}

/** Whether a variable is Claude Code's own, as a session passes it to what it runs. */
function isAgentsOwn(name: string): boolean {
  return name.startsWith('CLAUDE_CODE_') || name === 'CLAUDECODE';
}

/**
 * Gives the agent's environment: the one the core gives, without Claude
 * Code's own variables. A server started from a Claude Code session has
 * them, among them that session's messaging socket and token, which no
 * launched agent may inherit.
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
