import type { Key } from './keys.ts';

/** Where typed text waits until Enter submits it. Its cursor stays at the end. */
export interface InputBox {
  /** Gives the text in the box, its lines joined by line breaks. */
  text(): string;
  /** Applies a key: the editing keys change the text, the others do nothing. */
  press(key: Key): void;
  /**
   * Empties the box.
   *
   * @returns The text it held.
   */
  take(): string;
}

/**
 * Creates an input box.
 *
 * @returns The box, empty, with nothing killed.
 */
export function createInputBox(): InputBox {
  let text = '';
  let killed = '';
  let lastKeyKilled = false;

  /** Kills the last line, or its line break when the line is empty; kills in a row add up. */
  function killLine(): void {
    if (text === '') return;
    const lineStart = text.endsWith('\n') ? text.length - 1 : text.lastIndexOf('\n') + 1;
    killed = text.slice(lineStart) + (lastKeyKilled ? killed : '');
    text = text.slice(0, lineStart);
  }

  function press(key: Key): void {
    if (key.kind === 'text') text += key.text;
    else if (key.kind === 'line-break') text += '\n';
    else if (key.kind === 'backspace') text = Array.from(text).slice(0, -1).join('');
    else if (key.kind === 'yank') text += killed;
    else if (key.kind === 'kill-line') killLine();
    lastKeyKilled = key.kind === 'kill-line';
  }

  function take(): string {
    const taken = text;
    text = '';
    return taken;
  }

  return { text: () => text, press, take };
}
