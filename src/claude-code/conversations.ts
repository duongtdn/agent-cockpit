import { access, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Gives the folder where Claude Code keeps its configuration and its
 * conversations: `CLAUDE_CONFIG_DIR`, else `.claude` in the agent's home
 * folder.
 *
 * @param environment - The environment the agent is launched with: a
 * launch's, which may differ from the server's.
 */
export function agentConfigFolder(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const configured = environment.CLAUDE_CONFIG_DIR;
  if (configured !== undefined && configured !== '') return configured;
  const home = environment.HOME;
  return join(home !== undefined && home !== '' ? home : homedir(), '.claude');
}

/** A conversation to look for, where Claude Code keeps it. */
export interface TranscriptLookup {
  /** The agent's configuration folder. */
  readonly configFolder: string;
  /** The conversation's id. */
  readonly conversationId: string;
  /** The folder the session works in, which Claude Code names a project folder after. */
  readonly directory: string;
}

/** Beyond this many characters, Claude Code cuts a project folder's name and adds a hash of the path. */
const LONGEST_PROJECT_NAME = 200;

/**
 * The waits between two searches of every project folder, while a
 * conversation's transcript is not found where its work folder's name puts
 * it: its last step repeats. A new conversation's transcript appears in
 * the work folder's own project folder, read at every round; the search
 * of every folder is for the rest (a resumed conversation that first ran
 * elsewhere, a name the driver cannot make), and costs one look in each.
 */
export const SEARCH_BACKOFF_MS: readonly number[] = [1000, 2000, 4000, 8000, 16_000, 30_000];

/**
 * Names the project folder Claude Code (2.1.332) keeps the conversations
 * of a work folder in: every character but a letter or a digit a dash.
 *
 * @param directory - The work folder, an absolute path.
 * @returns The folder's name; `undefined` for a name longer than 200
 * characters, which Claude Code cuts and ends with a hash of its own.
 */
export function projectFolderName(directory: string): string | undefined {
  const name = directory.replace(/[^a-zA-Z0-9]/g, '-');
  return name.length <= LONGEST_PROJECT_NAME ? name : undefined;
}

/**
 * Tells whether Claude Code keeps a conversation: its transcript exists.
 *
 * @param lookup - The conversation, and where to look.
 * @returns `true` when the transcript exists; `false` too when the agent
 * has no conversation at all.
 * @throws The error of a configuration folder that cannot be read.
 */
export async function keepsConversation(lookup: TranscriptLookup): Promise<boolean> {
  return (await findTranscript(lookup)) !== undefined;
}

/**
 * Finds a conversation's transcript, once. Claude Code keeps it in a
 * folder per project, named after the folder the conversation first ran in,
 * and `--resume` finds it from any folder: it is looked for in the work
 * folder's project folder, then in every one.
 *
 * @param lookup - The conversation, and where to look.
 * @returns The transcript's path; `undefined` while the agent has written none.
 * @throws The error of a configuration folder that cannot be read.
 */
export async function findTranscript(lookup: TranscriptLookup): Promise<string | undefined> {
  return (await inWorkFoldersProject(lookup)) ?? (await inAnyProject(lookup));
}

/**
 * Makes a search for a conversation's transcript that is cheap to repeat,
 * for a watch that looks for it until it appears: each call looks in the
 * work folder's project folder, and in every project folder only on the
 * first call and then after each wait of {@link SEARCH_BACKOFF_MS}.
 *
 * @param lookup - The conversation, and where to look.
 * @param clock - Gives the time in milliseconds: `Date.now` by default.
 * @returns The search: each call gives the transcript's path, or
 * `undefined` while it is not found.
 */
export function transcriptSearch(
  lookup: TranscriptLookup,
  clock: () => number = Date.now,
): () => Promise<string | undefined> {
  let searches = 0;
  let nextSearchAt = clock();
  return async () => {
    const found = await inWorkFoldersProject(lookup);
    if (found !== undefined || clock() < nextSearchAt) return found;
    const wait = SEARCH_BACKOFF_MS[Math.min(searches, SEARCH_BACKOFF_MS.length - 1)] as number;
    searches += 1;
    nextSearchAt = clock() + wait;
    return inAnyProject(lookup);
  };
}

/** Looks in the project folders named after the work folder, as given and as its real path. */
async function inWorkFoldersProject(lookup: TranscriptLookup): Promise<string | undefined> {
  const real = await realpath(lookup.directory).catch(() => lookup.directory);
  const names = new Set([projectFolderName(lookup.directory), projectFolderName(real)]);
  return firstExisting(
    [...names]
      .filter((name) => name !== undefined)
      .map((name) => transcriptIn(lookup, join(lookup.configFolder, 'projects', name))),
  );
}

async function inAnyProject(lookup: TranscriptLookup): Promise<string | undefined> {
  const projects = join(lookup.configFolder, 'projects');
  const folders = await readdir(projects, { withFileTypes: true }).catch(nothingWhenAbsent);
  return firstExisting(
    folders
      .filter((folder) => folder.isDirectory())
      .map((folder) => transcriptIn(lookup, join(projects, folder.name))),
  );
}

function transcriptIn(lookup: TranscriptLookup, project: string): string {
  return join(project, `${lookup.conversationId}.jsonl`);
}

async function firstExisting(paths: readonly string[]): Promise<string | undefined> {
  const found = await Promise.all(paths.map(exists));
  return paths[found.indexOf(true)];
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
