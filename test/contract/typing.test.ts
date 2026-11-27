import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { ClaudeCodeOptions } from '../../src/claude-code/index.ts';
import { readInputBoxView } from '../../src/claude-code/screen-reading.ts';
import { typePrompt } from '../../src/claude-code/typing.ts';
import type { TypingOutcome } from '../../src/server/driver.ts';
import type { AgentSession } from '../support/agent-session.ts';
import { cameTrue, eventually } from '../support/eventually.ts';
import { type Turn, toolUse, turn } from '../support/fake-api/index.ts';
import { PATIENCE, POLL } from '../support/patience.ts';
import {
  type ContractCockpit,
  type ContractCockpitOptions,
  type HookPayload,
  SAID_KEY,
  sessionAfter,
  startContractCockpit,
} from './cockpit-harness.ts';
import { typingTerminal } from './typing-terminal.ts';

/**
 * The driver's typing of a prompt into the real agent's input box, over
 * what a person may have left there: each prompt must reach the agent's
 * `UserPromptSubmit` exactly, and the person's draft come back exactly.
 * Typed through a terminal that refuses a write unless the screen shows
 * the input box, as the core's does.
 */

/** Enough answers for every prompt a test submits: the scripted API fails on a request it has none for. */
const ANSWERS = 8;

/** A cockpit whose session is idle (or busy, as asked), its input box empty, the answers scripted. */
async function idleSession(
  options: ContractCockpitOptions & {
    readonly first?: readonly Turn[];
    readonly until?: 'idle' | 'busy';
  } = {},
): Promise<{ cockpit: ContractCockpit; session: AgentSession }> {
  const cockpit = await startContractCockpit(options);
  cockpit.api.script(
    ...(options.first ?? [turn('Ready.')]),
    ...Array.from({ length: ANSWERS }, () => turn('ok')),
  );
  await cockpit.say('get ready');
  await cockpit.sessionIn(SAID_KEY, options.until ?? 'idle');
  return { cockpit, session: cockpit.terminal(SAID_KEY) };
}

/** Types a draft as a person does, a line break as Alt+Enter, and waits until the box shows its end. */
async function typeDraft(session: AgentSession, draft: string): Promise<void> {
  for (const [index, line] of draft.split('\n').entries()) {
    if (index > 0) await session.press('M-Enter');
    if (line !== '') await session.type(line);
  }
  // A line wider than the box shows on several rows: its end is what the box ends with.
  const bare = (text: string) => text.replace(/\s+/gu, '');
  const end = bare(draft).slice(-100);
  await eventually(async () => {
    expect(bare(readInputBoxView(await session.screen())?.text ?? '').endsWith(end)).toBe(true);
  });
}

/** Where the cursor is in the draft: its row, those scrolled out above counted, and its column. */
async function cursorInDraft(session: AgentSession): Promise<{ row: number; column: number }> {
  const { text, cursor } = await session.screenWithCursor();
  const box = readInputBoxView(text);
  if (box === undefined) throw new Error(`No input box shows:\n${text}`);
  return { row: box.hiddenAbove + cursor.row - box.firstRow, column: cursor.column };
}

/**
 * Presses a key one time after another, as a person does, each once the
 * agent drew what the one before did: the cursor a row up, or a column
 * left on its row. Not merely once the screen changed: a hint or a status
 * line may change first, and the next key, or the driver's read, would
 * meet the cursor where it was.
 */
async function pressEach(session: AgentSession, key: 'Up' | 'Left', times: number): Promise<void> {
  for (let pressed = 0; pressed < times; pressed++) {
    const before = await cursorInDraft(session);
    const moved =
      key === 'Up'
        ? (now: typeof before) => now.row === before.row - 1
        : (now: typeof before) => now.row === before.row && now.column === before.column - 1;
    await session.press(key);
    await eventually(async () => expect(moved(await cursorInDraft(session))).toBe(true));
  }
}

/** What the driver's typing gave. */
interface Typed {
  readonly outcome: TypingOutcome;
  readonly writes: readonly string[];
  /** The prompts the session took while the driver typed. */
  readonly prompts: readonly unknown[];
}

/** Types a prompt as the driver does, then waits for the turn it started to end. */
async function typed(
  cockpit: ContractCockpit,
  session: AgentSession,
  prompt: string,
  lostEnters = 0,
): Promise<Typed> {
  const from = cockpit.timeline.length;
  const hooksFrom = cockpit.hooksRead.length;
  const terminal = typingTerminal({ session, hooksRead: cockpit.hooksRead, lostEnters });
  const outcome = await typePrompt(prompt, terminal);
  if (outcome === 'taken') await sessionAfter(cockpit, 'idle', from);
  return { outcome, writes: terminal.writes, prompts: promptsSince(cockpit, hooksFrom) };
}

function promptsSince(cockpit: ContractCockpit, from: number): unknown[] {
  return cockpit.hooksRead
    .slice(from)
    .map((request) => request.body as HookPayload)
    .filter((payload) => payload.hook_event_name === 'UserPromptSubmit')
    .map((payload) => payload.prompt);
}

/**
 * Submits what the box holds, Enter again while it stays there, and gives
 * the prompt the agent took: the draft put back, character for character.
 */
async function submitBox(cockpit: ContractCockpit, session: AgentSession): Promise<unknown> {
  const from = cockpit.hooksRead.length;
  const timeline = cockpit.timeline.length;
  const submitted = () => promptsSince(cockpit, from).length > 0;
  for (let enters = 1; enters <= 3; enters++) {
    await session.press('Enter');
    if (await cameTrue(submitted, PATIENCE.submit, POLL.hooks)) {
      await sessionAfter(cockpit, 'idle', timeline);
      return promptsSince(cockpit, from)[0];
    }
  }
  throw new Error(`The box was not submitted: it shows ${await session.screen()}`);
}

async function boxOf(session: AgentSession) {
  return readInputBoxView(await session.screen());
}

const draftLines = (count: number) =>
  Array.from(
    { length: count },
    (_, index) => `draft line ${String(index + 1).padStart(2, '0')}`,
  ).join('\n');

it('103 — Typed over a long draft, the cursor lines up, or a line wrapped onto rows: the prompt arrives exact, the draft comes back exact, Down never pressed past its last row', async () => {
  const { cockpit, session } = await idleSession();

  const draft = draftLines(25);
  await typeDraft(session, draft);
  await pressEach(session, 'Up', 10);
  await pressEach(session, 'Left', 3);
  const tall = await typed(cockpit, session, 'a prompt over a tall draft');
  const tallDraft = await submitBox(cockpit, session);

  const wrapped = Array.from({ length: 70 }, (_, i) => `word${String(i).padStart(3, '0')}x`).join(
    ' ',
  );
  await typeDraft(session, wrapped);
  await pressEach(session, 'Up', 3);
  const wide = await typed(cockpit, session, 'line one\n\n\tindented line\nlast line');
  const wideDraft = await submitBox(cockpit, session);

  expect(tall.outcome).toBe('taken');
  expect(tall.prompts).toEqual(['a prompt over a tall draft']);
  expect(
    tall.writes
      .filter((write) => write.startsWith('Down'))
      .join(' ')
      .split(' '),
  ).toHaveLength(10);
  expect(tallDraft).toBe(draft);
  expect(wide.prompts).toEqual(['line one\n\n    indented line\nlast line']);
  expect(
    wide.writes
      .filter((write) => write.startsWith('Down'))
      .join(' ')
      .split(' '),
  ).toHaveLength(3);
  expect(wideDraft).toBe(wrapped);
});

it('104 — An empty box after a kill of the person stays empty after a prompt, and a prompt whose trailing whitespace the agent trims is taken', async () => {
  const { cockpit, session } = await idleSession();

  await typeDraft(session, 'old draft');
  await session.press('C-u');
  await eventually(async () => expect((await boxOf(session))?.text).toBe(''));
  const sent = await typed(cockpit, session, 'trailing whitespace  \n');

  expect(sent.outcome).toBe('taken');
  expect(sent.prompts).toEqual(['trailing whitespace']);
  expect(sent.writes.some((write) => write.startsWith('Down'))).toBe(false);
  // A key typed now is drawn after every key the driver sent: the box then shows what they left.
  await session.type('z');
  await eventually(async () => expect((await boxOf(session))?.text).toBe('z'));
});

it('105 — An entry recalled from the history (History n/m) is not typed over: nothing is written', async () => {
  const { cockpit, session } = await idleSession();

  await session.press('Up');
  await eventually(async () => expect((await boxOf(session))?.recalled).toBe(true));
  const refused = await typed(cockpit, session, 'a prompt');

  expect(refused).toEqual({ outcome: 'no-input-box', writes: [], prompts: [] });
  expect(await boxOf(session)).toMatchObject({ recalled: true, text: 'get ready' });
});

it('106 — Typed while the command menu or the file menu is open: the prompt arrives exact, the draft comes back', async () => {
  const { cockpit, session } = await idleSession({
    directory: ({ workFolder }) => {
      // The file menu lists the files the agent found at its start.
      for (const name of ['alpha-notes.txt', 'alpha-plan.md']) {
        writeFileSync(join(workFolder, name), 'x\n');
      }
      return workFolder;
    },
  });

  await typeDraft(session, '/he');
  const command = await typed(cockpit, session, 'a prompt over a command');
  // The keys that put the draft back go as the turn runs: the box may draw them after it ended.
  await eventually(async () => expect((await boxOf(session))?.text).toBe('/he'));
  await session.press('C-u');
  await typeDraft(session, 'first line\ncompare @alp');
  const file = await typed(cockpit, session, 'a prompt over a file menu');
  const fileDraft = await submitBox(cockpit, session);

  expect(command.prompts).toEqual(['a prompt over a command']);
  expect(file.prompts).toEqual(['a prompt over a file menu']);
  expect(fileDraft).toMatch(/^first line\ncompare @alp/);
});

it('107 — Typed over a draft in shell mode: the prompt reaches UserPromptSubmit, never the shell, and the draft comes back in shell mode', async () => {
  const { cockpit, session } = await idleSession();

  await session.type('!');
  await eventually(async () => expect((await boxOf(session))?.sign).toBe('!'));
  await typeDraft(session, 'echo shell-draft');
  const sent = await typed(cockpit, session, 'echo typed-into-shell-mode');

  expect(sent.outcome).toBe('taken');
  expect(sent.prompts).toEqual(['echo typed-into-shell-mode']);
  await eventually(async () =>
    expect(await boxOf(session)).toMatchObject({ sign: '!', text: 'echo shell-draft' }),
  );
});

it('108 — The person’s vim mode is off in the driver’s sessions (editorMode normal): a draft left after Escape, a prompt typed over it, both exact', async () => {
  const { cockpit, session } = await idleSession({ personsSettings: { editorMode: 'vim' } });

  await typeDraft(session, 'two\nlines');
  await session.press('Escape');
  // Drawn once the agent read the Escape alone: a key sent sooner could join it as Alt+key.
  await eventually(async () => expect(await session.screen()).toContain('esc again to clear'));
  const sent = await typed(cockpit, session, 'harmless words only');
  const draft = await submitBox(cockpit, session);

  expect(await session.screen()).not.toContain('-- INSERT --');
  expect(sent.prompts).toEqual(['harmless words only']);
  expect(draft).toBe('two\nlines');
});

it('109 — A permission dialog replaces the input box: the driver reads no box and types nothing, the dialog left unanswered', async () => {
  const { cockpit, session } = await idleSession({
    first: [
      turn(toolUse('Bash', { command: 'touch made-by-the-tool', description: 'Make a file' })),
    ],
    until: 'busy',
  });

  await eventually(async () => expect(await session.screen()).toContain('Do you want to proceed?'));
  const refused = await typed(cockpit, session, 'a prompt');

  expect(refused).toEqual({ outcome: 'no-input-box', writes: [], prompts: [] });
  expect(await session.screen()).toContain('Do you want to proceed?');
  expect(existsSync(join(cockpit.workFolder, 'made-by-the-tool'))).toBe(false);
});

/**
 * Vietnamese, Japanese, Chinese, Korean and emoji: characters of two to
 * four bytes, some of two UTF-16 units, some joined into one glyph.
 */
const MULTI_BYTE =
  'Việt: ầẩẫậắằẳẵặ 日本語と中文の混在テキスト、한국어도조금。测试多字节字符的输入是否完全一致。😀🎉👍🏽👨‍👩‍👧𝔘𝔫𝔦𝔠𝔬𝔡𝔢';

it('110 — 100,000 characters of multi-byte text (over 300 KB of UTF-8) are typed exact', {
  timeout: PATIENCE.longContractTest,
}, async () => {
  const { cockpit, session } = await idleSession();
  const units = Array.from(MULTI_BYTE);
  const prompt = Array.from({ length: 100_000 }, (_, index) => units[index % units.length]).join(
    '',
  );

  const sent = await typed(cockpit, session, prompt);

  expect(Buffer.byteLength(prompt)).toBeGreaterThan(300_000);
  expect(sent.outcome).toBe('taken');
  expect(sent.prompts).toHaveLength(1);
  expect(sent.prompts[0] === prompt.trimEnd()).toBe(true);
});

it('111 — With a background shell running, typed over a draft whose cursor is on its first line: no Down reaches the task pill, the prompt and the draft exact', async () => {
  const driver: ClaudeCodeOptions = { permissions: { allow: ['Bash'] } };
  const { cockpit, session } = await idleSession({
    driver,
    first: [
      turn(toolUse('Bash', { command: 'sleep 60', description: 'Wait', run_in_background: true })),
      turn('Started in the background.'),
    ],
  });

  await eventually(async () => expect(await session.screen()).toMatch(/1 shell/));
  await typeDraft(session, 'my draft\nsecond line');
  await pressEach(session, 'Up', 1);
  const sent = await typed(cockpit, session, 'a prompt beside a task');
  const draft = await submitBox(cockpit, session);

  expect(sent.prompts).toEqual(['a prompt beside a task']);
  expect(sent.writes).toContain('Down');
  expect(draft).toBe('my draft\nsecond line');
});

it('112 — A prompt the agent never takes (every Enter lost) is cleared from the box, and the draft comes back exact past it (Ctrl+Y, Alt+Y)', async () => {
  const { cockpit, session } = await idleSession();

  await typeDraft(session, 'my draft\nline two');
  const lost = await typed(cockpit, session, 'never taken', 3);
  await eventually(async () => expect((await boxOf(session))?.text).toBe('my draft\nline two'));
  const draft = await submitBox(cockpit, session);

  expect(lost.outcome).toBe('not-taken');
  expect(lost.prompts).toEqual([]);
  expect(draft).toBe('my draft\nline two');
});
