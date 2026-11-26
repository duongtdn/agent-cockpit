import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolInput } from './hook-events.ts';

/** The file of a session's folder that scripts the fake agent in it. */
export const SCRIPT_FILE_NAME = '.fake-agent-script.json';

/** A question the agent asks, as the `AskUserQuestion` tool takes it. */
export interface Question {
  readonly question: string;
  readonly header: string;
  readonly options: readonly { readonly label: string; readonly description: string }[];
  readonly multiSelect: boolean;
}

/** Answer with a text and end the turn. */
export interface ReplyStep {
  readonly do: 'reply';
  readonly text: string;
}

/** Call a tool that needs permission. */
export interface ToolStep {
  readonly do: 'tool';
  /** The tool's name. */
  readonly name: string;
  /** What the tool is called with. */
  readonly input: ToolInput;
  /** What the tool answers when it runs; an empty object when left out. */
  readonly response?: unknown;
  /**
   * What the model is told of the call once it ran, which `PostToolBatch`
   * hooks are told too: a call that runs with such a hook needs it.
   */
  readonly result?: string;
}

/** Ask the person questions. */
export interface QuestionStep {
  readonly do: 'question';
  readonly questions: readonly Question[];
}

/** One thing the agent does in a turn. `stay-busy` works until interrupted; `exit` ends the session. */
export type Step =
  | ReplyStep
  | ToolStep
  | QuestionStep
  | { readonly do: 'stay-busy' }
  | { readonly do: 'exit' };

/** What the agent does with one prompt: steps, the last of which ends the turn. */
export type Turn = readonly Step[];

const ENDING_STEPS: readonly string[] = ['reply', 'stay-busy', 'exit'];

/**
 * Reads a script: a JSON list of turns, each a list of steps.
 *
 * @param text - The script file's content.
 * @returns The turns, in the order of the prompts they answer.
 * @throws `SyntaxError` for what is no JSON; `Error`, naming the turn and the
 * step, for a step the fake agent cannot play, an empty turn, a turn that
 * does not end with `reply`, `stay-busy` or `exit`, and a step after one of those.
 */
export function parseScript(text: string): Turn[] {
  const turns: unknown = JSON.parse(text);
  if (!Array.isArray(turns)) throw new Error('a script is a list of turns');
  return turns.map((turn, index) => readTurn(turn, `turn ${index + 1}`));
}

function readTurn(turn: unknown, name: string): Turn {
  if (!Array.isArray(turn)) throw new Error(`${name} is no list of steps`);
  if (turn.length === 0) throw new Error(`${name} has no step`);
  turn.forEach((step, index) => {
    if (!isStep(step)) throw new Error(`${name}, step ${index + 1} cannot be played`);
  });
  const steps = turn as Step[];
  const end = steps.findIndex((step) => ENDING_STEPS.includes(step.do));
  if (end === -1) throw new Error(`${name} must end with a reply, stay-busy or exit`);
  if (end < steps.length - 1) throw new Error(`${name} goes on after step ${end + 1}`);
  return steps;
}

function isStep(step: unknown): step is Step {
  const candidate = (step ?? {}) as Record<string, unknown>;
  switch (candidate.do) {
    case 'reply':
      return typeof candidate.text === 'string';
    case 'tool':
      return (
        typeof candidate.name === 'string' &&
        isObject(candidate.input) &&
        ['string', 'undefined'].includes(typeof candidate.result)
      );
    case 'question':
      return Array.isArray(candidate.questions);
    case 'stay-busy':
    case 'exit':
      return true;
    default:
      return false;
  }
}

function isObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Gives the turn that answers a prompt.
 *
 * @param turns - The script.
 * @param index - The prompt's place in the conversation, from zero.
 * @returns Its turn.
 * @throws `Error` for a prompt beyond the script: what the agent would
 * answer is the test's to say, never the fake agent's to invent.
 */
export function turnAt(turns: readonly Turn[], index: number): Turn {
  const turn = turns[index];
  if (turn === undefined) {
    const held = `${turns.length} ${turns.length === 1 ? 'turn' : 'turns'}`;
    throw new Error(`the script has no turn for prompt ${index + 1}: it holds ${held}`);
  }
  return turn;
}

/**
 * Writes the script of the sessions that run in a folder, for a test.
 *
 * @param folder - The sessions' working folder; it must exist.
 * @param turns - The turns, in the order of the prompts they answer.
 */
export function writeScript(folder: string, turns: readonly Turn[]): void {
  writeFileSync(join(folder, SCRIPT_FILE_NAME), JSON.stringify(turns, null, 2));
}

/**
 * Reads the script of the sessions that run in a folder, as it is now.
 *
 * @returns The turns; none when the folder has no script.
 * @throws What {@link parseScript} throws.
 */
export function readScript(folder: string): Turn[] {
  const path = join(folder, SCRIPT_FILE_NAME);
  return existsSync(path) ? parseScript(readFileSync(path, 'utf8')) : [];
}
