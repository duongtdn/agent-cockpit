import type { TerminalScreen, TypingOutcome, TypingTerminal } from '../server/driver.js';
import { type InputBoxView, isEmptyBox, readInputBoxView } from './screen-reading.js';

/**
 * Typed after the draft and killed with it, so that the kill ring's last
 * entry is always the stash, an empty draft too: Claude Code inserts it,
 * never draws it, and drops it from a submitted prompt.
 */
const SENTINEL = '⁣';

/** The most characters (code points) in one write: a larger burst reads as a paste. */
export const WRITE_LENGTH = 200;

/** The pause between two writes of the prompt, in milliseconds. */
export const WRITE_GAP_MS = 50;

/** How long an Enter is given to submit before the box is looked at again. */
const SUBMIT_PATIENCE_MS = 3000;

/** How long a prompt that left the box is given for its hook to come. */
const LATE_SUBMIT_MS = 10_000;

/** How many times Enter is pressed on a prompt that stays in the box: the agent loses one now and then. */
const ENTER_PRESSES = 3;

/** How long the screen is given to show what a key did, and how often it is read meanwhile. */
const SETTLE_MS = 1000;
const POLL_MS = 25;

/** How many rounds of Downs reach the draft's last row: more than one only when a scrolled box hides wrapped lines. */
const MOVE_ROUNDS = 10;

/** The most Downs in one write: a long burst of keys could read as a paste. */
const DOWNS_PER_WRITE = 50;

/** One write of a typed prompt: literal text, or the keys of a line break. */
export type PromptWrite = { readonly text: string } | { readonly keys: readonly string[] };

/** A line break inside the input box: ESC CR, which Enter alone would submit. */
const LINE_BREAK: PromptWrite = { keys: ['M-Enter'] };

/** What paces the typing: real time, or a test's. */
export interface TypingClock {
  /** Waits, in milliseconds. */
  pause(ms: number): Promise<void>;
  /** The time now, in milliseconds. */
  now(): number;
}

const REAL_TIME: TypingClock = {
  pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/**
 * Characters typed as keys rather than text: every control character but
 * the tab and the line break. Left out of a prompt, which they would act on.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are what it finds.
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * Gives the text the driver types for a prompt: line breaks as `\n`, tabs
 * as four spaces (Claude Code drops a typed tab), control characters and
 * the driver's sentinel left out, and a space before a leading `!`, which
 * would otherwise turn the input to shell mode. A leading `/` stays: the
 * prompt is a command.
 *
 * @param prompt - The prompt.
 * @returns The text typed.
 */
export function typedForm(prompt: string): string {
  const text = prompt
    .replace(/\r\n?/g, '\n')
    .replaceAll('\t', '    ')
    .replace(CONTROL_CHARACTERS, '')
    .replaceAll(SENTINEL, '');
  return text.startsWith('!') ? ` ${text}` : text;
}

/**
 * Gives the prompt as the agent carries it once taken: the typed text
 * without its trailing whitespace, which Claude Code trims.
 *
 * @param prompt - The prompt.
 */
export function promptAsTaken(prompt: string): string {
  return typedForm(prompt).trimEnd();
}

/**
 * Splits a typed text into its writes: each line in writes of at most
 * {@link WRITE_LENGTH} characters, never splitting a character, and a line
 * break between lines.
 *
 * @param typed - The typed text, as {@link typedForm} gives it.
 * @returns The writes, in order.
 */
export function promptWrites(typed: string): PromptWrite[] {
  return typed.split('\n').flatMap((line, index) => {
    const characters = Array.from(line);
    const chunks: PromptWrite[] = [];
    for (let start = 0; start < characters.length; start += WRITE_LENGTH) {
      chunks.push({ text: characters.slice(start, start + WRITE_LENGTH).join('') });
    }
    return index === 0 ? chunks : [LINE_BREAK, ...chunks];
  });
}

/**
 * Types a prompt into Claude Code's input box, keeping the person's draft.
 *
 * 1. The draft is stashed in the kill ring: Down as many times as the
 *    screen shows rows below the cursor (none on an empty box: with a
 *    background task running, a Down past the last row opens the task
 *    panel), Ctrl+E, the sentinel, then Ctrl+U at least once and until the
 *    box is empty. In shell mode one more Ctrl+U on the empty box leaves it.
 * 2. The prompt is typed in writes of at most 200 characters, 50 ms apart,
 *    a line break as ESC CR.
 * 3. Enter; the agent's `UserPromptSubmit` must carry the prompt. While it
 *    does not and the prompt stays in the box, Enter again, three times in
 *    all; then the box is cleared.
 * 4. The draft is put back: `!` first if shell mode was left, Ctrl+Y (then
 *    Alt+Y past the cleared prompt), Backspace for the sentinel.
 *
 * An entry the person recalled from the history is not typed over, nor is
 * anything but the box: nothing is typed then. The core checks the screen
 * before every write too.
 *
 * @param prompt - The prompt.
 * @param terminal - The session's terminal, through the core.
 * @returns Whether the agent took it, or that no input box took it.
 * @throws What the terminal rejects with: the typing stops there.
 */
export function typePrompt(prompt: string, terminal: TypingTerminal): Promise<TypingOutcome> {
  return typePromptAt(REAL_TIME, prompt, terminal);
}

/**
 * {@link typePrompt}, paced by a clock of the caller's.
 *
 * @param clock - What paces the typing.
 * @param prompt - The prompt.
 * @param terminal - The session's terminal, through the core.
 */
export function typePromptAt(
  clock: TypingClock,
  prompt: string,
  terminal: TypingTerminal,
): Promise<TypingOutcome> {
  return new PromptTyping(clock, terminal).type(prompt);
}

/** A stashed draft: what puts it back. */
interface Stash {
  /** Whether the stash left shell mode, which the restore turns on again. */
  readonly leftShellMode: boolean;
}

/** A box read with the screen it was read from. */
interface Seen {
  readonly screen: TerminalScreen;
  readonly box: InputBoxView | undefined;
}

class PromptTyping {
  readonly #clock: TypingClock;
  readonly #terminal: TypingTerminal;

  constructor(clock: TypingClock, terminal: TypingTerminal) {
    this.#clock = clock;
    this.#terminal = terminal;
  }

  async type(prompt: string): Promise<TypingOutcome> {
    const start = await this.#read();
    if (start.box === undefined || start.box.recalled) return 'no-input-box';
    const stash = await this.#stash(start);
    if (stash === undefined) return 'no-input-box';
    await this.#write(promptWrites(typedForm(prompt)));
    const submitted = await this.#submit(promptAsTaken(prompt));
    if (submitted === 'gone') return 'no-input-box';
    if (submitted === 'taken') {
      await this.#restore(stash, []);
      return 'taken';
    }
    // A prompt cleared from the box is the kill ring's last entry: Alt+Y reaches the draft before it.
    const cleared = submitted === 'in-the-box' ? await this.#killUntilEmpty() : 'empty';
    if (cleared === 'gone') return 'no-input-box';
    await this.#restore(stash, submitted === 'in-the-box' ? ['M-y'] : []);
    return cleared === 'empty' ? 'not-taken' : 'no-input-box';
  }

  /**
   * Stashes the draft: the cursor to the draft's last row, then the
   * sentinel, then kills until the box is empty.
   *
   * @returns What puts the draft back; `undefined` when the box was gone
   * or did not empty, the draft put back where it could be.
   */
  async #stash(start: Seen): Promise<Stash | undefined> {
    const atEnd = await this.#toLastRow(start);
    if (atEnd === undefined) return undefined;
    await this.#terminal.pressKeys(['C-e']);
    await this.#terminal.typeText(SENTINEL);
    const emptied = await this.#killUntilEmpty();
    if (emptied === 'gone') return undefined;
    if (emptied === 'stuck') {
      await this.#restore({ leftShellMode: false }, []);
      return undefined;
    }
    const empty = await this.#read();
    if (empty.box?.sign !== '!') return { leftShellMode: false };
    await this.#terminal.pressKeys(['C-u']);
    const left = await this.#readUntil((seen) => seen.box?.sign !== '!');
    if (left.box?.sign === '❯') return { leftShellMode: true };
    if (left.box !== undefined) await this.#restore({ leftShellMode: false }, []);
    return undefined;
  }

  /**
   * Moves the cursor to the draft's last row, by as many Downs as the
   * screen shows rows below it, never one more.
   *
   * @returns The screen once there; `undefined` when the box is gone, the
   * cursor is not in it, or the Downs did not move it (an open menu took them).
   */
  async #toLastRow(start: Seen): Promise<Seen | undefined> {
    let seen = start;
    for (let round = 0; round < MOVE_ROUNDS; round++) {
      const { box } = seen;
      if (box === undefined) return undefined;
      if (box.firstRow === box.lastRow && box.hiddenAbove + box.hiddenBelow === 0) return seen;
      const below = rowsBelowCursor(box, seen.screen);
      if (below === undefined) return undefined;
      if (below === 0) return seen;
      const from = rowInDraft(box, seen.screen);
      for (let pressed = 0; pressed < below; pressed += DOWNS_PER_WRITE) {
        if (pressed > 0) await this.#clock.pause(WRITE_GAP_MS);
        await this.#terminal.pressKeys(downs(Math.min(DOWNS_PER_WRITE, below - pressed)));
      }
      seen = await this.#readUntil((now) => movedBy(now, from) === below);
      if ((movedBy(seen, from) ?? 0) <= 0) return undefined;
    }
    return undefined;
  }

  /**
   * Presses Ctrl+U at least once, then until the box is empty: each kills
   * one row, then its line break, and successive kills are one entry of
   * the kill ring.
   *
   * @returns `empty`; `gone` when the box is; `stuck` when two kills in a
   * row changed nothing on the screen (the first may kill only the sentinel).
   */
  async #killUntilEmpty(): Promise<'empty' | 'gone' | 'stuck'> {
    let unchanged = 0;
    let seen = await this.#read();
    do {
      const before = drawn(seen.box);
      await this.#terminal.pressKeys(['C-u']);
      seen = await this.#readUntil((now) => drawn(now.box) !== before);
      if (seen.box === undefined) return 'gone';
      unchanged = drawn(seen.box) === before ? unchanged + 1 : 0;
      if (unchanged === 2) return 'stuck';
    } while (!isEmptyBox(seen.box));
    return 'empty';
  }

  /** Types the prompt's writes, {@link WRITE_GAP_MS} apart. */
  async #write(writes: readonly PromptWrite[]): Promise<void> {
    for (const [index, write] of writes.entries()) {
      if (index > 0) await this.#clock.pause(WRITE_GAP_MS);
      if ('text' in write) await this.#terminal.typeText(write.text);
      else await this.#terminal.pressKeys(write.keys);
    }
  }

  /**
   * Presses Enter until the agent takes the prompt, three times at most,
   * while it stays in the box.
   *
   * @returns `taken`; `in-the-box` when it was not taken and stays there;
   * `left` when it left the box and no hook carried it; `gone` when the
   * box is.
   */
  async #submit(prompt: string): Promise<'taken' | 'in-the-box' | 'left' | 'gone'> {
    for (let enters = 1; enters <= ENTER_PRESSES; enters++) {
      await this.#terminal.pressKeys(['Enter']);
      if (await this.#terminal.promptTaken(prompt, SUBMIT_PATIENCE_MS)) return 'taken';
      const { box } = await this.#read();
      if (box === undefined) return 'gone';
      if (isEmptyBox(box)) {
        // Out of the box, the prompt was taken and its hook is late: another Enter would be the agent's next key.
        return (await this.#terminal.promptTaken(prompt, LATE_SUBMIT_MS)) ? 'taken' : 'left';
      }
    }
    return 'in-the-box';
  }

  /** Puts the draft back: shell mode, the kill ring's entry, the sentinel off its end. */
  async #restore(stash: Stash, afterYank: readonly string[]): Promise<void> {
    if (stash.leftShellMode) await this.#terminal.typeText('!');
    await this.#terminal.pressKeys(['C-y', ...afterYank]);
    await this.#terminal.pressKeys(['BSpace']);
  }

  async #read(): Promise<Seen> {
    const screen = await this.#terminal.readScreen();
    return { screen, box: readInputBoxView(screen.text) };
  }

  /** Reads the screen until it shows what a key did, for {@link SETTLE_MS} at most. */
  async #readUntil(done: (seen: Seen) => boolean): Promise<Seen> {
    const deadline = this.#clock.now() + SETTLE_MS;
    let seen = await this.#read();
    while (!done(seen) && this.#clock.now() < deadline) {
      await this.#clock.pause(POLL_MS);
      seen = await this.#read();
    }
    return seen;
  }
}

function downs(count: number): string[] {
  return Array<string>(count).fill('Down');
}

/** The rows of the draft below the cursor, shown or scrolled out; `undefined` when the cursor is not in the box. */
function rowsBelowCursor(box: InputBoxView, screen: TerminalScreen): number | undefined {
  const { row } = screen.cursor;
  if (row < box.firstRow || row > box.lastRow) return undefined;
  return box.lastRow - row + box.hiddenBelow;
}

/** The cursor's row in the whole draft, the rows scrolled out above counted. */
function rowInDraft(box: InputBoxView, screen: TerminalScreen): number {
  return box.hiddenAbove + screen.cursor.row - box.firstRow;
}

/** How many rows the cursor moved down in the draft; `undefined` when it is no longer in the box. */
function movedBy({ box, screen }: Seen, from: number): number | undefined {
  if (box === undefined || rowsBelowCursor(box, screen) === undefined) return undefined;
  return rowInDraft(box, screen) - from;
}

/** What the box draws, to tell whether a key changed it. */
function drawn(box: InputBoxView | undefined): string {
  return box === undefined
    ? ''
    : `${box.sign ?? ''}${box.hiddenAbove}/${box.hiddenBelow}\n${box.text}`;
}
