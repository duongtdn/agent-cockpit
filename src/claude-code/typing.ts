import {
  type ClearingTerminal,
  type DraftTerminal,
  type InputBoxClearing,
  type TerminalScreen,
  type TypingOutcome,
  TypingStoppedError,
  type TypingTerminal,
} from '../server/driver.js';
import {
  type InputBoxView,
  isEmptyBox,
  readInputBoxView,
  withoutWhitespace,
} from './screen-reading.js';

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

/**
 * How long an Enter is given to submit before the box is looked at again.
 * The slowest seen from an Enter to its `UserPromptSubmit` was 1.86 s, six
 * agents starting at once on two loaded CPUs: this leaves about three
 * times that, so that an Enter the agent takes slowly gets no second one.
 */
const SUBMIT_PATIENCE_MS = 6000;

/** How long a prompt that left the box is given for its hook to come. */
const LATE_SUBMIT_MS = 10_000;

/** How many times Enter is pressed on a prompt that stays in the box: the agent loses one now and then. */
const ENTER_PRESSES = 3;

/**
 * How long the screen is given to show what a key surely changes (the
 * Downs' move, a kill that takes text, the prompt's end in the box). The
 * slowest seen was 0.52 s for 20 characters to show, with six agents
 * starting at once on two CPUs: this leaves about four times that, and is
 * paid in full only by a screen that never shows the change.
 */
const SETTLE_MS = 2000;

/**
 * How long the screen is watched after a kill that may change nothing on
 * it: on a box read empty, the kill takes only the sentinel, which is
 * never drawn. Every prompt typed into an empty box waits it out in full,
 * so it stays shorter: twice the slowest key's effect seen (0.52 s, above),
 * for a box that was not as empty as read.
 */
const QUIET_KILL_SETTLE_MS = 1000;

/** How often the screen is read while it is given to change. */
const POLL_MS = 25;

/**
 * How many characters of the prompt's end, whitespace left out, the box
 * must show before the first Enter: enough to tell the last write drawn.
 */
const END_SHOWN_LENGTH = 100;

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
 * 3. Enter, once the box shows the prompt's end (two seconds at most); the
 *    agent's `UserPromptSubmit` must carry the prompt. While it
 *    does not and the prompt stays in the box, Enter again, three times in
 *    all; then the box is cleared.
 * 4. The draft is put back: `!` first if shell mode was left, Ctrl+Y (then
 *    Alt+Y past the cleared prompt), Backspace for the sentinel.
 *
 * An entry the person recalled from the history is not typed over, nor is
 * anything but the box: nothing is typed then. The core checks the screen
 * before every write too. A write it refuses, or a box gone, stops the
 * typing: what was typed of the prompt is cleared and the draft put back
 * through the terminal's `restoring` writes while the box shows; else
 * nothing more is typed, and the outcome says where the draft is.
 *
 * @param prompt - The prompt.
 * @param terminal - The session's terminal, through the core.
 * @returns Whether the agent took it, or that no input box took it, and
 * where the draft is when it could not be put back. A prompt taken stays
 * `taken` even then: the draft is the kill ring's last entry.
 * @throws What the terminal rejects with, but a stop.
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

/**
 * Where the person's draft is while a prompt is typed, and what else the
 * box holds: what putting it back takes.
 */
interface DraftPlace {
  /**
   * How deep in the kill ring the draft is: 0 the last entry, 1 the one
   * before (a prompt was killed after it); `undefined` while it is in the box.
   */
  depth: 0 | 1 | undefined;
  /** Whether the stash left shell mode, which the restore turns on again. */
  leftShellMode: boolean;
  /** Whether the sentinel is in the box, at the cursor. */
  sentinel: boolean;
  /** Whether the box holds what was typed of the prompt. */
  promptInBox: boolean;
}

/** A box read with the screen it was read from. */
interface Seen {
  readonly screen: TerminalScreen;
  readonly box: InputBoxView | undefined;
}

class PromptTyping {
  readonly #clock: TypingClock;
  readonly #terminal: TypingTerminal;
  /** Where the keys go: the terminal, then its `restoring` writes once it stopped the typing. */
  #writer: DraftTerminal;
  readonly #draft: DraftPlace = {
    depth: undefined,
    leftShellMode: false,
    sentinel: false,
    promptInBox: false,
  };
  /** Whether the box held a draft of the person's. */
  #hadDraft = false;
  #taken = false;

  constructor(clock: TypingClock, terminal: TypingTerminal) {
    this.#clock = clock;
    this.#terminal = terminal;
    this.#writer = terminal;
  }

  async type(prompt: string): Promise<TypingOutcome> {
    try {
      return await this.#typed(prompt);
    } catch (error) {
      if (!(error instanceof TypingStoppedError)) throw error;
      return this.#putBackAfterStop();
    }
  }

  async #typed(prompt: string): Promise<TypingOutcome> {
    const start = await this.#read();
    if (start.box === undefined || start.box.recalled) return 'no-input-box';
    this.#hadDraft = !isEmptyBox(start.box);
    const stashed = await this.#stash(start);
    if (stashed === 'gone') return this.#putBackAfterStop();
    if (stashed === 'kept') return 'no-input-box';
    await this.#write(promptWrites(typedForm(prompt)));
    const submitted = await this.#submit(promptAsTaken(prompt));
    if (submitted === 'gone') return this.#putBackAfterStop();
    if (submitted === 'in-the-box' && (await this.#clearPrompt()) !== 'empty') {
      return this.#putBackAfterStop();
    }
    await this.#restore();
    return this.#taken ? 'taken' : 'not-taken';
  }

  /**
   * Stashes the draft: the cursor to the draft's last row, then the
   * sentinel, then kills until the box is empty.
   *
   * @returns `stashed`; `kept` when the draft stays in the box, or is back
   * there (the Downs did not move the cursor, the kills changed nothing,
   * shell mode did not leave); `gone` when the box is.
   */
  async #stash(start: Seen): Promise<'stashed' | 'kept' | 'gone'> {
    const atEnd = await this.#toLastRow(start);
    if (atEnd === undefined) return 'kept';
    await this.#writer.pressKeys(['C-e']);
    await this.#writer.typeText(SENTINEL);
    this.#draft.sentinel = true;
    const emptied = await this.#killUntilEmpty(() => {
      this.#draft.depth ??= 0;
    });
    if (emptied === 'gone') return 'gone';
    if (emptied === 'stuck') {
      await this.#restore();
      return 'kept';
    }
    const empty = await this.#read();
    if (empty.box?.sign !== '!') return 'stashed';
    await this.#writer.pressKeys(['C-u']);
    const left = await this.#readUntil((seen) => seen.box?.sign !== '!');
    if (left.box === undefined) return 'gone';
    if (left.box.sign === '❯') {
      this.#draft.leftShellMode = true;
      return 'stashed';
    }
    await this.#restore();
    return 'kept';
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
        await this.#writer.pressKeys(downs(Math.min(DOWNS_PER_WRITE, below - pressed)));
      }
      seen = await this.#readUntil((now) => movedBy(now, from) === below);
      if ((movedBy(seen, from) ?? 0) <= 0) return undefined;
    }
    return undefined;
  }

  /**
   * Clears what was typed of the prompt: killed after the draft, it makes
   * the draft the kill ring's entry before the last.
   */
  async #clearPrompt(): Promise<KillsOutcome> {
    const cleared = await this.#killUntilEmpty(() => {
      this.#draft.depth = 1;
    });
    if (cleared === 'empty') this.#draft.promptInBox = false;
    return cleared;
  }

  #killUntilEmpty(killed: () => void): Promise<KillsOutcome> {
    return killUntilEmpty(this.#clock, this.#writer, killed);
  }

  /** Types the prompt's writes, {@link WRITE_GAP_MS} apart. */
  async #write(writes: readonly PromptWrite[]): Promise<void> {
    for (const [index, write] of writes.entries()) {
      if (index > 0) await this.#clock.pause(WRITE_GAP_MS);
      if ('text' in write) await this.#writer.typeText(write.text);
      else await this.#writer.pressKeys(write.keys);
      this.#draft.promptInBox = true;
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
    // An Enter that comes right after the last write of a long prompt, under load, is now and then taken
    // as a line break. Past the bound the Enter is pressed all the same: the box may draw the prompt
    // otherwise than read here, and the Enters pressed again below still submit it. A box gone is the
    // core's to refuse the Enter for.
    await this.#readUntil(({ box }) => box === undefined || showsEnd(box, prompt));
    for (let enters = 1; enters <= ENTER_PRESSES; enters++) {
      await this.#writer.pressKeys(['Enter']);
      if (await this.#terminal.promptTaken(prompt, SUBMIT_PATIENCE_MS)) return this.#tookIt();
      const { box } = await this.#read();
      if (box === undefined) return 'gone';
      if (isEmptyBox(box)) {
        this.#draft.promptInBox = false;
        // Out of the box, the prompt was taken and its hook is late: another Enter would be the agent's next key.
        return (await this.#terminal.promptTaken(prompt, LATE_SUBMIT_MS)) ? this.#tookIt() : 'left';
      }
    }
    return 'in-the-box';
  }

  #tookIt(): 'taken' {
    this.#taken = true;
    this.#draft.promptInBox = false;
    return 'taken';
  }

  /**
   * Puts the draft back as far as it is out of the box: shell mode, the
   * kill ring's entry (past a prompt killed after it), the sentinel off its end.
   */
  async #restore(): Promise<void> {
    const draft = this.#draft;
    if (draft.leftShellMode) {
      await this.#writer.typeText('!');
      draft.leftShellMode = false;
    }
    if (draft.depth !== undefined) {
      await this.#writer.pressKeys(draft.depth === 1 ? ['C-y', 'M-y'] : ['C-y']);
      draft.depth = undefined;
    }
    if (draft.sentinel) {
      await this.#writer.pressKeys(['BSpace']);
      draft.sentinel = false;
    }
  }

  /**
   * Puts the draft back once the typing stopped, through the terminal's
   * `restoring` writes: what was typed of the prompt cleared, then the
   * draft. Where the core refuses, nothing more is typed.
   *
   * @returns The outcome: the draft's place told when it is still out of the box.
   */
  async #putBackAfterStop(): Promise<TypingOutcome> {
    this.#writer = this.#terminal.restoring;
    try {
      const cleared =
        this.#draft.promptInBox && this.#draft.depth !== undefined
          ? await this.#clearPrompt()
          : 'empty';
      if (cleared === 'empty') await this.#restore();
    } catch (error) {
      if (!(error instanceof TypingStoppedError)) throw error;
    }
    return this.#stoppedOutcome();
  }

  #stoppedOutcome(): TypingOutcome {
    if (this.#taken) return 'taken';
    if (this.#draft.depth === undefined || !this.#hadDraft) return 'no-input-box';
    return { draftLeft: whereTheDraftIs(this.#draft) };
  }

  #read(): Promise<Seen> {
    return read(this.#writer);
  }

  #readUntil(done: (seen: Seen) => boolean): Promise<Seen> {
    return readUntil(this.#clock, this.#writer, done);
  }
}

/**
 * Clears Claude Code's input box, the cursor at the end of its text: Ctrl+U
 * until the box is empty, as the typing kills a draft. An early Esc leaves
 * the cursor at the end of the prompt it put back, and the kills take
 * exactly that prompt.
 *
 * @param terminal - The session's terminal, through the core.
 * @returns `cleared`, also for a box already empty, where nothing is
 * pressed; `no-input-box` when none shows, before a kill or after one;
 * `not-emptied` when the kills stopped changing the box, or reached their
 * bound with text left in it.
 * @throws What the terminal rejects with.
 */
export function clearInputBox(terminal: ClearingTerminal): Promise<InputBoxClearing> {
  return clearInputBoxAt(REAL_TIME, terminal);
}

/**
 * {@link clearInputBox}, paced by a clock of the caller's.
 *
 * @param clock - What paces the reads of the screen.
 * @param terminal - The session's terminal, through the core.
 */
export async function clearInputBoxAt(
  clock: TypingClock,
  terminal: ClearingTerminal,
): Promise<InputBoxClearing> {
  const { box } = await read(terminal);
  if (box === undefined) return 'no-input-box';
  if (isEmptyBox(box)) return 'cleared';
  return CLEARING[await killUntilEmpty(clock, terminal, () => {})];
}

/** What the kills came to, for a clearing of the box. */
const CLEARING: Readonly<Record<KillsOutcome, InputBoxClearing>> = {
  empty: 'cleared',
  gone: 'no-input-box',
  stuck: 'not-emptied',
};

/** What a run of kills came to: the box empty, gone, or left with text. */
type KillsOutcome = 'empty' | 'gone' | 'stuck';

/**
 * Presses Ctrl+U at least once, then until the box is empty: each kills
 * one row, then its line break, and successive kills are one entry of
 * the kill ring. A box takes at most two kills a row (one a wrapped row,
 * two a line's last row and its line break); more means something else
 * writes into it.
 *
 * @param clock - What paces the reads of the screen.
 * @param terminal - Where the kills go.
 * @param killed - Told after a kill that took something: the box changed,
 * or is empty (a kill of the sentinel alone, which is never drawn, changes
 * nothing on the screen), or is gone (the key reached the box last seen).
 * A kill that changed nothing put nothing in the kill ring, whose last
 * entry is then still an earlier kill of the person's.
 * @returns `empty`; `gone` when the box is; `stuck` when two kills in a
 * row changed nothing on the screen (the first may kill only the sentinel),
 * or two kills for each row the box first held left text in it.
 */
async function killUntilEmpty(
  clock: TypingClock,
  terminal: ClearingTerminal,
  killed: () => void,
): Promise<KillsOutcome> {
  let unchanged = 0;
  let seen = await read(terminal);
  const most = 2 * Math.max(1, rowsHeld(seen.box));
  for (let kills = 1; ; kills++) {
    const before = drawn(seen.box);
    const boundMs =
      seen.box !== undefined && isEmptyBox(seen.box) ? QUIET_KILL_SETTLE_MS : SETTLE_MS;
    await terminal.pressKeys(['C-u']);
    seen = await readUntil(clock, terminal, (now) => drawn(now.box) !== before, boundMs);
    if (seen.box === undefined) {
      killed();
      return 'gone';
    }
    const changed = drawn(seen.box) !== before;
    if (changed || isEmptyBox(seen.box)) killed();
    if (isEmptyBox(seen.box)) return 'empty';
    unchanged = changed ? 0 : unchanged + 1;
    if (unchanged === 2 || kills === most) return 'stuck';
  }
}

/** The rows a box holds, shown or scrolled out; none for no box. */
function rowsHeld(box: InputBoxView | undefined): number {
  return box === undefined ? 0 : box.lastRow - box.firstRow + 1 + box.hiddenAbove + box.hiddenBelow;
}

async function read(terminal: Pick<ClearingTerminal, 'readScreen'>): Promise<Seen> {
  const screen = await terminal.readScreen();
  return { screen, box: readInputBoxView(screen.text) };
}

/** Reads the screen until it shows what a key did, for `boundMs` at most. */
async function readUntil(
  clock: TypingClock,
  terminal: Pick<ClearingTerminal, 'readScreen'>,
  done: (seen: Seen) => boolean,
  boundMs = SETTLE_MS,
): Promise<Seen> {
  const deadline = clock.now() + boundMs;
  let seen = await read(terminal);
  while (!done(seen) && clock.now() < deadline) {
    await clock.pause(POLL_MS);
    seen = await read(terminal);
  }
  return seen;
}

/** Where a draft left out of the box is, in the person's keys. */
function whereTheDraftIs({ depth, promptInBox }: DraftPlace): string {
  const keys = depth === 1 ? 'Ctrl+Y, then Alt+Y,' : 'Ctrl+Y';
  const prompt = promptInBox ? ' What was typed of the prompt may stay in the box.' : '';
  return `The person's draft is in the input box's kill ring: ${keys} brings it back.${prompt}`;
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

/**
 * Whether the box shows the prompt's end: its last characters compared
 * without whitespace, since the box wraps the prompt onto rows. A box
 * scrolled to its end may show fewer characters than that.
 */
function showsEnd(box: InputBoxView, prompt: string): boolean {
  const shown = withoutWhitespace(box.text);
  const end = withoutWhitespace(prompt).slice(-END_SHOWN_LENGTH);
  if (shown === '') return end === '';
  return shown.endsWith(box.hiddenAbove > 0 ? end.slice(-shown.length) : end);
}

/** What the box draws, to tell whether a key changed it. */
function drawn(box: InputBoxView | undefined): string {
  return box === undefined
    ? ''
    : `${box.sign ?? ''}${box.hiddenAbove}/${box.hiddenBelow}\n${box.text}`;
}
