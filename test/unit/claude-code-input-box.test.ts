import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { claudeCode } from '../../src/claude-code/index.ts';
import { isEmptyBox, readInputBoxView } from '../../src/claude-code/screen-reading.ts';

/**
 * Screens of Claude Code 2.1.332 with a draft or a mode in the input box,
 * as `tmux capture-pane` gave them in a 120×40 pane, trailing blanks and the
 * blank rows at both ends removed. Named `<case>-<step>`: `-0-setup` the
 * person's box, `-1-downs` after Downs, `-2-stashed` once the box was
 * emptied, `-4-entered` after the prompt's Enter.
 */
const SCREENS = fileURLToPath(new URL('../fixtures/input-box/', import.meta.url));

function screen(name: string): string {
  return readFileSync(`${SCREENS}${name}.txt`, 'utf8');
}

const { readInputBox } = claudeCode();

describe('reading the input box while a prompt is typed', () => {
  it('reads a draft of several lines, the sign’s column left out', () => {
    const box = readInputBoxView(screen('h3-background-task-draft-0-setup'));

    expect(box).toMatchObject({
      text: 'my draft\nsecond line',
      sign: '❯',
      hiddenAbove: 0,
      hiddenBelow: 0,
      recalled: false,
    });
    expect(box && box.lastRow - box.firstRow).toBe(1);
  });

  it('reads an empty box as empty', () => {
    const box = readInputBoxView(screen('a6-empty-box-after-a-kill-literal-rule-ready'));

    expect(box).toMatchObject({ text: '', sign: '❯' });
    expect(box && isEmptyBox(box)).toBe(true);
  });

  it('reads the rows a scrolled box hides above and below, its sign scrolled out', () => {
    const box = readInputBoxView(screen('a1-draft-25-lines-cursor-up-0-setup'));

    expect(box).toMatchObject({ sign: undefined, hiddenAbove: 7, hiddenBelow: 3 });
    expect(box?.text.split('\n')).toEqual(
      Array.from({ length: 15 }, (_, index) => `draft line ${String(index + 8).padStart(2, '0')}`),
    );
    expect(box && isEmptyBox(box)).toBe(false);
  });

  it('reads a box scrolled to its end', () => {
    expect(readInputBoxView(screen('a1-draft-25-lines-cursor-up-1-downs'))).toMatchObject({
      hiddenAbove: 10,
      hiddenBelow: 0,
    });
  });

  it('reads a wrapped line as the rows the box shows', () => {
    const box = readInputBoxView(screen('a3-draft-one-wrapped-line-cursor-mid-0-setup'));

    expect(box?.text.split('\n')).toHaveLength(6);
    expect(box && box.lastRow - box.firstRow).toBe(5);
  });

  it('reads shell mode by its sign, with a draft and empty', () => {
    expect(readInputBoxView(screen('d1-shell-mode-draft-0-setup'))).toMatchObject({
      text: 'echo shell-draft',
      sign: '!',
    });
    expect(readInputBoxView(screen('d1-shell-mode-draft-2-stashed'))).toMatchObject({
      text: '',
      sign: '!',
    });
  });

  it('reads a box under an open menu', () => {
    expect(readInputBoxView(screen('c1-slash-menu-open-0-setup'))).toMatchObject({ text: '/he' });
    expect(readInputBoxView(screen('c3-at-menu-open-0-setup'))).toMatchObject({
      text: 'look at @alp',
    });
    expect(readInputBoxView(screen('c4-at-menu-mid-draft-0-setup'))).toMatchObject({
      text: 'first line\ncompare @alp',
    });
  });

  it('reads the box while the agent works on a turn', () => {
    expect(readInputBoxView(screen('g3-100k-vietnamese-4-entered'))).toMatchObject({ text: '' });
    expect(readInputBox(screen('g3-100k-vietnamese-4-entered'))).toEqual({ text: '' });
  });

  it('reads a box in vim’s INSERT mode', () => {
    expect(readInputBox(screen('e1-vim-insert-draft-0-setup'))).toEqual({
      text: 'vim draft one\nvim draft two',
    });
  });

  it('reads an entry recalled from the history as recalled, and as no box to type into', () => {
    for (const name of ['b1-history-empty-box-up-0-setup', 'b4-history-multiline-entry-0-setup']) {
      expect(readInputBoxView(screen(name))).toMatchObject({ recalled: true });
      expect(readInputBox(screen(name))).toBeUndefined();
    }
  });

  it('finds no box where a permission dialog or the task panel replaced it', () => {
    for (const name of [
      'f1-dialog-text-then-enter-0-dialog',
      'h1-background-task-empty-box-literal-1-downs',
    ]) {
      expect(readInputBoxView(screen(name))).toBeUndefined();
      expect(readInputBox(screen(name))).toBeUndefined();
    }
  });

  it('finds no box in rows between two rules that are not drawn as one', () => {
    const rule = '─'.repeat(120);
    expect(readInputBoxView(`${rule}\n ❯ 1. Yes\n   2. No\n${rule}`)).toBeUndefined();
    expect(readInputBoxView(`${rule}\n❯ draft\n not indented\n${rule}`)).toBeUndefined();
    expect(readInputBoxView(`${rule}\n  scrolled, but no rule says so\n${rule}`)).toBeUndefined();
    expect(readInputBoxView('no rule at all')).toBeUndefined();
  });

  it('gives the box’s text to the core as it reads it', () => {
    expect(readInputBox(screen('h3-background-task-draft-0-setup'))).toEqual({
      text: 'my draft\nsecond line',
    });
  });
});
