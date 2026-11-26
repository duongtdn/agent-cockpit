import { describe, expect, it } from 'vitest';
import { createInputBox } from '../support/fake-agent/input-box.ts';
import { createKeyDecoder, type Key } from '../support/fake-agent/keys.ts';

const ESC = '\x1b';

function decode(...chunks: string[]): Key[] {
  const decoder = createKeyDecoder();
  return chunks.flatMap((chunk) => decoder.decode(chunk));
}

describe("the keys the fake agent's terminal receives", () => {
  it('reads typed characters as text and a carriage return as Enter (behavior 4)', () => {
    expect(decode('hello\r')).toEqual([{ kind: 'text', text: 'hello' }, { kind: 'enter' }]);
  });

  it('reads ESC then a carriage return as a line break inside the text', () => {
    expect(decode(`a${ESC}\rb`)).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'line-break' },
      { kind: 'text', text: 'b' },
    ]);
  });

  it('reads a line break typed over two writes', () => {
    expect(decode(ESC, '\r')).toEqual([{ kind: 'line-break' }]);
  });

  it('reads an ESC that nothing follows as the Escape key, once asked to settle', () => {
    const decoder = createKeyDecoder();

    expect(decoder.decode(ESC)).toEqual([]);
    expect(decoder.awaitsMore()).toBe(true);
    expect(decoder.settle()).toEqual([{ kind: 'escape' }]);
    expect(decoder.awaitsMore()).toBe(false);
    expect(decoder.settle()).toEqual([]);
  });

  it('reads Backspace, Ctrl+U and Ctrl+Y', () => {
    expect(decode('\x7f\x15\x19')).toEqual([
      { kind: 'backspace' },
      { kind: 'kill-line' },
      { kind: 'yank' },
    ]);
  });

  it('reads Up and Down, as a terminal sends them in either cursor mode', () => {
    expect(decode(`${ESC}[A`, `${ESC}[B`, `${ESC}OA`, `${ESC}O`, 'B')).toEqual([
      { kind: 'up' },
      { kind: 'down' },
      { kind: 'up' },
      { kind: 'down' },
    ]);
  });

  it('reads the keys it has no use for as such: Right, Ctrl+Up, Ctrl+E, a function key, Meta', () => {
    const keys = decode(
      `${ESC}[C`,
      `${ESC}[1;5A`,
      '\x05',
      `${ESC}OP`,
      `${ESC}x`,
      `${ESC}[1;5`,
      'C',
      'a',
    );

    expect(keys).toEqual([
      { kind: 'other' },
      { kind: 'other' },
      { kind: 'other' },
      { kind: 'other' },
      { kind: 'other' },
      { kind: 'other' },
      { kind: 'text', text: 'a' },
    ]);
  });

  it('keeps a character of several code units whole', () => {
    expect(decode('né \u{1F600}\u{2063}')).toEqual([
      { kind: 'text', text: 'né \u{1F600}\u{2063}' },
    ]);
  });
});

describe("the fake agent's input box", () => {
  function boxAfter(...keys: Key[]) {
    const box = createInputBox();
    for (const key of keys) box.press(key);
    return box;
  }
  const text = (value: string): Key => ({ kind: 'text', text: value });
  const kill: Key = { kind: 'kill-line' };

  it('holds what was typed, line breaks included, until it is taken', () => {
    const box = boxAfter(text('one'), { kind: 'line-break' }, text('two'));

    expect(box.text()).toBe('one\ntwo');
    expect(box.take()).toBe('one\ntwo');
    expect(box.text()).toBe('');
  });

  it('Backspace removes the last character, whole', () => {
    expect(boxAfter(text('ab\u{1F600}'), { kind: 'backspace' }).text()).toBe('ab');
    expect(boxAfter({ kind: 'backspace' }).text()).toBe('');
  });

  it('Ctrl+U kills one line, then its line break (behavior 67)', () => {
    const box = boxAfter(text('one'), { kind: 'line-break' }, text('two'), kill);

    expect(box.text()).toBe('one\n');
    box.press(kill);
    expect(box.text()).toBe('one');
    box.press(kill);
    expect(box.text()).toBe('');
  });

  it('Ctrl+Y restores what successive Ctrl+U killed, as one piece (behavior 67)', () => {
    const box = boxAfter(text('one'), { kind: 'line-break' }, text('two'), kill, kill, kill);

    box.press(text('new'));
    box.press({ kind: 'yank' });

    expect(box.text()).toBe('newone\ntwo');
  });

  it('a kill after another key starts a new piece', () => {
    const box = boxAfter(text('one'), kill, text('two'), kill, { kind: 'yank' });

    expect(box.text()).toBe('two');
  });

  it('Ctrl+U on an empty box does nothing, and Ctrl+Y with nothing killed neither', () => {
    const box = boxAfter(text('one'), kill, kill, { kind: 'yank' }, { kind: 'yank' });

    expect(box.text()).toBe('oneone');
    expect(boxAfter({ kind: 'yank' }, kill).text()).toBe('');
  });

  it('ignores the keys that are not its own', () => {
    const box = boxAfter(text('a'), { kind: 'other' }, { kind: 'enter' }, { kind: 'escape' });

    expect(box.text()).toBe('a');
  });
});
