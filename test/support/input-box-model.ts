import {
  type TerminalScreen,
  TypingStoppedError,
  type TypingTerminal,
} from '../../src/server/driver.ts';

/**
 * A model of Claude Code's input box (2.1.332), as the units-of-work spike
 * and the driver's experiments saw it, for the unit tests of the driver's
 * typing: the rows a line wraps onto, the cursor moving by rows, Ctrl+E,
 * Ctrl+U killing one row then its line break (successive kills one entry
 * of the kill ring), Ctrl+Y and Alt+Y, Backspace, ESC CR as a line break,
 * shell mode (`!` on an empty box; Ctrl+U on an empty box leaves it), the
 * sentinel U+2063 inserted but never drawn, a box taller than its window
 * scrolled with its rules saying so, an entry recalled from the history,
 * and Enter. It draws the screen as the agent does and places the cursor.
 * A Down on the last row is recorded: with a background task running, it
 * opens the task panel. Its terminal refuses writes as the core does: once
 * a dialog shows, or once the hooks told of something else (a turn the
 * agent began by itself), every later one; its `restoring` writes, only
 * while a dialog shows.
 */
export interface InputBoxModel {
  /** The terminal the driver types into, which checks every write as the core does. */
  readonly terminal: TypingTerminal;
  /** Every write, in order: `text:…` or the keys pressed. */
  readonly writes: string[];
  /** The prompts the agent took, as its `UserPromptSubmit` carries them. */
  readonly taken: string[];
  /** The texts submitted in shell mode: run as commands, never taken. */
  readonly ranInShell: string[];
  /** How many Downs were pressed on the last row. */
  readonly downsPastTheEnd: number;
  /** The box's text, the sentinel left in. */
  text(): string;
  /** Whether the box is in shell mode. */
  inShellMode(): boolean;
  /** Where the cursor is in the text. */
  cursor(): number;
  /** The kill ring's entries, the last killed last, the sentinel left in. */
  killRing(): readonly string[];
  /** Shows a dialog in place of the box from now on: every later write is refused. */
  showDialog(): void;
  /** Takes the dialog off the screen: the box shows again. */
  closeDialog(): void;
}

/** What the model starts with. */
export interface InputBoxSetup {
  /** The person's draft. */
  readonly draft?: string;
  /** Where the cursor is in it; at its end by default. */
  readonly cursor?: number;
  /** Shell mode on. */
  readonly shellMode?: boolean;
  /** An entry recalled from the history shown. */
  readonly recalled?: boolean;
  /** How many Enters the agent loses before it takes one. */
  readonly lostEnters?: number;
  /** Shows a dialog in place of the box after so many writes. */
  readonly dialogAfterWrites?: number;
  /**
   * Refuses every write of the typing after so many, the box still shown:
   * the hooks told of a turn the agent began by itself.
   */
  readonly stopAfterWrites?: number;
  /** The width of the box's text, in columns. */
  readonly width?: number;
  /** The most rows the box shows. */
  readonly window?: number;
}

const SENTINEL = '⁣';
const SCREEN_ROWS = 40;
const RULE_WIDTH = 120;

/** A row of the box: where it starts and ends in the text. */
interface Row {
  readonly start: number;
  readonly end: number;
  /** Whether it is the first row of its line. */
  readonly startsLine: boolean;
}

/**
 * Makes a model of the input box.
 *
 * @param setup - See {@link InputBoxSetup}.
 */
export function inputBoxModel(setup: InputBoxSetup = {}): InputBoxModel {
  const width = setup.width ?? 118;
  const window = setup.window ?? 15;
  let text = setup.draft ?? '';
  let cursor = setup.cursor ?? text.length;
  let shell = setup.shellMode ?? false;
  const recalled = setup.recalled ?? false;
  let lostEnters = setup.lostEnters ?? 0;
  let dialog = false;
  /** Whether the core refused a write of the typing: every later one is. */
  let stopped = false;
  /** Whether the core refused a write that puts the draft back: every later one is. */
  let restoreStopped = false;
  let top = 0;
  let killRing: string[] = [];
  let yanked: { start: number; index: number } | undefined;
  let lastWasKill = false;
  const writes: string[] = [];
  const taken: string[] = [];
  const ranInShell: string[] = [];
  let downsPastTheEnd = 0;

  function rows(): Row[] {
    const all: Row[] = [];
    let start = 0;
    for (const line of text.split('\n')) {
      const cells = Array.from(line);
      let offset = start;
      let first = true;
      // An empty line is one row; a wrapped line, as many as its width takes.
      for (let cell = 0; first || cell < cells.length; cell += width) {
        const chunk = cells.slice(cell, cell + width).join('');
        all.push({ start: offset, end: offset + chunk.length, startsLine: first });
        offset += chunk.length;
        first = false;
      }
      start += line.length + 1;
    }
    return all;
  }

  function cursorRow(all: Row[]): number {
    // At the end of a row the cursor is on it only when its line ends there; at a wrap, on the next row.
    return all.findIndex(
      (row, index) =>
        cursor >= row.start &&
        (cursor < row.end ||
          (cursor === row.end && (all[index + 1] === undefined || all[index + 1]?.startsLine))),
    );
  }

  function insert(inserted: string): void {
    text = text.slice(0, cursor) + inserted + text.slice(cursor);
    cursor += inserted.length;
  }

  function kill(): void {
    const all = rows();
    const row = all[cursorRow(all)] as Row;
    let from = row.start;
    if (cursor === row.start) {
      if (text === '') {
        shell = false;
        return;
      }
      if (row.startsLine) from = Math.max(0, cursor - 1);
      else from = (all[cursorRow(all) - 1] as Row).start;
    }
    const killed = text.slice(from, cursor);
    text = text.slice(0, from) + text.slice(cursor);
    cursor = from;
    if (lastWasKill && killRing.length > 0)
      killRing[killRing.length - 1] = killed + killRing.at(-1);
    else killRing = [...killRing, killed];
  }

  function moveRows(by: number): void {
    const all = rows();
    const at = cursorRow(all);
    const to = at + by;
    if (to >= all.length) {
      downsPastTheEnd += 1;
      return;
    }
    if (to < 0) return;
    const column = cursor - (all[at] as Row).start;
    const target = all[to] as Row;
    cursor = Math.min(target.start + column, target.end);
  }

  function enter(): void {
    if (lostEnters > 0) {
      lostEnters -= 1;
      return;
    }
    const prompt = text.replaceAll(SENTINEL, '').trimEnd();
    if (prompt === '') return;
    if (shell) ranInShell.push(prompt);
    else taken.push(prompt);
    text = '';
    cursor = 0;
    shell = false;
  }

  function endOfLine(): void {
    const lineEnd = text.indexOf('\n', cursor);
    cursor = lineEnd === -1 ? text.length : lineEnd;
  }

  function killOnce(wasKill: boolean): void {
    lastWasKill = wasKill;
    kill();
    lastWasKill = true;
  }

  function yank(): void {
    yanked = { start: cursor, index: killRing.length - 1 };
    insert(killRing.at(-1) ?? '');
  }

  /** Alt+Y right after a yank: the yanked text replaced by the kill ring's entry before it. */
  function yankEarlier(wasYank: { start: number; index: number } | undefined): void {
    if (wasYank === undefined || killRing.length < 2) return;
    const index = (wasYank.index - 1 + killRing.length) % killRing.length;
    text = text.slice(0, wasYank.start) + text.slice(cursor);
    cursor = wasYank.start;
    insert(killRing[index] ?? '');
    yanked = { start: wasYank.start, index };
  }

  function backspace(): void {
    if (cursor === 0) return;
    text = text.slice(0, cursor - 1) + text.slice(cursor);
    cursor -= 1;
  }

  function press(key: string): void {
    const wasKill = lastWasKill;
    lastWasKill = false;
    const wasYank = yanked;
    yanked = undefined;
    const keys: Readonly<Record<string, () => void>> = {
      Down: () => moveRows(1),
      Up: () => moveRows(-1),
      'C-e': endOfLine,
      'C-u': () => killOnce(wasKill),
      'C-y': yank,
      'M-y': () => yankEarlier(wasYank),
      BSpace: backspace,
      'M-Enter': () => insert('\n'),
      Enter: enter,
    };
    const action = keys[key];
    if (action === undefined) throw new Error(`The model plays no key ${key}.`);
    action();
  }

  function type(typed: string): void {
    lastWasKill = false;
    yanked = undefined;
    if (typed.startsWith('!') && text === '' && !shell) {
      shell = true;
      typed = typed.slice(1);
    }
    insert(typed);
  }

  function screen(): TerminalScreen {
    if (dialog) {
      return {
        text: [
          '',
          '─'.repeat(RULE_WIDTH),
          ' Do you want to proceed?',
          ' ❯ 1. Yes',
          '   2. No',
        ].join('\n'),
        cursor: { row: 0, column: 0 },
      };
    }
    const all = rows();
    const at = cursorRow(all);
    if (at < top) top = at;
    if (at >= top + window) top = at - window + 1;
    top = Math.min(top, Math.max(0, all.length - window));
    const shown = all.slice(top, top + window);
    const hiddenBelow = all.length - top - shown.length;
    const sign = shell ? '!' : '❯';
    const drawnRows = shown.map((row, index) => {
      const body = text.slice(row.start, row.end).replaceAll(SENTINEL, '');
      const lead = top === 0 && index === 0 ? `${sign} ` : '  ';
      return `${lead}${body}`.trimEnd();
    });
    const topRule = recalled ? rule('History 2/2') : top > 0 ? rule(`↑ ${top} more`) : rule();
    const bottomRule = hiddenBelow > 0 ? rule(`↓ ${hiddenBelow} more`) : rule();
    const above = Array<string>(SCREEN_ROWS - drawnRows.length - 3).fill('');
    const lines = [...above, topRule, ...drawnRows, bottomRule, '  ⏸ manual mode on'];
    const row = above.length + 1 + (at - top);
    return { text: lines.join('\n'), cursor: { row, column: 2 + cursor - (all[at] as Row).start } };
  }

  function written(what: string): void {
    writes.push(what);
    const count = writes.length;
    if (setup.dialogAfterWrites !== undefined && count >= setup.dialogAfterWrites) dialog = true;
    if (setup.stopAfterWrites !== undefined && count >= setup.stopAfterWrites) stopped = true;
  }

  function writeOfTyping(what: string): void {
    stopped ||= dialog;
    if (stopped) throw new TypingStoppedError('The core refuses the write.');
    written(what);
  }

  function writeOfRestore(what: string): void {
    restoreStopped ||= dialog;
    if (restoreStopped) throw new TypingStoppedError('The core refuses to put the draft back.');
    written(what);
  }

  const terminal: TypingTerminal = {
    async typeText(text) {
      writeOfTyping(`text:${text}`);
      type(text);
    },
    async pressKeys(keys) {
      writeOfTyping(keys.join(' '));
      for (const key of keys) press(key);
    },
    async readScreen() {
      return screen();
    },
    async promptTaken(prompt) {
      return taken.includes(prompt);
    },
    restoring: {
      async typeText(text) {
        writeOfRestore(`text:${text}`);
        type(text);
      },
      async pressKeys(keys) {
        writeOfRestore(keys.join(' '));
        for (const key of keys) press(key);
      },
      async readScreen() {
        return screen();
      },
    },
  };

  return {
    terminal,
    writes,
    taken,
    ranInShell,
    get downsPastTheEnd() {
      return downsPastTheEnd;
    },
    text: () => text,
    inShellMode: () => shell,
    cursor: () => cursor,
    killRing: () => [...killRing],
    showDialog: () => {
      dialog = true;
    },
    closeDialog: () => {
      dialog = false;
    },
  };
}

function rule(label?: string): string {
  if (label === undefined) return '─'.repeat(RULE_WIDTH);
  const start = `─── ${label} `;
  return start + '─'.repeat(RULE_WIDTH - start.length);
}
