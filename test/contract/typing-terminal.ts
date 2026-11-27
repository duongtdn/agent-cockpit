import { readInputBox } from '../../src/claude-code/screen-reading.ts';
import {
  type HookRequest,
  TypingStoppedError,
  type TypingTerminal,
} from '../../src/server/driver.ts';
import type { AgentSession } from '../support/agent-session.ts';
import { cameTrue } from '../support/eventually.ts';
import { POLL } from '../support/patience.ts';

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

/**
 * Gives a session's terminal as the core gives it to the driver: each write
 * checked first — the screen must show the input box, as the driver reads
 * it, or the write is refused, and every later one — and a prompt taken
 * when a `UserPromptSubmit` read since the terminal was made carries it.
 * Its `restoring` writes are checked the same way, apart.
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
  /** A check of the screen before each write: once one refuses, every later one does. */
  const screenCheck = () => {
    let refused = false;
    return async (write: string) => {
      refused ||= readInputBox(await session.screen()) === undefined;
      if (refused) {
        throw new TypingStoppedError(
          `The session shows no input box: ${JSON.stringify(write)} refused.`,
        );
      }
      writes.push(write);
    };
  };
  const checked = screenCheck();
  const restoreChecked = screenCheck();
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
    restoring: {
      async typeText(text) {
        await restoreChecked(`text:${text}`);
        await session.typeInOneWrite(text);
      },
      async pressKeys(keys) {
        await restoreChecked(keys.join(' '));
        await session.press(...keys);
      },
      readScreen: () => session.screenWithCursor(),
    },
    promptTaken: (prompt, withinMs) => cameTrue(() => taken(prompt), withinMs, POLL.hooks),
  };
}
