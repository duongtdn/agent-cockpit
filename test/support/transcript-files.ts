import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** The folder of an agent's configuration folder that holds the conversations, a folder a project. */
export const PROJECTS_FOLDER = 'projects';

/**
 * Finds the transcript of a conversation, whatever folder it ran in: an
 * agent, real or fake, keeps it in the project folder named after the folder
 * the conversation first ran in.
 *
 * @param configFolder - The agent's configuration folder.
 * @param sessionId - The conversation's id.
 * @returns The file's path, or `undefined` when the conversation recorded nothing.
 */
export function findTranscript(configFolder: string, sessionId: string): string | undefined {
  const projects = join(configFolder, PROJECTS_FOLDER);
  if (!existsSync(projects)) return undefined;
  return readdirSync(projects)
    .map((project) => join(projects, project, `${sessionId}.jsonl`))
    .find((path) => existsSync(path));
}
