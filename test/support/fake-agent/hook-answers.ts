import type { ToolInput } from './hook-events.ts';

/** What the hooks of a tool call decided: to let it run, to refuse it, or nothing. */
export type Decision =
  | {
      readonly behavior: 'allow';
      /** The input the call runs with instead of its own, when the hook gives one. */
      readonly updatedInput: ToolInput | undefined;
    }
  | {
      readonly behavior: 'deny';
      /** Whether the refusal also interrupts the turn. */
      readonly interrupts: boolean;
      /** What the hook tells the model of its refusal, when it says anything. */
      readonly message: string | undefined;
    }
  | { readonly behavior: 'none' };

const NO_DECISION: Decision = { behavior: 'none' };

/** An answer, or a part of one, as an object of fields. */
type Fields = Readonly<Record<string, unknown>>;

/** Reads the decision in the `hookSpecificOutput` of an event's answer. */
type DecisionReader = (specific: Fields, refuse: Refuse) => Decision;

/** Makes the error of an answer that is not played. */
type Refuse = (answered: string) => Error;

/**
 * The events whose hooks may answer more than nothing, and how their
 * decision is read. An answer of any other event must be empty.
 */
const DECISION_READERS: Readonly<Record<string, DecisionReader>> = {
  PreToolUse: decisionBeforeTheCall,
  PermissionRequest: decisionOfTheAsk,
};

/**
 * Reads what the hooks of an event answered. Only what was observed of
 * Claude Code is read: no answer at all; for `PreToolUse`, an `allow`, with
 * an input or not; for `PermissionRequest`, an `allow`, with an input or
 * not, and a `deny`, which may interrupt the turn and whose message is what
 * the model is told.
 *
 * @param event - The event's name.
 * @param answers - Each hook's answer, as parsed JSON.
 * @returns The first decision among them, or `none`.
 * @throws `Error` naming the event and what it answered, for any answer
 * beyond those: a field, a value or a decision the fake agent does not
 * play. Reading it as no decision would let a test pass on a behavior
 * Claude Code may not have.
 */
export function decisionOf(event: string, answers: readonly unknown[]): Decision {
  const decisions = answers.map((answer) => decisionIn(event, answer));
  return decisions.find((decision) => decision.behavior !== 'none') ?? NO_DECISION;
}

function decisionIn(event: string, answer: unknown): Decision {
  const refuse: Refuse = (answered) =>
    new Error(`a ${event} hook answered ${answered}: the fake agent does not play it`);
  if (!isFields(answer)) throw refuse('what is no object');
  const { hookSpecificOutput: specific, ...others } = answer;
  refuseFields(others, [], refuse);
  if (specific === undefined) return NO_DECISION;
  const read = DECISION_READERS[event];
  if (read === undefined || !isFields(specific)) throw refuse('with "hookSpecificOutput"');
  const { hookEventName, ...decision } = specific;
  if (hookEventName !== undefined && hookEventName !== event) {
    throw refuse(`for the event ${JSON.stringify(hookEventName)}`);
  }
  return read(decision, refuse);
}

function decisionBeforeTheCall(specific: Fields, refuse: Refuse): Decision {
  refuseFields(specific, ['permissionDecision', 'updatedInput'], refuse);
  // A hook that only wants to know of the call names its event and decides nothing.
  if (Object.keys(specific).length === 0) return NO_DECISION;
  if (specific.permissionDecision !== 'allow') {
    throw refuse(JSON.stringify(specific.permissionDecision));
  }
  return { behavior: 'allow', updatedInput: specific.updatedInput as ToolInput | undefined };
}

function decisionOfTheAsk(specific: Fields, refuse: Refuse): Decision {
  refuseFields(specific, ['decision'], refuse);
  if (specific.decision === undefined) return NO_DECISION;
  if (!isFields(specific.decision)) throw refuse('with "decision"');
  const { behavior, ...more } = specific.decision;
  if (behavior === 'allow') {
    refuseFields(more, ['updatedInput'], refuse);
    return { behavior, updatedInput: more.updatedInput as ToolInput | undefined };
  }
  if (behavior === 'deny') {
    refuseFields(more, ['interrupt', 'message'], refuse);
    return {
      behavior,
      interrupts: more.interrupt === true,
      message: typeof more.message === 'string' ? more.message : undefined,
    };
  }
  throw refuse(String(JSON.stringify(behavior)));
}

function refuseFields(fields: Fields, played: readonly string[], refuse: Refuse): void {
  const unplayed = Object.keys(fields).find((name) => !played.includes(name));
  if (unplayed !== undefined) throw refuse(`with ${JSON.stringify(unplayed)}`);
}

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
