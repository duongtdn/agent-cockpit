import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The file of a session's folder that scripts the fake agent in it. */
export const SCRIPT_FILE_NAME = '.fake-agent-script.json';

/** The file of a session's folder that lets a held fake agent go on. */
export const RELEASE_FILE_NAME = '.fake-agent-release';

/**
 * Take the launch's prompt and answer it: `UserPromptSubmit` with the
 * prompt, then `Stop` with the reply.
 */
export interface TurnStep {
  readonly do: 'turn';
  /** The reply, the turn's last message. */
  readonly reply: string;
}

/** Take the launch's prompt, then work on it until killed: `UserPromptSubmit`, then nothing. */
export interface StayBusyStep {
  readonly do: 'stay-busy';
}

/** Wait until the test releases the agent ({@link release}), as a person who has not typed yet. */
export interface HoldStep {
  readonly do: 'hold';
}

/** Exit by itself, as on the person's `/exit`: `SessionEnd`, then status 0. */
export interface ExitStep {
  readonly do: 'exit';
}

/** One thing the fake agent does, in the order of its script. */
export type Step = TurnStep | StayBusyStep | HoldStep | ExitStep;

/** The steps that take the launch's prompt: one at most, the first, and only with a prompt. */
const PROMPT_TAKING: readonly string[] = ['turn', 'stay-busy'];

/** The steps after which nothing more comes. */
const LAST: readonly string[] = ['stay-busy', 'exit'];

/**
 * Reads a script: a JSON list of steps.
 *
 * @param text - The script file's content.
 * @param prompt - The launch's prompt; none for a launch with no prompt.
 * @returns The steps, in order.
 * @throws `SyntaxError` for what is no JSON; `Error`, naming the step, for
 * a step the fake agent does not play, a step that takes a prompt the
 * launch did not give or that is not the first, a launch's prompt no step
 * takes, and a step after `stay-busy` or `exit`. The fake agent has no
 * input box: the only prompt it takes is its launch's.
 */
export function parseScript(text: string, prompt: string | undefined): Step[] {
  const steps: unknown = JSON.parse(text);
  if (!Array.isArray(steps)) throw new Error('a script is a list of steps');
  steps.forEach((step, index) => {
    if (!isStep(step)) throw new Error(`step ${index + 1} cannot be played`);
  });
  const checked = steps as Step[];
  checkPromptTaking(checked, prompt);
  const last = checked.findIndex((step) => LAST.includes(step.do));
  if (last !== -1 && last < checked.length - 1) {
    throw new Error(
      `the script goes on after step ${last + 1}: nothing comes after ${checked[last]?.do}`,
    );
  }
  return checked;
}

function checkPromptTaking(steps: readonly Step[], prompt: string | undefined): void {
  const taking = steps.flatMap((step, index) => (PROMPT_TAKING.includes(step.do) ? [index] : []));
  const [first, second] = taking;
  if (second !== undefined || (first !== undefined && first !== 0)) {
    throw new Error(
      `step ${(second ?? first ?? 0) + 1} takes a prompt: only the first step can, the launch's`,
    );
  }
  if (first !== undefined && prompt === undefined) {
    throw new Error('step 1 takes a prompt, and the launch gave none');
  }
  if (first === undefined && prompt !== undefined) {
    throw new Error(
      "the launch gave a prompt, and no step takes it: what the agent does is the script's to say",
    );
  }
}

function isStep(step: unknown): step is Step {
  const candidate = (step ?? {}) as Record<string, unknown>;
  switch (candidate.do) {
    case 'turn':
      return typeof candidate.reply === 'string';
    case 'stay-busy':
    case 'hold':
    case 'exit':
      return Object.keys(candidate).length === 1;
    default:
      return false;
  }
}

/**
 * Writes the script of the fake agents that run in a folder, for a test.
 *
 * @param folder - The sessions' working folder; it must exist.
 * @param steps - The steps, in order.
 */
export function writeScript(folder: string, steps: readonly Step[]): void {
  writeFileSync(join(folder, SCRIPT_FILE_NAME), JSON.stringify(steps, null, 2));
}

/**
 * Reads the script of the fake agents that run in a folder.
 *
 * @param folder - The session's working folder.
 * @param prompt - The launch's prompt, if any.
 * @returns The steps; none when the folder has no script.
 * @throws What {@link parseScript} throws.
 */
export function readScript(folder: string, prompt: string | undefined): Step[] {
  const path = join(folder, SCRIPT_FILE_NAME);
  return existsSync(path)
    ? parseScript(readFileSync(path, 'utf8'), prompt)
    : parseScript('[]', prompt);
}

/**
 * Lets the fake agents held in a folder go on past their `hold`.
 *
 * @param folder - The sessions' working folder.
 */
export function release(folder: string): void {
  writeFileSync(join(folder, RELEASE_FILE_NAME), '');
}

/**
 * Tells whether the agents of a folder were released, and takes the
 * release: the next `hold` waits for one of its own.
 *
 * @param folder - The session's working folder.
 */
export function takeRelease(folder: string): boolean {
  const path = join(folder, RELEASE_FILE_NAME);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}
