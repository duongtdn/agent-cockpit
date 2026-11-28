import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The file of a session's folder that scripts the fake agent in it. */
export const SCRIPT_FILE_NAME = '.fake-agent-script.json';

/**
 * The file of a session's folder that lets a held fake agent go on: empty
 * past a `hold`, or naming what the person does in the terminal on an ask.
 */
export const RELEASE_FILE_NAME = '.fake-agent-release';

/**
 * A call a turn asks the person for: `PreToolUse`, then `PermissionRequest`
 * held until it is answered. A decision on the hook settles it: `allow`
 * fires `PostToolUse`; `deny` goes on, or with `interrupt` ends the turn as
 * an interruption does. A reply with no decision leaves it to the terminal,
 * where the test answers it ({@link answerInTerminal}).
 */
export interface AskedCall {
  /** The tool's name, such as `Bash`: one the contract suite recorded asked. */
  readonly tool: string;
  /** The call's input, put into each payload in place of the recorded one. */
  readonly input: Readonly<Record<string, unknown>>;
}

/**
 * What the person does in the terminal on an ask, in place of the hook's
 * answer, as the real agent tells it: `esc` (Esc, or a plain "No") closes the
 * held connection and interrupts the turn; `yes` runs the call
 * (`PostToolUse`), the connection left open; `amended-no` ("No" with a text)
 * refuses the call (`PostToolBatch` of a refused call), the connection left
 * open and the turn going on.
 */
export type TerminalAnswer = 'esc' | 'yes' | 'amended-no';

const TERMINAL_ANSWERS: readonly string[] = ['esc', 'yes', 'amended-no'] satisfies TerminalAnswer[];

/**
 * Take the launch's prompt and answer it: `UserPromptSubmit` with the
 * prompt, each ask in order, then `Stop` with the reply. An ask that ends
 * the turn as an interruption leaves the rest of it unplayed, `Stop` too.
 */
export interface TurnStep {
  readonly do: 'turn';
  /** The reply, the turn's last message. */
  readonly reply: string;
  /** The calls it asks for on the way; none by default. */
  readonly asks?: readonly AskedCall[];
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
      return (
        hasOnly(candidate, ['do', 'reply', 'asks']) &&
        typeof candidate.reply === 'string' &&
        (candidate.asks === undefined ||
          (Array.isArray(candidate.asks) && candidate.asks.every(isAskedCall)))
      );
    case 'stay-busy':
    case 'hold':
    case 'exit':
      return Object.keys(candidate).length === 1;
    default:
      return false;
  }
}

function isAskedCall(call: unknown): call is AskedCall {
  const candidate = (call ?? {}) as Record<string, unknown>;
  return (
    hasOnly(candidate, ['tool', 'input']) &&
    typeof candidate.tool === 'string' &&
    isRecord(candidate.input)
  );
}

function hasOnly(candidate: Readonly<Record<string, unknown>>, fields: readonly string[]): boolean {
  return Object.keys(candidate).every((field) => fields.includes(field));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  writeRelease(folder, '');
}

/**
 * Answers the ask the fake agents of a folder hold, as the person would in
 * the terminal.
 *
 * @param folder - The sessions' working folder.
 * @param answer - What the person does.
 */
export function answerInTerminal(folder: string, answer: TerminalAnswer): void {
  writeRelease(folder, answer);
}

/** Writes the release file whole at once: an agent never reads it half written, an answer as empty. */
function writeRelease(folder: string, content: string): void {
  const path = join(folder, RELEASE_FILE_NAME);
  writeFileSync(`${path}.writing`, content);
  renameSync(`${path}.writing`, path);
}

/**
 * Tells whether the agents of a folder were released past a `hold`, and
 * takes the release: the next `hold` waits for one of its own. An answer
 * to an ask is left for the ask.
 *
 * @param folder - The session's working folder.
 */
export function takeRelease(folder: string): boolean {
  return takeReleaseFile(folder, (content) => content === '') !== undefined;
}

/**
 * Gives the person's answer in the terminal to the ask of an agent of a
 * folder, if the test gave one, and takes it. A release past a `hold` is
 * left for the `hold`.
 *
 * @param folder - The session's working folder.
 * @returns The answer; none while the test gave none.
 */
export function takeTerminalAnswer(folder: string): TerminalAnswer | undefined {
  return takeReleaseFile(folder, (content) => TERMINAL_ANSWERS.includes(content)) as
    | TerminalAnswer
    | undefined;
}

/** Reads a file that may not be there, or that another agent of the folder may take meanwhile. */
function contentOf(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Takes the release file when its content is of the kind asked for, and gives that content. */
function takeReleaseFile(
  folder: string,
  isOfKind: (content: string) => boolean,
): string | undefined {
  const path = join(folder, RELEASE_FILE_NAME);
  const content = contentOf(path);
  if (content === undefined || !isOfKind(content)) return undefined;
  rmSync(path, { force: true });
  return content;
}
