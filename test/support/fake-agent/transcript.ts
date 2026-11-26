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
}

/**
 * Names the transcript of a conversation.
 *
 * @param configFolder - The agent's configuration folder.
 * @param cwd - The folder the conversation first ran in.
 * @param sessionId - The conversation's id.
 * @returns The file's path: in the project folder named after `cwd`.
 */
export function transcriptPathFor(configFolder: string, cwd: string, sessionId: string): string {
  const project = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return join(configFolder, PROJECTS_FOLDER, project, `${sessionId}.jsonl`);
}

/** An entry of a transcript, as the fake agent writes them. */
interface Entry {
  readonly type: 'user' | 'assistant';
  readonly timestamp: string;
  readonly message: { readonly content: unknown };
}

function entriesOf(path: string): Entry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Entry);
}

/**
 * Counts the prompts a conversation took.
 *
 * @param path - Its transcript; one that does not exist holds none.
 */
export function countPrompts(path: string): number {
  return entriesOf(path).filter(
    (entry) => entry.type === 'user' && typeof entry.message.content === 'string',
  ).length;
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
  function record(type: 'user' | 'assistant', content: unknown): void {
    const entry = {
      type,
      sessionId,
      timestamp: new Date().toISOString(),
      message: { role: type, content },
    };
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
  }

  return {
    recordPrompt: (prompt) => record('user', prompt),
    recordReply: (text) => record('assistant', [{ type: 'text', text }]),
    recordToolCall: ({ id, name, input }) =>
      record('assistant', [{ type: 'tool_use', id, name, input }]),
    recordInterruption: (marker) => record('user', [{ type: 'text', text: marker }]),
  };
}
