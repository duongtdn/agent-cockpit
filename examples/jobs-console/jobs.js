// The jobs console's jobs: what the page draws a launcher form for. Each
// shows one thing a job can be: choices that depend on an earlier field
// (Explain, Review), a job part that changes the session's settings on the
// same key (Review), a job with no prompt that works in a folder of its own
// (Work in a folder), and suggestions that take any value (Ask anything).

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeCode } from '@duongtdn/agent-cockpit/claude-code';
import { z } from 'zod';

/** The value of the folder field that names the app's folder itself. */
const APP_FOLDER = '.';

/** Folders never offered: the app's tooling, not its work. */
const HIDDEN_FOLDERS = new Set(['node_modules', 'dist', 'coverage']);

/** What "Ask anything" suggests: any other topic is taken too. */
const TOPICS = ['the project', 'the notes', 'the code'];

/**
 * The app's jobs, over its folder: the folders and files they offer are
 * read from it at each call, so a file added shows at the next choice.
 *
 * @param appFolder - The app's folder: the cockpit's `directory`.
 * @returns The jobs, in the order the page shows them.
 */
export function jobsOf(appFolder) {
  const folders = () => folderChoices(appFolder);
  const files = ({ folder }) => fileChoices(appFolder, folder);
  const fileArgs = z.object({
    folder: z.string().meta({ label: 'Folder' }),
    file: z.string().meta({ label: 'File', hint: 'One of the folder’s files.' }),
    detail: z.enum(['brief', 'thorough']).default('brief').meta({ label: 'Detail' }),
  });
  // Explain and Review share their key: a file is one unit of work, whichever job runs on it.
  const fileKey = ({ folder, file }) => `file-${keyPart(join(folder, file))}`;
  const length = (detail) => (detail === 'brief' ? 'in a few sentences' : 'thoroughly');
  return [
    {
      id: 'explain',
      title: 'Explain a file',
      description: 'Pick a folder, then one of its files.',
      args: fileArgs,
      options: { folder: folders, file: files },
      key: fileKey,
      prompt: ({ folder, file, detail }) =>
        `Explain the file ${join(folder, file)} ${length(detail)}.`,
    },
    {
      id: 'review',
      title: 'Review a file',
      description:
        'The same unit of work as Explain, in plan mode: on a session Explain started, it restarts it with plan mode and resumes its conversation.',
      args: fileArgs,
      options: { folder: folders, file: files },
      key: fileKey,
      prompt: ({ folder, file, detail }) =>
        `Review the file ${join(folder, file)} ${length(detail)}: what would you change?`,
      driver: claudeCode.job({ permissionMode: 'plan' }),
    },
    {
      id: 'work',
      title: 'Work in a folder',
      description: 'No prompt: the agent starts in the folder, and you type in its terminal.',
      args: z.object({ folder: z.string().meta({ label: 'Folder' }) }),
      options: { folder: folders },
      key: ({ folder }) => `folder-${keyPart(folder)}`,
      directory: ({ folder }) => folder,
    },
    {
      id: 'ask',
      title: 'Ask anything',
      description: 'A topic of your own, or one suggested; each topic is a session.',
      args: z.object({
        topic: z
          .string()
          .regex(/[A-Za-z0-9]/, 'Name a topic: at least one letter or digit.')
          .meta({ label: 'Topic' }),
        question: z.string().min(1, 'Ask a question.').meta({ label: 'Question' }),
      }),
      options: { topic: { choices: () => TOPICS.map((value) => ({ value })), suggestions: true } },
      key: ({ topic }) => `ask-${keyPart(topic)}`,
      prompt: ({ topic, question }) => `About ${topic}: ${question}`,
    },
  ];
}

/** The app's folder and its folders, the hidden ones left out. */
async function folderChoices(appFolder) {
  const entries = await readdir(appFolder, { withFileTypes: true });
  const folders = entries
    .filter((entry) => entry.isDirectory() && isShown(entry.name))
    .map((entry) => entry.name)
    .sort();
  return [
    { value: APP_FOLDER, label: 'The app’s folder' },
    ...folders.map((name) => ({ value: name })),
  ];
}

/**
 * The files of one of the folders offered. A folder given is checked
 * against them first: the arguments so far come from the page, and a
 * source must not list what lies elsewhere.
 */
async function fileChoices(appFolder, folder) {
  const offered = await folderChoices(appFolder);
  if (!offered.some((choice) => choice.value === folder)) return [];
  const entries = await readdir(join(appFolder, folder), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && isShown(entry.name))
    .map((entry) => ({ value: entry.name }))
    .sort((a, b) => a.value.localeCompare(b.value));
}

function isShown(name) {
  return !name.startsWith('.') && !HIDDEN_FOLDERS.has(name);
}

/**
 * A name as a part of a key, which holds only `a`–`z`, `0`–`9` and `-`:
 * lower-case letters and digits as they are, every other character as its
 * code point in hex between two `-` (`src/greet.js` → `src-2f-greet-2e-js`).
 * The part reads back to the name, so two names never share a key — where a
 * slug would merge `a-b.js` with `a.b.js`, `README.md` with `readme.md`, or
 * the app's folder `.` with a folder named `app`, and two files would be one
 * unit of work.
 */
function keyPart(name) {
  return [...name]
    .map((character) =>
      /[a-z0-9]/.test(character) ? character : `-${character.codePointAt(0).toString(16)}-`,
    )
    .join('');
}
