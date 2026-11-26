import type { TypingOutcome, TypingTerminal } from '../server/driver.js';

/**
 * Types a prompt into Claude Code's input box, keeping the person's draft.
 * This version types nothing yet: no prompt is taken.
 *
 * @param _prompt - The prompt.
 * @param _terminal - The session's terminal, through the core.
 * @returns Whether the agent took it.
 */
export async function typePrompt(
  _prompt: string,
  _terminal: TypingTerminal,
): Promise<TypingOutcome> {
  return 'not-taken';
}
