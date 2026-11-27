import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PROJECTS_FOLDER } from '../transcript-files.ts';
import type { ToolCall } from './hook-events.ts';

/** What the transcript records when a turn is interrupted while the agent writes. */
export const INTERRUPTED = '[Request interrupted by user]';

/** What the transcript records when a turn is interrupted while a tool call is open. */
export const INTERRUPTED_FOR_TOOL_USE = '[Request interrupted by user for tool use]';

/** An interruption marker. */
export type InterruptionMarker = typeof INTERRUPTED | typeof INTERRUPTED_FOR_TOOL_USE;

/** The file a conversation is written to, an entry a line. */
export interface Transcript {
  /** Records a prompt that was taken. */
  recordPrompt(prompt: string): void;
  /** Records a text the agent answered. */
  recordReply(text: string): void;
  /** Records a tool call the agent made. */
  recordToolCall(call: ToolCall): void;
  /** Records that the turn was interrupted. */
  recordInterruption(marker: InterruptionMarker): void;
  /** Records the error of the API a turn failed on, as the agent's last message: what it shows. */
  recordApiError(failure: { readonly error: string; readonly message: string }): void;
  /**
   * Records a local command once it ran, as Claude Code does: the caveat that
   * the command is the person's own, then its name and its output or its
   * error; an interrupted command, the caveat alone.
   */
  recordCommand(command: RanCommand): void;
}

/** A local command that ran, as the transcript records it. */
export type RanCommand =
  | {
      /** The command's name, without its slash. */
      readonly name: string;
      /** What it printed. */
      readonly output: string;
    }
  | {
      /** The command's name, without its slash. */
      readonly name: string;
      /** The error it ended on. */
      readonly error: string;
    }
  | {
      /** The command was interrupted. */
      readonly interrupted: true;
    };

/** The caveat Claude Code records with every local command. */
const COMMAND_CAVEAT =
  "<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request, and its output goes straight to the user. It's recorded here as context for later messages.</local-command-caveat>";

/**
 * Names the transcript of a conversation.
 *
 * @param configFolder - The agent's configuration folder.
 * @param cwd - The folder the conversation first ran in.
 * @param sessionId - The conversation's id.
 * @returns The file's path: in the project folder named after `cwd`.
 */
export function transcriptPathFor(configFolder: string, cwd: string, sessionId: string): string {
  return join(configFolder, PROJECTS_FOLDER, projectFolderName(cwd), `${sessionId}.jsonl`);
}

/**
 * Names the folder Claude Code keeps a project's files in, after the folder
 * the conversation runs in: every character but a letter or a digit a dash.
 *
 * @param cwd - The folder the conversation runs in.
 */
export function projectFolderName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** An entry of a transcript, as the fake agent writes them. */
interface Entry {
  readonly type: 'user' | 'assistant' | 'system';
  readonly timestamp: string;
  readonly isMeta?: boolean;
  readonly message?: { readonly content: unknown };
}

function entriesOf(path: string): Entry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Entry);
}

/**
 * Counts the prompts a conversation took: each a `user` entry of text, a
 * local command's name among them, but for the caveat (an entry of the
 * agent's own) and a command's output.
 *
 * @param path - Its transcript; one that does not exist holds none.
 */
export function countPrompts(path: string): number {
  return entriesOf(path).filter((entry) => {
    const content = entry.message?.content;
    return (
      entry.type === 'user' &&
      entry.isMeta !== true &&
      typeof content === 'string' &&
      !content.startsWith('<local-command-')
    );
  }).length;
}

/**
 * Tells how long ago the agent last answered in a conversation, with a text or a tool call.
 *
 * @param path - Its transcript; one that does not exist holds no answer.
 * @param now - The moment to count back from.
 * @returns The whole seconds since; `undefined` when the agent never answered.
 */
export function secondsSinceLastResponse(path: string, now: Date): number | undefined {
  const last = entriesOf(path).findLast((entry) => entry.type === 'assistant');
  if (last === undefined) return undefined;
  return Math.floor((now.getTime() - new Date(last.timestamp).getTime()) / 1000);
}

/**
 * Opens a conversation's transcript for writing. The file appears with its
 * first entry.
 *
 * @param path - The file's path.
 * @param sessionId - The conversation's id, which each entry carries.
 */
export function openTranscript(path: string, sessionId: string): Transcript {
  function append(entry: object): void {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
  }

  function record(type: 'user' | 'assistant', content: unknown, marks: object = {}): void {
    append({
      type,
      sessionId,
      timestamp: new Date().toISOString(),
      ...marks,
      message: { role: type, content },
    });
  }

  /** Seen of Claude Code: a command's error is an entry of its own, of the `system` type. */
  function recordSystem(content: string, marks: object): void {
    append({
      type: 'system',
      subtype: 'local_command',
      content,
      level: 'info',
      timestamp: new Date().toISOString(),
      isMeta: false,
      ...marks,
      sessionId,
    });
  }

  function recordCommand(command: RanCommand): void {
    record('user', COMMAND_CAVEAT, { isMeta: true, rowSource: 'harness' });
    if ('interrupted' in command) return;
    const { name } = command;
    record(
      'user',
      `<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args></command-args>`,
      { rowSource: 'local' },
    );
    if ('output' in command) {
      record('user', `<local-command-stdout>${command.output}</local-command-stdout>`, {
        rowSource: 'local',
      });
    } else {
      recordSystem(`<local-command-stderr>${command.error}</local-command-stderr>`, {
        commandRun: { command: name, args: '' },
        commandOutcome: { kind: 'failed' },
      });
    }
  }

  return {
    recordPrompt: (prompt) => record('user', prompt),
    recordReply: (text) => record('assistant', [{ type: 'text', text }]),
    recordToolCall: ({ id, name, input }) =>
      record('assistant', [{ type: 'tool_use', id, name, input }]),
    recordInterruption: (marker) => record('user', [{ type: 'text', text: marker }]),
    // Seen of Claude Code: an assistant entry marked as the API's error, the kind of error beside it.
    recordApiError: ({ error, message }) =>
      record('assistant', [{ type: 'text', text: message }], { isApiErrorMessage: true, error }),
    recordCommand,
  };
}
