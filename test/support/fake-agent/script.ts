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

/**
 * End the turn on an error of the API, as the agent does once its retries
 * are spent: the API answers the status (with the scripted API's own
 * message for it).
 */
export interface FailStep {
  readonly do: 'fail';
  /** The HTTP status the API answers. */
  readonly status: number;
}

/** Compact the conversation, on the person's `/compact`: the turn of that command, alone in it. */
export interface CompactStep {
  readonly do: 'compact';
  /** The summary the model writes, which the conversation goes on from. */
  readonly summary: string;
}

/**
 * Start a subagent in the background with the `Agent` tool, and go on with
 * the turn. Once the turn ended (and the test let tasks run), the subagent
 * does its work, and its end starts the session's next turn by itself: a
 * `<task-notification>` prompt, which the script's next turn answers.
 */
export interface TaskStep {
  readonly do: 'task';
  /** The task's short description, as the `Agent` call gives it. */
  readonly description: string;
  /** The subagent's prompt. */
  readonly prompt: string;
  /** The subagent's type, such as `general-purpose`. */
  readonly agentType: string;
  /** What the subagent does: tool calls that need no ask, then the reply it ends with. */
  readonly work: readonly (ToolStep | ReplyStep)[];
}

/**
 * One thing the agent does in a turn. `stay-busy` works until interrupted;
 * `exit` ends the session; `fail` ends the turn on an error.
 */
export type Step =
  | ReplyStep
  | ToolStep
  | QuestionStep
  | FailStep
  | CompactStep
  | TaskStep
  | { readonly do: 'stay-busy' }
  | { readonly do: 'exit' };

/** What the agent does with one prompt: steps, the last of which ends the turn. */
export type Turn = readonly Step[];

const ENDING_STEPS: readonly string[] = ['reply', 'stay-busy', 'exit', 'fail', 'compact'];

/**
 * Reads a script: a JSON list of turns, each a list of steps.
 *
 * @param text - The script file's content.
 * @returns The turns, in the order of the prompts they answer.
 * @throws `SyntaxError` for what is no JSON; `Error`, naming the turn and the
 * step, for a step the fake agent cannot play, an empty turn, a turn that
 * does not end with `reply`, `stay-busy`, `exit`, `fail` or `compact`, a step
 * after one of those, and a `compact` with another step in its turn.
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
  if (end === -1)
    throw new Error(`${name} must end with a reply, stay-busy, exit, fail or compact`);
  if (end < steps.length - 1) throw new Error(`${name} goes on after step ${end + 1}`);
  if (steps.length > 1 && steps.some((step) => step.do === 'compact')) {
    throw new Error(`${name} compacts: a compaction is a turn of its own`);
  }
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
    case 'fail':
      return Number.isInteger(candidate.status);
    case 'compact':
      return typeof candidate.summary === 'string';
    case 'task':
      return isTask(candidate);
    case 'stay-busy':
    case 'exit':
      return true;
    default:
      return false;
  }
}

/** A task's work is tool calls, then the reply it ends with. */
function isTask(candidate: Record<string, unknown>): boolean {
  const { description, prompt, agentType, work } = candidate;
  if (![description, prompt, agentType].every((field) => typeof field === 'string')) return false;
  if (!Array.isArray(work) || work.length === 0) return false;
  const steps = work as unknown[];
  const last = steps.at(-1) as Record<string, unknown>;
  return (
    last?.do === 'reply' &&
    isStep(last) &&
    steps
      .slice(0, -1)
      .every((step) => (step as Record<string, unknown>)?.do === 'tool' && isStep(step))
  );
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
