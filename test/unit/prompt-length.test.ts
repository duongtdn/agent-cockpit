import { describe, expect, it } from 'vitest';
import { MAX_PROMPT_LENGTH, refuseTooLongPrompt } from '../../src/server/prompt-length.ts';
import { isCockpitError } from '../../src/shared/cockpit-error.ts';

/** What the check threw; fails the test when it threw nothing. */
function refusal(prompt: string): unknown {
  try {
    refuseTooLongPrompt(prompt);
  } catch (error) {
    return error;
  }
  return expect.fail('The prompt was taken.');
}

describe("a prompt's length", () => {
  it('is at most 100,000 characters', () => {
    expect(MAX_PROMPT_LENGTH).toBe(100_000);
    expect(() => refuseTooLongPrompt('a'.repeat(MAX_PROMPT_LENGTH))).not.toThrow();
  });

  it('refuses a longer one with prompt-too-long, its length and the limit', () => {
    const error = refusal('a'.repeat(MAX_PROMPT_LENGTH + 1));

    expect(isCockpitError(error, 'prompt-too-long')).toBe(true);
    expect(error).toMatchObject({ length: MAX_PROMPT_LENGTH + 1, max: MAX_PROMPT_LENGTH });
  });

  it('counts code points: a character beyond the BMP is one, not two', () => {
    expect(() => refuseTooLongPrompt('😀'.repeat(MAX_PROMPT_LENGTH))).not.toThrow();
    expect(refusal('😀'.repeat(MAX_PROMPT_LENGTH + 1))).toMatchObject({
      length: MAX_PROMPT_LENGTH + 1,
    });
  });
});
