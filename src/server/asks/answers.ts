import { z } from 'zod';
import type { Ask, AskAnswer } from '../../shared/ask.js';
import type { Issue } from '../../shared/cockpit-error.js';
import { issuesOf } from '../jobs.js';

/** The longest message a denial may carry: the prompt's bound, since it reaches the model as text. */
const MAX_MESSAGE_LENGTH = 100_000;

/**
 * Each kind's answer, as the app may give it. Every shape is strict: a field
 * of another kind's answer is refused rather than dropped, so that an answer
 * meant for another ask never reaches the agent as half of one.
 */
const ANSWER_SHAPES: { readonly [Kind in Ask['kind']]: z.ZodType<AskAnswer> } = {
  permission: z.discriminatedUnion('allow', [
    z.strictObject({ allow: z.literal(true), remember: z.literal('session').exactOptional() }),
    z.strictObject({
      allow: z.literal(false),
      message: z.string().min(1).max(MAX_MESSAGE_LENGTH).exactOptional(),
    }),
  ]),
};

/** An answer checked against its ask's kind: the answer it fits as, or each way it does not fit. */
export type AnswerCheck = { readonly answer: AskAnswer } | { readonly issues: readonly Issue[] };

/**
 * Checks an answer the app gave against the shape its ask's kind takes.
 *
 * @param kind - The ask's kind.
 * @param answer - The answer as given: any value, a parsed body among them.
 * @returns The answer, when it fits; else its issues, each with a path and
 * zod's message.
 */
export function checkAnswer(kind: Ask['kind'], answer: unknown): AnswerCheck {
  const parsed = ANSWER_SHAPES[kind].safeParse(answer);
  return parsed.success ? { answer: parsed.data } : { issues: issuesOf(parsed.error.issues) };
}
