// The jobs of "Asks on the page": each has the agent create an empty file
// with `touch`, a command it asks the person's permission for. The first
// runs in the agent's default mode, where the cockpit offers the ask to
// the page; the second in plan mode, where the agent asks in its terminal
// alone, and the page can only show where to answer.

import { claudeCode } from '@duongtdn/agent-cockpit/claude-code';
import { z } from 'zod';

/** A plain file name in the work folder: no folder, no hidden file, nothing the shell reads as its own. */
const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

const args = z.object({
  file: z
    .string()
    .regex(FILE_NAME, 'A plain file name: letters, digits, _, . and -, not starting with a dot.')
    .meta({ label: 'File' }),
});

/** The prompt of both jobs: the scripted agent calls exactly this command. */
const prompt = ({ file }) => `Create the empty file ${file}: run \`touch ${file}\`, nothing else.`;

/**
 * The app's jobs. Each is one session, whatever the file: a run on it once
 * it is idle sends the next prompt to the same session, so that an answer
 * remembered for the session shows on the next file.
 *
 * @returns The jobs, in the order the page offers them.
 */
export function jobsOf() {
  return [
    {
      id: 'create',
      title: 'Create a file',
      description: 'The agent asks to run `touch`; the page answers.',
      args,
      key: () => 'create',
      prompt,
    },
    {
      id: 'create-in-plan',
      title: 'Create a file in plan mode',
      description:
        'In plan mode the agent asks in its terminal alone: the page shows the ask and where to answer it.',
      args,
      key: () => 'plan',
      prompt,
      driver: claudeCode.job({ permissionMode: 'plan' }),
    },
  ];
}
