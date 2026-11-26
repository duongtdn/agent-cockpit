import { CockpitError } from '../shared/cockpit-error.js';

/**
 * The longest prompt the cockpit takes, in characters (code points), for a
 * run and a send alike, at launch or typed: typing one takes about a second
 * per 4,000 characters.
 */
export const MAX_PROMPT_LENGTH = 100_000;

/**
 * Refuses a prompt longer than {@link MAX_PROMPT_LENGTH}, before anything is
 * launched or typed.
 *
 * @param prompt - The prompt.
 * @throws `CockpitError` `prompt-too-long`, with its length and the limit.
 */
export function refuseTooLongPrompt(prompt: string): void {
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
