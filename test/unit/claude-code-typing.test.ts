import { describe, expect, it } from 'vitest';
import {
  promptAsTaken,
  promptWrites,
  type TypingClock,
  typedForm,
  typePromptAt,
  WRITE_GAP_MS,
  WRITE_LENGTH,
} from '../../src/claude-code/typing.ts';
import { type InputBoxSetup, inputBoxModel } from '../support/input-box-model.ts';

/** A clock that moves only when the typing waits, and remembers each wait. */
function testClock(): TypingClock & { readonly pauses: number[] } {
  let now = 0;
  const pauses: number[] = [];
  return {
    pauses,
    now: () => now,
    pause: async (ms) => {
      pauses.push(ms);
      now += ms;
    },
  };
}

async function typeInto(setup: InputBoxSetup, prompt: string) {
  const box = inputBoxModel(setup);
  const clock = testClock();
  const outcome = await typePromptAt(clock, prompt, box.terminal);
  return { box, clock, outcome };
}

const lines = (count: number, width = 0) =>
  Array.from({ length: count }, (_, index) => `draft line ${index + 1}`.padEnd(width, '.')).join(
    '\n',
  );

describe('the text typed for a prompt', () => {
  it('types tabs as four spaces and puts a space before a leading !', () => {
    expect(typedForm('a\tb')).toBe('a    b');
    expect(typedForm('!ls')).toBe(' !ls');
    expect(typedForm('say !ls')).toBe('say !ls');
    expect(typedForm('/help')).toBe('/help');
  });

  it('keeps line breaks as \\n, whichever were given', () => {
    expect(typedForm('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });

  it('leaves out control characters, which would act as keys, and the sentinel', () => {
    expect(typedForm('a\u001b[Bb\u0003c\u007fd⁣e')).toBe('a[Bbcde');
  });

  it('expects the prompt back without its trailing whitespace, as the agent trims it', () => {
    expect(promptAsTaken('  two leading spaces')).toBe('  two leading spaces');
    expect(promptAsTaken('trailing  \n\n')).toBe('trailing');
    expect(promptAsTaken('tab at the end\t')).toBe('tab at the end');
  });
});

describe('the writes of a typed text', () => {
  it('writes each line in chunks of at most 200 characters, a line break between lines', () => {
    const long = 'x'.repeat(450);
    expect(promptWrites(`${long}\n\nend`)).toEqual([
      { text: 'x'.repeat(200) },
      { text: 'x'.repeat(200) },
      { text: 'x'.repeat(50) },
      { keys: ['M-Enter'] },
      { keys: ['M-Enter'] },
      { text: 'end' },
    ]);
  });

  it('counts characters, never splitting one', () => {
    const text = '😀'.repeat(WRITE_LENGTH + 1);
    const writes = promptWrites(text);
    expect(writes).toEqual([{ text: '😀'.repeat(WRITE_LENGTH) }, { text: '😀' }]);
  });
});

describe('typing a prompt into the input box', () => {
  it('types into an empty box, presses no Down, and leaves the box empty after', async () => {
    const { box, outcome } = await typeInto({}, 'hello');

    expect(outcome).toBe('taken');
    expect(box.taken).toEqual(['hello']);
    expect(box.writes.filter((write) => write.includes('Down'))).toEqual([]);
    expect(box.text()).toBe('');
  });

  it('stashes a draft and puts it back, the cursor at its end', async () => {
    const { box, outcome } = await typeInto({ draft: 'my draft\nsecond line' }, 'the prompt');

    expect(outcome).toBe('taken');
    expect(box.taken).toEqual(['the prompt']);
    expect(box.text()).toBe('my draft\nsecond line');
    expect(box.cursor()).toBe(box.text().length);
  });

  it('presses Down only as many times as rows below the cursor, never past the last', async () => {
    const draft = lines(5);
    const { box } = await typeInto({ draft, cursor: 3 }, 'p');

    expect(box.writes.filter((write) => write.startsWith('Down'))).toEqual(['Down Down Down Down']);
    expect(box.downsPastTheEnd).toBe(0);
    expect(box.text()).toBe(draft);
  });

  it('counts the rows of wrapped lines and those a scrolled box hides', async () => {
    const draft = lines(25, 300);
    const { box, outcome } = await typeInto({ draft, cursor: 20, width: 118, window: 15 }, 'p');

    expect(outcome).toBe('taken');
    expect(box.downsPastTheEnd).toBe(0);
    expect(box.text()).toBe(draft);
  });

  it('kills an empty box at least once, so that the restore yanks no earlier kill', async () => {
    const box = inputBoxModel({ draft: 'old draft' });
    const clock = testClock();
    // The person killed a draft before: the kill ring holds it.
    await box.terminal.pressKeys(['C-u']);

    expect(await typePromptAt(clock, 'p', box.terminal)).toBe('taken');
    expect(box.text()).toBe('');
  });

  it('leaves shell mode before typing, and turns it on again with the draft', async () => {
    const { box, outcome } = await typeInto(
      { draft: 'echo shell-draft', shellMode: true },
      'a prompt',
    );

    expect(outcome).toBe('taken');
    expect(box.ranInShell).toEqual([]);
    expect(box.taken).toEqual(['a prompt']);
    expect(box.inShellMode()).toBe(true);
    expect(box.text()).toBe('echo shell-draft');
  });

  it('leaves shell mode with nothing in it, and turns it on again', async () => {
    const { box } = await typeInto({ shellMode: true }, 'a prompt');

    expect(box.taken).toEqual(['a prompt']);
    expect(box.inShellMode()).toBe(true);
    expect(box.text()).toBe('');
  });

  it('types a leading ! after a space, keeping the input out of shell mode', async () => {
    const { box } = await typeInto({}, '!not a command');

    expect(box.taken).toEqual([' !not a command']);
    expect(box.ranInShell).toEqual([]);
  });

  it('types line breaks as ESC CR and writes 50 ms apart', async () => {
    const { box, clock } = await typeInto({}, 'one\ntwo');

    expect(box.taken).toEqual(['one\ntwo']);
    const typed = box.writes.slice(box.writes.indexOf('text:one'), box.writes.indexOf('Enter'));
    expect(typed).toEqual(['text:one', 'M-Enter', 'text:two']);
    expect(clock.pauses.filter((ms) => ms === WRITE_GAP_MS)).toHaveLength(2);
  });

  it('takes a prompt whose trailing whitespace the agent trimmed', async () => {
    const { outcome } = await typeInto({}, 'trailing spaces  \n');

    expect(outcome).toBe('taken');
  });

  it('presses Enter again while the prompt stays in the box', async () => {
    const { box, outcome } = await typeInto({ draft: 'draft', lostEnters: 2 }, 'p');

    expect(outcome).toBe('taken');
    expect(box.writes.filter((write) => write === 'Enter')).toHaveLength(3);
    expect(box.text()).toBe('draft');
  });

  it('gives up after three Enters: the box cleared, the draft put back past the prompt', async () => {
    const { box, outcome } = await typeInto({ draft: 'my draft\nline two', lostEnters: 3 }, 'p');

    expect(outcome).toBe('not-taken');
    expect(box.taken).toEqual([]);
    expect(box.writes.filter((write) => write === 'Enter')).toHaveLength(3);
    expect(box.text()).toBe('my draft\nline two');
  });

  it('yanks no earlier kill of the person’s when the kills took nothing: nothing typed, the draft as it was', async () => {
    const { box, outcome } = await typeInto(
      { draft: 'my draft', killRing: ['old kill'], lostKills: 2 },
      'p',
    );

    expect(outcome).toBe('no-input-box');
    expect(box.writes).not.toContain('C-y');
    expect(box.text()).toBe('my draft');
  });

  it('types nothing into an entry recalled from the history', async () => {
    const { box, outcome } = await typeInto({ draft: 'past prompt', recalled: true }, 'p');

    expect(outcome).toBe('no-input-box');
    expect(box.writes).toEqual([]);
  });

  it('types nothing where a dialog replaced the box', async () => {
    const box = inputBoxModel({ draft: 'draft' });
    box.showDialog();

    expect(await typePromptAt(testClock(), 'p', box.terminal)).toBe('no-input-box');
    expect(box.writes).toEqual([]);
  });

  it('stops where the core refuses a write, a dialog drawn meanwhile: nothing of the person’s lost on an empty box', async () => {
    const box = inputBoxModel({ dialogAfterWrites: 4 });

    expect(await typePromptAt(testClock(), 'a long prompt', box.terminal)).toBe('no-input-box');
    expect(box.taken).toEqual([]);
  });
});

describe('a typing the core stopped', () => {
  const SENTINEL = '⁣';

  it('puts the draft back while the box still shows, the prompt typed so far cleared', async () => {
    // C-e, the sentinel, C-u, the prompt: then a turn the agent began stops the typing.
    const { box, outcome } = await typeInto({ draft: 'my draft', stopAfterWrites: 4 }, 'p');

    expect(outcome).toBe('no-input-box');
    expect(box.taken).toEqual([]);
    expect(box.writes.slice(4)).toEqual(['C-u', 'C-y M-y', 'BSpace']);
    expect(box.text()).toBe('my draft');
  });

  it('takes the sentinel off a draft it had not killed yet', async () => {
    const { box, outcome } = await typeInto({ draft: 'my draft', stopAfterWrites: 2 }, 'p');

    expect(outcome).toBe('no-input-box');
    expect(box.text()).toBe('my draft');
  });

  it('puts the shell mode it left back with the draft', async () => {
    // C-e, the sentinel, C-u, the C-u that leaves shell mode, the prompt.
    const { box } = await typeInto(
      { draft: 'echo draft', shellMode: true, stopAfterWrites: 5 },
      'p',
    );

    expect(box.inShellMode()).toBe(true);
    expect(box.text()).toBe('echo draft');
  });

  it('types nothing more once a dialog replaced the box, and says the draft is the kill ring’s last entry', async () => {
    const { box, outcome } = await typeInto({ draft: 'my draft', dialogAfterWrites: 4 }, 'p');

    expect(outcome).toEqual({ draftLeft: expect.stringMatching(/kill ring.*Ctrl\+Y/) });
    expect(outcome).not.toEqual({ draftLeft: expect.stringContaining('Alt+Y') });
    expect(outcome).toEqual({ draftLeft: expect.stringContaining('typed of the prompt') });
    expect(box.writes).toHaveLength(4);
    expect(box.killRing().at(-1)).toBe(`my draft${SENTINEL}`);
  });

  it('says the draft is the entry before the last once the prompt was killed after it', async () => {
    const { box, outcome } = await typeInto(
      { draft: 'my draft', stopAfterWrites: 4, dialogAfterWrites: 5 },
      'p',
    );

    expect(outcome).toEqual({ draftLeft: expect.stringContaining('Ctrl+Y, then Alt+Y') });
    expect(box.killRing().slice(-2)).toEqual([`my draft${SENTINEL}`, 'p']);
  });

  it('counts the prompt taken when the draft could not be put back after it', async () => {
    // C-e, the sentinel, C-u, the prompt, Enter: the prompt's turn draws a dialog at once.
    const { box, outcome } = await typeInto({ draft: 'my draft', dialogAfterWrites: 5 }, 'p');

    expect(outcome).toBe('taken');
    expect(box.taken).toEqual(['p']);
  });

  it('lets through what the core refuses with nothing but a stop', async () => {
    const box = inputBoxModel({ draft: 'my draft' });
    const failing = {
      ...box.terminal,
      typeText: () => Promise.reject(new Error('The host failed.')),
    };

    await expect(typePromptAt(testClock(), 'p', failing)).rejects.toThrow('The host failed.');
  });
});
