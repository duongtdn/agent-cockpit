import { CockpitError } from '../shared/cockpit-error.js';

/**
 * The longest prompt the cockpit takes, in characters (code points), for a
 * run and a send alike, at launch or typed: typing one takes about a second
 * per 4,000 characters.
 */
export const MAX_PROMPT_LENGTH = 100_000;

/** A prompt of whitespace and U+2063 alone, all of which the agent trims off its ends. */
const BLANK = /^[\s\u2063]*$/u;

/**
 * Refuses a prompt the cockpit does not take, before anything is launched
 * or typed: one empty or only whitespace, which the agent trims to nothing
 * and would never take, and one longer than {@link MAX_PROMPT_LENGTH}.
 *
 * @param prompt - The prompt.
 * @throws `CockpitError` `invalid-arguments`, its issue at `prompt`, for a
 * blank prompt; `prompt-too-long`, with its length and the limit.
 */
export function refuseUnfitPrompt(prompt: string): void {
  if (BLANK.test(prompt)) {
    throw new CockpitError('invalid-arguments', 'The prompt is empty.', {
      issues: [{ path: ['prompt'], message: 'Expected a prompt with more than whitespace.' }],
    });
  }
  // Counted only past the limit's worth of UTF-16 units: no shorter text can be over it.
  if (prompt.length <= MAX_PROMPT_LENGTH) return;
  const length = [...prompt].length;
  if (length <= MAX_PROMPT_LENGTH) return;
  throw new CockpitError(
    'prompt-too-long',
    `The prompt is ${length} characters; the cockpit takes at most ${MAX_PROMPT_LENGTH}.`,
    { length, max: MAX_PROMPT_LENGTH },
  );
}
