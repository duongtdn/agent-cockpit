import { z } from 'zod';
import type { Ask, AskAnswer } from '../../shared/ask.js';
import type { Issue } from '../../shared/cockpit-error.js';
import { issuesOf } from '../jobs.js';
import { lengthOverPromptBound, MAX_PROMPT_LENGTH } from '../prompt-length.js';

/**
 * A denial's message: non-empty, and at most the prompt's bound, counted as
 * the prompt's is, in code points (whatever zod's own `max` counts), since it
 * reaches the model as text.
 */
const MESSAGE = z
  .string()
  .min(1)
  .refine((message) => lengthOverPromptBound(message) === undefined, {
    error: `Expected at most ${MAX_PROMPT_LENGTH} characters.`,
  });

/**
 * A field given as `undefined` taken as absent, and left out: an app built
 * without `exactOptionalPropertyTypes` may write one, which JSON would drop
 * on the wire anyway.
 */
function withoutUndefinedFields(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
}

/**
 * Each kind's answer, as the app may give it. Every shape is strict: a field
 * of another kind's answer is refused rather than dropped, so that an answer
 * meant for another ask never reaches the agent as half of one. A field of
 * the other branch is named, so that its issue points at it.
 */
const ANSWER_SHAPES: { readonly [Kind in Ask['kind']]: z.ZodType<AskAnswer> } = {
  permission: z.preprocess(
    withoutUndefinedFields,
    z.discriminatedUnion('allow', [
      z.strictObject({
        allow: z.literal(true),
        remember: z.literal('session').exactOptional(),
        message: z.never({ error: 'An allow carries no message.' }).exactOptional(),
      }),
      z.strictObject({
        allow: z.literal(false),
        remember: z.never({ error: 'A denial cannot be remembered.' }).exactOptional(),
        message: MESSAGE.exactOptional(),
      }),
    ]),
  ),
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
