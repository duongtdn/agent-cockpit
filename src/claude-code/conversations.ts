import { access, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Gives the folder where Claude Code keeps its configuration and its
 * conversations: `CLAUDE_CONFIG_DIR`, else `.claude` in the home folder.
 *
 * @param environment - The environment the agents are launched from: the
 * server's, as the core passes it on.
 */
export function agentConfigFolder(environment: NodeJS.ProcessEnv): string {
  const configured = environment.CLAUDE_CONFIG_DIR;
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.claude');
}

/**
 * Tells whether Claude Code keeps a conversation: its transcript exists. It
 * keeps one in a folder per project, named after the folder the
 * conversation first ran in, and `--resume` finds it from any folder; so
 * is it looked for in every project's.
 *
 * @param configFolder - The agent's configuration folder.
 * @param conversationId - The conversation's id.
 * @returns `true` when the transcript exists; `false` too when the agent
 * has no conversation at all.
 */
export async function keepsConversation(
  configFolder: string,
  conversationId: string,
): Promise<boolean> {
  const projects = join(configFolder, 'projects');
  const folders = await readdir(projects, { withFileTypes: true }).catch(nothingWhenAbsent);
  const found = await Promise.all(
    folders
      .filter((folder) => folder.isDirectory())
      .map((folder) => exists(join(projects, folder.name, `${conversationId}.jsonl`))),
  );
  return found.includes(true);
}

function nothingWhenAbsent(error: NodeJS.ErrnoException): never[] {
  if (error.code === 'ENOENT') return [];
  throw error;
}

function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
