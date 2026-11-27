import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { readScreen } from '../../src/claude-code/screen-reading.ts';
import type { TerminalScreen } from '../../src/server/driver.ts';
import type { AgentSession } from '../support/agent-session.ts';
import { fakeAgentCommand } from '../support/fake-agent/launching.ts';
import type { Question, ReplyStep, ToolStep } from '../support/fake-agent/script.ts';
import { INTERRUPTED } from '../support/fake-agent/transcript.ts';
import { pinnedAgentBinary } from '../support/real-agent/binary.ts';
import { answerYes, pressOnDialog } from './dialog-keys.ts';
import { submitInputBox, submitPrompt, userTexts } from './harness.ts';
import { hooksOfBothAgents, type ParityAgent, type Scenario } from './parity-agents.ts';

/**
 * The fake agent is held to the real one here: each scenario is played once
 * on each, and what their hooks said must agree. A difference is closed in
 * the fake agent, which plays it or refuses it; never in the comparison.
 */

/** A shell command that needs nothing and prints nothing, with what the real agent says of it once it ran. */
function touch(file: string): ToolStep {
  return {
    do: 'tool',
    name: 'Bash',
    input: { command: `touch ${file}` },
    response: {
      stdout: '',
      stderr: '',
      interrupted: false,
      isImage: false,
      noOutputExpected: true,
    },
    result: '(Bash completed with no output)',
  };
}

const fruit: Question = {
  question: 'Which fruit?',
  header: 'Fruit',
  options: [
    { label: 'Mango', description: 'Sweet.' },
    { label: 'Lime', description: 'Sour.' },
  ],
  multiSelect: false,
};

function reply(text: string): ReplyStep {
  return { do: 'reply', text };
}

/** Waits for the end of a turn that replied: the reply shown and the turn's end, each by its hook. */
async function turnEnded(agent: ParityAgent): Promise<void> {
  await agent.hook('MessageDisplay');
  await agent.hook('Stop');
}

/** Ends a session by SIGTERM, and waits for the two hooks that tell of it: the post and the command. */
async function terminated(agent: ParityAgent, session: AgentSession): Promise<void> {
  await agent.end(session, 'SIGTERM');
  await agent.hook('SessionEnd');
  await agent.hook('SessionEnd');
}

/**
 * Waits until a session shows a start-up dialog, by a text of it, and
 * observes what the driver reads of the screen then: the two agents' must
 * be read alike.
 */
async function shows(agent: ParityAgent, session: AgentSession, text: string): Promise<void> {
  const screen = await agent.eventually(async () => {
    const shown = await session.screen();
    expect(shown).toContain(text);
    return shown;
  });
  agent.observe(
    `the screen that shows ${JSON.stringify(text)}, as the driver reads it`,
    readScreen(screen),
  );
}

const TRUST_DIALOG = 'Accessing workspace:';
const BYPASS_WARNING = 'WARNING: Claude Code running in Bypass Permissions mode';
const KEY_QUESTION = 'Do you want to use this API key?';

/** Leaves at a start-up dialog with a key, and waits until the session is gone. */
async function leaveAt(agent: ParityAgent, session: AgentSession, key: string): Promise<void> {
  const left = agent.exits(session);
  await pressOnDialog(session, key, (screen) => screen === undefined);
  await left;
}

/** Runs `/compact` as a person types it, and waits for the hook that tells it was taken. */
async function compactCommand(agent: ParityAgent, session: AgentSession): Promise<void> {
  await session.type('/compact');
  await submitInputBox(agent, session, (box) => box.trim() === '/compact', 'PreCompact');
}

function permissionDecision(decision: object): object {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

/** The character the driver marks the end of a person's draft with: never drawn. */
const SEPARATOR = '\u2063';

/** A rule of the input box: plain, or saying what the box hides or which history entry it shows. */
const BOX_RULE = /^─+$|^─── (?:[↑↓] \d+ more|History \d+\/\d+) ─+$/;

/** The input box as a screen draws it, and where the terminal's cursor is, its row counted from the rule above the box. */
interface BoxSeen {
  /** The rule above the box, its rows, the rule below and the first row of the footer. */
  readonly rows: string[];
  readonly cursor: { readonly row: number; readonly column: number };
}

/** Reads the input box of a screen; `undefined` when it shows none, as while a dialog takes its place. */
function drawnBox({ text, cursor }: TerminalScreen): BoxSeen | undefined {
  const rows = text.split('\n').map((row) => row.trimEnd());
  const bottom = rows.findLastIndex((row) => BOX_RULE.test(row));
  const top = rows.slice(0, Math.max(bottom, 0)).findLastIndex((row) => BOX_RULE.test(row));
  if (top === -1) return undefined;
  return {
    rows: rows.slice(top, bottom + 2),
    cursor: { row: cursor.row - top, column: cursor.column },
  };
}

/**
 * Waits until the input box drawn passes a check, and gives it. The real
 * agent writes a screen in several writes, which tmux may show half done
 * under load: a box counts once two reads in a row found it the same.
 */
function boxShowing(
  agent: ParityAgent,
  session: AgentSession,
  check: (rows: readonly string[], cursor: BoxSeen['cursor']) => boolean,
): Promise<BoxSeen> {
  let lastRead: string | undefined;
  return agent.eventually(async () => {
    const box = drawnBox(await session.screenWithCursor());
    const read = JSON.stringify(box);
    const settled = read === lastRead;
    lastRead = read;
    expect(box !== undefined && settled && check(box.rows, box.cursor)).toBe(true);
    return box as BoxSeen;
  });
}

/** Waits until the input box drawn shows a row, and observes it, with the cursor. */
async function observeBox(
  agent: ParityAgent,
  session: AgentSession,
  what: string,
  row: string | RegExp | ((shown: string) => boolean),
): Promise<void> {
  const matches = (shown: string) => {
    if (typeof row === 'string') return shown === row;
    return row instanceof RegExp ? row.test(shown) : row(shown);
  };
  agent.observe(what, await boxShowing(agent, session, (rows) => rows.some(matches)));
}

/** Presses keys, then waits until the input box drawn is no longer what it was, and gives it. */
async function pressUntilRedrawn(
  agent: ParityAgent,
  session: AgentSession,
  ...keys: string[]
): Promise<BoxSeen> {
  const before = JSON.stringify((await boxShowing(agent, session, () => true)).rows);
  await session.press(...keys);
  return boxShowing(agent, session, (rows) => JSON.stringify(rows) !== before);
}

/** Types a text as a person does, a line break as ESC CR. */
async function typeAsAPerson(session: AgentSession, text: string): Promise<void> {
  for (const [index, line] of text.split('\n').entries()) {
    if (index > 0) await session.press('Escape', 'Enter');
    if (line !== '') await session.type(line);
  }
}

/** The rows of the box drawn between its rules: its text, the sign first. */
function rowsInside(box: readonly string[]): string[] {
  return box.slice(
    1,
    box.findLastIndex((row) => BOX_RULE.test(row)),
  );
}

/** Whether the box drawn shows no text: between its rules, one row, the sign alone. */
function looksEmpty(box: readonly string[]): boolean {
  const rows = rowsInside(box);
  return rows.length === 1 && /^[❯!]$/.test(rows[0] ?? '');
}

/**
 * Whether the box drawn holds a whole text, whatever blanks and breaks its
 * wrapping drew: the sign and its blank left out.
 */
function holdsText(box: readonly string[], text: string): boolean {
  const bare = (drawn: string) => drawn.replace(/\s+/gu, '');
  const shown = rowsInside(box)
    .join('\n')
    .replace(/^[❯!]\s/u, '');
  return bare(shown) === bare(text);
}

/**
 * Types a prompt over the person's draft as the driver does, and observes
 * the box at each step: Down to the last row, Ctrl+E, the separator, Ctrl+U
 * until the box shows no text, the prompt, Enter (confirmed), then Ctrl+Y
 * and Backspace. The draft is then submitted, for its text to be compared.
 */
async function typeOverTheDraft(
  agent: ParityAgent,
  session: AgentSession,
  prompt: string,
  rowsBelowTheCursor: number,
): Promise<void> {
  if (rowsBelowTheCursor > 0) await session.press(...Array(rowsBelowTheCursor).fill('Down'));
  await session.press('C-e');
  // Every kill is told by what it redraws: the keys before must have been drawn first.
  await boxShowing(agent, session, cursorAtTheEnd);
  await session.type(SEPARATOR);
  let kills = 0;
  let box: BoxSeen;
  do {
    box = await pressUntilRedrawn(agent, session, 'C-u');
    kills += 1;
    if (kills === 1 || kills === 5) agent.observe(`the box after kill ${kills}`, box);
  } while (!looksEmpty(box.rows));
  agent.observe('the kills that emptied the box', kills);
  await typeAsAPerson(session, prompt);
  // Typed in several writes: a box drawn halfway would already show some of its last characters.
  agent.observe(
    'the box with the prompt typed',
    await boxShowing(agent, session, (box) => holdsText(box, prompt)),
  );
  await submitInputBox(agent, session, (text) => text.trim() !== '');
  await turnEnded(agent);
  await session.press('C-y');
  agent.observe('the box restored', await boxShowing(agent, session, (box) => !looksEmpty(box)));
  await session.press('BSpace');
  await submitInputBox(agent, session, (text) => text.trim() !== '');
  await turnEnded(agent);
}

/** Whether the cursor is at the end of the box's last row, nothing hidden below it. */
function cursorAtTheEnd(rows: readonly string[], cursor: BoxSeen['cursor']): boolean {
  const lastRow = rows.length - 3;
  return (
    !rows.at(-2)?.includes('more') &&
    cursor.row === lastRow &&
    cursor.column === Array.from(rows[lastRow] ?? '').length
  );
}

/** A person's draft of numbered lines, each with as many letters after it as asked. */
function draftLines(count: number, letters = 0): string {
  const tail =
    letters > 0 ? ` ${'abcdefghij'.repeat(Math.ceil(letters / 10)).slice(0, letters)}` : '';
  return Array.from(
    { length: count },
    (_, i) => `draft line ${String(i + 1).padStart(2, '0')}${tail}`,
  ).join('\n');
}

/** Seventy words of nine characters: one line over six rows of the box. */
const LONG_LINE = Array.from({ length: 70 }, (_, i) => `word${String(i).padStart(3, '0')}x`).join(
  ' ',
);

/** Launches a resume of a conversation with no transcript, and waits for it to leave and say so. */
async function resumesNothing(agent: ParityAgent, sessionId: string): Promise<void> {
  const resumed = await agent.resume(sessionId);
  await agent.exits(resumed);
  await agent.hook('SessionEnd');
  await agent.hook('SessionEnd');
}

/**
 * States that the two agents agree on a scenario. The scenarios are played
 * alongside each other: each has receivers, folders and tmux sockets of its own.
 */
function agreeOn(title: string, scenario: Scenario): void {
  it.concurrent(title, async ({ onTestFinished, task }) => {
    const { real, fake } = await hooksOfBothAgents(scenario, onTestFinished, task.meta);
    expect(fake).toEqual(real);
  });
}

agreeOn('a prompt on the command line, answered with one line', {
  script: [[reply('One line.')]],
  async play(agent) {
    const session = await agent.startNew({ prompt: 'say one line' });
    await turnEnded(agent);
    await terminated(agent, session);
  },
});

agreeOn('a prompt on the command line that looks like options, after --', {
  script: [[reply('Read as a prompt.')]],
  async play(agent) {
    const session = await agent.startNew({
      prompt: '-p --permission-mode bypassPermissions --model opus',
    });
    await turnEnded(agent);
    await terminated(agent, session);
  },
});

agreeOn('a typed prompt, answered after a tool call that needs no permission', {
  script: [[touch('a.txt'), reply('Touched.')]],
  async play(agent) {
    const session = await agent.startNew();
    await agent.hook('SessionStart');
    await submitPrompt(agent, session, 'touch it');
    await turnEnded(agent);
    await terminated(agent, session);
  },
});

agreeOn('two tool calls that need permission: one allowed through PermissionRequest, one denied', {
  script: [[touch('a.txt'), touch('b.txt'), reply('One of the two.')]],
  permissions: {},
  async play(agent) {
    agent.hooks.hold('PermissionRequest');
    const session = await agent.startNew({ prompt: 'touch both' });
    (await agent.hook('PermissionRequest')).answer(permissionDecision({ behavior: 'allow' }));
    (await agent.hook('PermissionRequest')).answer(
      permissionDecision({ behavior: 'deny', message: 'Not that one.' }),
    );
    await turnEnded(agent);
    await terminated(agent, session);
  },
});

agreeOn('a question, answered through PreToolUse with the answers in updatedInput', {
  script: [[{ do: 'question', questions: [fruit] }, reply('Lime it is.')]],
  async play(agent) {
    agent.hooks.hold('PreToolUse');
    const session = await agent.startNew({ prompt: 'ask me' });
    (await agent.hook('PreToolUse')).answer({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { questions: [fruit], answers: { [fruit.question]: 'Lime' } },
      },
    });
    await turnEnded(agent);
    await terminated(agent, session);
  },
});

agreeOn('Esc during a turn that has run a tool, then a prompt', {
  script: [[touch('a.txt'), { do: 'stay-busy' }], [reply('Going on.')]],
  async play(agent) {
    const session = await agent.startNew();
    await agent.hook('SessionStart');
    await submitPrompt(agent, session, 'touch, then think');
    await agent.staysBusy(session);
    await session.press('Escape');
    await agent.eventually(() => expect(userTexts(session)).toContain(INTERRUPTED));
    // The barrier: a hook of the interrupted turn would come before this prompt's own.
    await submitPrompt(agent, session, 'go on');
    await turnEnded(agent);
    // The marker, among the transcript's other texts of the person's side.
    await agent.eventually(() => expect(userTexts(session)).toContain('go on'));
    agent.observe('the texts of the transcript', userTexts(session));
    await terminated(agent, session);
  },
});

agreeOn('the resume of a conversation, then a prompt', {
  script: [[reply('The earlier answer.')], [reply('The later answer.')]],
  async play(agent) {
    const session = await agent.startNew({ prompt: 'the earlier prompt' });
    await agent.hook('SessionStart');
    await agent.hook('UserPromptSubmit');
    await turnEnded(agent);
    await terminated(agent, session);
    const resumed = await agent.resume(session.id);
    await agent.hook('SessionStart');
    await submitPrompt(agent, resumed, 'the later prompt');
    await turnEnded(agent);
    await terminated(agent, resumed);
  },
});

agreeOn('the end by SIGTERM of a session that took no prompt', {
  script: [],
  async play(agent) {
    const session = await agent.startNew();
    await agent.hook('SessionStart');
    await terminated(agent, session);
  },
});

agreeOn('the trust dialog answered Yes, then the launch prompt; the next start asks nothing', {
  script: [[reply('Trusted.')]],
  leftOutOfRecipe: ['folder-trust'],
  async play(agent) {
    const session = await agent.startNew({ prompt: 'say one line' });
    await shows(agent, session, TRUST_DIALOG);
    await answerYes(session, TRUST_DIALOG, 'Down');
    await agent.hook('SessionStart');
    await turnEnded(agent);
    await terminated(agent, session);
    const again = await agent.startNew();
    await agent.hook('SessionStart');
    await terminated(agent, again);
  },
});

agreeOn('the trust dialog left by Enter on its "No, exit", then by Esc: no hook', {
  script: [],
  leftOutOfRecipe: ['folder-trust'],
  async play(agent) {
    for (const key of ['Enter', 'Escape']) {
      const session = await agent.startNew({ prompt: 'say one line' });
      await shows(agent, session, TRUST_DIALOG);
      await leaveAt(agent, session, key);
    }
  },
});

agreeOn('the warning of bypassPermissions left by Enter, then by Esc: SessionEnd each time', {
  script: [],
  async play(agent) {
    for (const key of ['Enter', 'Escape']) {
      const session = await agent.startNew({
        prompt: 'say one line',
        permissionMode: 'bypassPermissions',
      });
      await shows(agent, session, BYPASS_WARNING);
      await leaveAt(agent, session, key);
      await agent.hook('SessionEnd');
      await agent.hook('SessionEnd');
    }
  },
});

agreeOn(
  'the warning of bypassPermissions accepted, then the launch prompt; the next start warns no more',
  {
    script: [[reply('Accepted.')]],
    async play(agent) {
      const permissionMode = 'bypassPermissions';
      const session = await agent.startNew({ prompt: 'say one line', permissionMode });
      await shows(agent, session, BYPASS_WARNING);
      await answerYes(session, BYPASS_WARNING, 'Down');
      await agent.hook('SessionStart');
      await turnEnded(agent);
      await terminated(agent, session);
      const again = await agent.startNew({ permissionMode });
      await agent.hook('SessionStart');
      await terminated(agent, again);
    },
  },
);

agreeOn('the trust dialog answered Yes, then the warning of bypassPermissions left', {
  script: [],
  leftOutOfRecipe: ['folder-trust'],
  async play(agent) {
    const session = await agent.startNew({
      prompt: 'say one line',
      permissionMode: 'bypassPermissions',
    });
    await shows(agent, session, TRUST_DIALOG);
    await answerYes(session, TRUST_DIALOG, 'Down');
    await shows(agent, session, BYPASS_WARNING);
    await leaveAt(agent, session, 'Enter');
    await agent.hook('SessionEnd');
    await agent.hook('SessionEnd');
  },
});

agreeOn('the question about the API key answered No, then a prompt fails on the login', {
  script: [],
  leftOutOfRecipe: ['key-approval'],
  async play(agent) {
    const session = await agent.startNew();
    await shows(agent, session, KEY_QUESTION);
    await pressOnDialog(session, 'Enter', (screen) => !screen?.includes(KEY_QUESTION));
    await agent.hook('SessionStart');
    await submitPrompt(agent, session, 'say one line');
    await agent.hook('StopFailure');
    await terminated(agent, session);
  },
});

agreeOn('the question about the API key answered Yes, then the launch prompt', {
  script: [[reply('With the key.')]],
  leftOutOfRecipe: ['key-approval'],
  async play(agent) {
    const session = await agent.startNew({ prompt: 'say one line' });
    await shows(agent, session, KEY_QUESTION);
    await answerYes(session, KEY_QUESTION, 'Up');
    await turnEnded(agent);
    await terminated(agent, session);
  },
});

agreeOn('turns that fail on errors of the API, one of each kind, then a turn that answers', {
  script: [
    [{ do: 'fail', status: 529 }],
    [{ do: 'fail', status: 500 }],
    [{ do: 'fail', status: 429 }],
    [{ do: 'fail', status: 401 }],
    [touch('a.txt'), { do: 'fail', status: 403 }],
    [reply('Answered.')],
  ],
  async play(agent) {
    const session = await agent.startNew({ prompt: 'the first' });
    await agent.hook('UserPromptSubmit');
    await agent.hook('StopFailure');
    for (const prompt of ['the second', 'the third', 'the fourth', 'the fifth']) {
      await submitPrompt(agent, session, prompt);
      await agent.hook('StopFailure');
    }
    await submitPrompt(agent, session, 'the last');
    await turnEnded(agent);
    await terminated(agent, session);
  },
});

agreeOn('/compact after a turn', {
  script: [[reply('Something to compact.')], [{ do: 'compact', summary: 'The summary.' }]],
  async play(agent) {
    const session = await agent.startNew({ prompt: 'say one line' });
    await turnEnded(agent);
    await compactCommand(agent, session);
    await agent.hook('PostCompact');
    await terminated(agent, session);
  },
});

agreeOn('a task in the background: Stop lists it, its calls name it, its end starts a turn', {
  script: [
    [
      {
        do: 'task',
        description: 'Count files',
        prompt: 'Count the files.',
        agentType: 'general-purpose',
        work: [touch('inner.txt'), reply('Counted.')],
      },
      reply('Started.'),
    ],
    [reply('Noted.')],
  ],
  async play(agent) {
    const session = await agent.startNew({ prompt: 'start a task' });
    await turnEnded(agent);
    await agent.releaseTask();
    await agent.hook('SubagentStop');
    await turnEnded(agent);
    await terminated(agent, session);
  },
});

agreeOn(
  'a draft of 25 lines, the cursor up in it: stashed row by row, the prompt taken, the draft back whole',
  {
    script: [[reply('Taken.')], [reply('The draft.')]],
    async play(agent) {
      const session = await agent.startNew();
      await agent.hook('SessionStart');
      await typeAsAPerson(session, draftLines(25));
      await session.press(...Array(10).fill('Up'));
      await observeBox(agent, session, 'the draft, the cursor 10 rows up', /↓ 3 more/);
      await typeOverTheDraft(agent, session, 'the prompt over 25 lines', 10);
      await terminated(agent, session);
    },
  },
);

agreeOn('a draft of one line over six rows: Ctrl+U kills one row at a time', {
  script: [[reply('Taken.')], [reply('The draft.')]],
  async play(agent) {
    const session = await agent.startNew();
    await agent.hook('SessionStart');
    await session.type(LONG_LINE);
    await observeBox(agent, session, 'the long line', /word069x$/);
    await session.press('Up', 'Up', 'Up');
    await typeOverTheDraft(agent, session, 'the prompt over a long line', 3);
    await terminated(agent, session);
  },
});

agreeOn(
  'a draft of five lines that each wrap, the cursor at the top, under a prompt of several lines',
  {
    script: [[reply('Taken.')], [reply('The draft.')]],
    async play(agent) {
      const session = await agent.startNew();
      await agent.hook('SessionStart');
      await typeAsAPerson(session, draftLines(5, 280));
      const typed = await boxShowing(
        agent,
        session,
        (box) =>
          box.some((row) => row.startsWith('  draft line 05')) && /^ {2}ij/.test(box.at(-3) ?? ''),
      );
      agent.observe('the wrapped lines', typed);
      await session.press(...Array(14).fill('Up'));
      const prompt = `line one\n\n    indented line three\nlast line ${'z'.repeat(300)}`;
      await typeOverTheDraft(agent, session, prompt, 14);
      await terminated(agent, session);
    },
  },
);

const PROMPTS_AT_THE_EDGES = [
  '  two leading spaces',
  'two trailing spaces  ',
  'a trailing line break\n',
  '\na leading line break',
  'a\ttab',
  `${SEPARATOR}the separator first`,
  `the separator last${SEPARATOR}`,
];

agreeOn(
  'typed prompts: blanks and line breaks trimmed at the end, kept at the start; a tab dropped; the separator dropped',
  {
    script: PROMPTS_AT_THE_EDGES.map(() => [reply('Taken.')]),
    async play(agent) {
      const session = await agent.startNew();
      await agent.hook('SessionStart');
      for (const prompt of PROMPTS_AT_THE_EDGES) {
        await typeAsAPerson(session, prompt);
        await submitInputBox(agent, session, (text) => text.trim() !== '');
        await turnEnded(agent);
      }
      await terminated(agent, session);
    },
  },
);

agreeOn(
  'the history of prompts: Up shows them, History n/m on the rule; Down back to the draft; an entry edited is lost',
  {
    script: [[reply('One.')], [reply('Two.')], [reply('Three.')]],
    async play(agent) {
      const session = await agent.startNew({ prompt: 'launch prompt' });
      await agent.hook('UserPromptSubmit');
      await turnEnded(agent);
      await submitPrompt(agent, session, 'typed prompt');
      await turnEnded(agent);
      await typeAsAPerson(session, 'm1\nm2\nm3');
      await submitInputBox(agent, session, (text) => text.includes('m1'));
      await turnEnded(agent);
      await session.type('dr');
      await observeBox(agent, session, 'the draft', '❯\u00a0dr');
      const steps: [keys: string[], row: string][] = [
        [['Up'], '─── History 3/3 '],
        [['Up', 'Up', 'Up'], '─── History 2/3 '],
        [['Up', 'Up'], '─── History 1/3 '],
        [['Down'], '─── History 2/3 '],
        [['Down', 'Down', 'Down', 'Down'], '❯\u00a0dr'],
      ];
      for (const [keys, row] of steps) {
        await session.press(...keys);
        await observeBox(
          agent,
          session,
          `after ${keys.join(' ')}, the box shows ${row}`,
          (shown: string) => shown.startsWith(row),
        );
      }
      await session.type('X');
      await observeBox(agent, session, 'the draft back, the cursor at its start', '❯\u00a0Xdr');
      await session.press('Up');
      await session.type(' EDITED');
      await observeBox(agent, session, 'the newest entry, edited', '  m3 EDITED');
      await session.press('Down');
      await observeBox(agent, session, 'the draft again, the edit lost', '❯\u00a0Xdr');
      await terminated(agent, session);
    },
  },
);

agreeOn(
  'shell mode: a ! into an empty box turns it on; Backspace or Ctrl+U on the empty box turns it off; the kill ring kept',
  {
    script: [],
    async play(agent) {
      const session = await agent.startNew();
      await agent.hook('SessionStart');
      const steps: [typed: string | string[], row: string][] = [
        ['!', '!'],
        [['BSpace'], '❯'],
        ['!', '!'],
        ['ls', '!\u00a0ls'],
        [['C-u'], '!'],
        [['C-u'], '❯'],
        ['!', '!'],
        [['C-y'], '!\u00a0ls'],
        [['BSpace'], '!\u00a0l'],
      ];
      for (const [typed, row] of steps) {
        if (Array.isArray(typed)) await session.press(...typed);
        else await session.type(typed);
        await observeBox(
          agent,
          session,
          `after ${JSON.stringify(typed)}, the box shows ${row}`,
          row,
        );
      }
      await terminated(agent, session);
    },
  },
);

agreeOn('the kill ring: Ctrl+Y yanks the last kill, Alt+Y right after it the kill before', {
  script: [],
  async play(agent) {
    const session = await agent.startNew();
    await agent.hook('SessionStart');
    const steps: [typed: string | string[], row: string][] = [
      ['the draft', '❯\u00a0the draft'],
      [['C-u'], '❯'],
      ['the prompt', '❯\u00a0the prompt'],
      [['C-u'], '❯'],
      [['C-y'], '❯\u00a0the prompt'],
      [['M-y'], '❯\u00a0the draft'],
    ];
    for (const [typed, row] of steps) {
      if (Array.isArray(typed)) await session.press(...typed);
      else await session.type(typed);
      await observeBox(agent, session, `after ${JSON.stringify(typed)}, the box shows ${row}`, row);
    }
    await terminated(agent, session);
  },
});

agreeOn(
  '--resume of a conversation that never took a prompt, then of one whose transcript is gone: SessionEnd, no SessionStart',
  {
    script: [[reply('Before it was gone.')]],
    async play(agent) {
      const unprompted = await agent.startNew();
      await agent.hook('SessionStart');
      await terminated(agent, unprompted);
      await resumesNothing(agent, unprompted.id);
      const prompted = await agent.startNew({ prompt: 'say one line' });
      await agent.hook('MessageDisplay');
      const stop = await agent.hook('Stop');
      await terminated(agent, prompted);
      rmSync(stop.payload.transcript_path as string);
      await resumesNothing(agent, prompted.id);
    },
  },
);

agreeOn(
  'text typed as a permission dialog comes: into the box until the dialog is drawn, ignored on it',
  {
    script: [[touch('a.txt'), reply('Touched.')]],
    permissions: {},
    async play(agent) {
      agent.hooks.hold('PreToolUse');
      agent.hooks.hold('PermissionRequest');
      const session = await agent.startNew();
      await agent.hook('SessionStart');
      await submitPrompt(agent, session, 'touch it');
      // Keys typed once PermissionRequest came may beat the dialog or not: under load the real
      // agent takes them on a dialog not drawn yet. While PreToolUse waits, nothing is asked yet.
      const before = await agent.hook('PreToolUse');
      await session.type('typed early');
      await observeBox(agent, session, 'the box as the call waits', '❯\u00a0typed early');
      before.answer({});
      const asked = await agent.hook('PermissionRequest');
      const dialogShown = await agent.eventually(async () => {
        const screen = await session.screenWithCursor();
        expect(drawnBox(screen)).toBeUndefined();
        return screen.text;
      });
      agent.observe('the screen with the dialog, as the driver reads it', readScreen(dialogShown));
      await session.type('typed on the dialog');
      asked.answer(permissionDecision({ behavior: 'allow' }));
      await turnEnded(agent);
      await observeBox(agent, session, 'the box after the turn', /typed/);
      await terminated(agent, session);
    },
  },
);

/**
 * Waits until the input box shows a draft, and observes what the driver
 * reads of the screen then: a busy agent's never ready, whatever the box holds.
 */
async function observeReadingOverDraft(
  agent: ParityAgent,
  session: AgentSession,
  what: string,
): Promise<void> {
  await boxShowing(agent, session, (rows) => rows.includes('❯\u00a0a draft'));
  agent.observe(what, readScreen(await session.screen()));
}

/**
 * Waits until the driver reads the screen as ready, the draft still in the
 * box: the agent's spinner stays a moment past the hook that ends its work.
 */
async function observeReadyOverDraft(
  agent: ParityAgent,
  session: AgentSession,
  what: string,
): Promise<void> {
  const box = await agent.eventually(async () => {
    expect(readScreen(await session.screen())).toEqual({ shows: 'ready' });
    return boxShowing(agent, session, (rows) => rows.includes('❯\u00a0a draft'));
  });
  agent.observe(what, box);
}

agreeOn(
  'a draft typed while a turn and a compaction run: the driver reads each screen as busy, then ready once each ended',
  {
    script: [[touch('a.txt'), reply('Touched.')], [{ do: 'compact', summary: 'The summary.' }]],
    async play(agent) {
      agent.hooks.hold('PreToolUse');
      agent.hooks.hold('PreCompact');
      const session = await agent.startNew();
      await agent.hook('SessionStart');
      await submitPrompt(agent, session, 'touch it');
      const call = await agent.hook('PreToolUse');
      await session.type('a draft');
      await observeReadingOverDraft(agent, session, 'the screen as the call waits');
      call.answer({});
      await turnEnded(agent);
      await observeReadyOverDraft(agent, session, 'the box after the turn');
      await pressUntilRedrawn(agent, session, 'C-u');
      await session.type('/compact');
      const begun = await submitInputBox(
        agent,
        session,
        (box) => box.trim() === '/compact',
        'PreCompact',
      );
      await session.type('a draft');
      await observeReadingOverDraft(agent, session, 'the screen as the compaction waits');
      begun.hook.answer({});
      await agent.hook('PostCompact');
      await observeReadyOverDraft(agent, session, 'the box after the compaction');
      await terminated(agent, session);
    },
  },
);

agreeOn(
  'a draft in the box as a background task ends: its turn starts by itself, the draft stays',
  {
    script: [
      [
        {
          do: 'task',
          description: 'Count files',
          prompt: 'Count the files.',
          agentType: 'general-purpose',
          work: [touch('inner.txt'), reply('Counted.')],
        },
        reply('Started.'),
      ],
      [reply('Noted.')],
    ],
    async play(agent) {
      const session = await agent.startNew({ prompt: 'start a task' });
      await turnEnded(agent);
      await session.type('my draft');
      await observeBox(agent, session, 'the box while the task runs', '❯\u00a0my draft');
      await agent.releaseTask();
      await agent.hook('SubagentStop');
      await turnEnded(agent);
      // Either agent works on until it has read Stop's answer, its busy footer drawn; once
      // the turn is over, the footer points to the subagents.
      agent.observe(
        'the box once the task turn ended',
        await boxShowing(agent, session, (rows) => rows.at(-1)?.includes('/tasks') === true),
      );
      agent.observe('the box emptied', await pressUntilRedrawn(agent, session, 'C-u'));
      await terminated(agent, session);
    },
  },
);

it('--version: the same line, and nothing else', async () => {
  const run = promisify(execFile);
  // Nothing of the person's: not their configuration folder, not their keys.
  const environment = { env: { PATH: '/usr/bin:/bin' } };
  const fake = fakeAgentCommand();
  const [real, ofFake] = await Promise.all([
    run(pinnedAgentBinary(), ['--version'], environment),
    run(fake.command, [...fake.args, '--version'], environment),
  ]);

  expect(ofFake).toEqual(real);
});
