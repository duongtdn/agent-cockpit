import { setTimeout as pause } from 'node:timers/promises';
import { readInputBox } from '../../src/claude-code/screen-reading.ts';
import type { HookRequest, TypingTerminal } from '../../src/server/driver.ts';
import type { AgentSession } from '../support/agent-session.ts';

/** A session's terminal as the driver types into it, with what it did. */
export interface ContractTypingTerminal extends TypingTerminal {
  /** Every write, in order: `text:…`, or the keys pressed joined by spaces. */
  readonly writes: readonly string[];
}

/** What a terminal is made of. */
export interface TypingTerminalParts {
  /** The session typed into. */
  readonly session: AgentSession;
  /** Every hook the driver read so far, growing: where the prompts taken are seen. */
  readonly hooksRead: readonly HookRequest[];
  /**
   * How many Enters the terminal loses, as the agent has been seen to:
   * pressed, they reach nothing. None by default.
   */
  readonly lostEnters?: number;
}

const HOOK_POLL_MS = 25;

/**
 * Gives a session's terminal as the core gives it to the driver: each write
 * checked first — the screen must show the input box, as the driver reads
 * it, or the write is refused — and a prompt taken when a
 * `UserPromptSubmit` read since the terminal was made carries it.
 *
 * @param parts - See {@link TypingTerminalParts}.
 * @returns The terminal.
 */
export function typingTerminal(parts: TypingTerminalParts): ContractTypingTerminal {
  const { session, hooksRead } = parts;
  const from = hooksRead.length;
  let lostEnters = parts.lostEnters ?? 0;
  const writes: string[] = [];
  const taken = (prompt: string) =>
    hooksRead
      .slice(from)
      .map((request) => request.body as Readonly<Record<string, unknown>>)
      .some((body) => body.hook_event_name === 'UserPromptSubmit' && body.prompt === prompt);
  const checked = async (write: string) => {
    if (readInputBox(await session.screen()) === undefined) {
      throw new Error(`The session shows no input box: ${JSON.stringify(write)} refused.`);
    }
    writes.push(write);
  };
  return {
    writes,
    async typeText(text) {
      await checked(`text:${text}`);
      await session.typeInOneWrite(text);
    },
    async pressKeys(keys) {
      await checked(keys.join(' '));
      const pressed = keys.filter((key) => {
        if (key !== 'Enter' || lostEnters === 0) return true;
        lostEnters -= 1;
        return false;
      });
      if (pressed.length > 0) await session.press(...pressed);
    },
    readScreen: () => session.screenWithCursor(),
    async promptTaken(prompt, withinMs) {
      const deadline = Date.now() + withinMs;
      while (!taken(prompt)) {
        if (Date.now() >= deadline) return false;
        await pause(HOOK_POLL_MS);
      }
      return true;
    },
  };
}
