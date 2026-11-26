import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PROJECTS_FOLDER } from '../transcript-files.ts';

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

/**
 * Counts the prompts a conversation took.
 *
 * @param path - Its transcript; one that does not exist holds none.
 */
export function countPrompts(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { type: string; message: { content: unknown } })
    .filter((entry) => entry.type === 'user' && typeof entry.message.content === 'string').length;
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
    recordInterruption: (marker) => record('user', [{ type: 'text', text: marker }]),
  };
}
