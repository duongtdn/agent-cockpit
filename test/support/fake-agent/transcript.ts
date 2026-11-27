import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PROJECTS_FOLDER } from '../transcript-files.ts';

/**
 * Names the transcript of a conversation, where Claude Code keeps it and
 * the driver looks for it.
 *
 * @param configFolder - The agent's configuration folder.
 * @param cwd - The folder the conversation first ran in.
 * @param sessionId - The conversation's id.
 * @returns The file's path: in the project folder named after `cwd`, every
 * character but a letter or a digit a dash.
 */
export function transcriptPathFor(configFolder: string, cwd: string, sessionId: string): string {
  return join(
    configFolder,
    PROJECTS_FOLDER,
    cwd.replace(/[^a-zA-Z0-9]/g, '-'),
    `${sessionId}.jsonl`,
  );
}

/** The file a conversation is written to, an entry a line. */
export interface Transcript {
  /** Records a prompt that was taken. */
  recordPrompt(prompt: string): void;
  /** Records a text the agent answered. */
  recordReply(text: string): void;
}

/**
 * Opens a conversation's transcript for writing. The file appears with its
 * first entry, as Claude Code's does with the first prompt: a conversation
 * that took one is kept, and can be resumed.
 *
 * @param path - The file's path.
 * @param sessionId - The conversation's id, which each entry carries.
 */
export function openTranscript(path: string, sessionId: string): Transcript {
  function record(type: 'user' | 'assistant', content: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const entry = {
      type,
      sessionId,
      timestamp: new Date().toISOString(),
      message: { role: type, content },
    };
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
  }

  return {
    recordPrompt: (prompt) => record('user', prompt),
    recordReply: (text) => record('assistant', [{ type: 'text', text }]),
  };
}
