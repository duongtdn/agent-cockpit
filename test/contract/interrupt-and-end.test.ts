import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readInputBoxView } from '../../src/claude-code/screen-reading.ts';
import type { AgentSession } from '../support/agent-session.ts';
import { eventually } from '../support/eventually.ts';
import {
  heldTurn,
  type ScriptedAnswer,
  streamingTurn,
  toolUse,
  turn,
} from '../support/fake-api/index.ts';
import { PATIENCE } from '../support/patience.ts';
import {
  type ContractCockpit,
  type HookPayload,
  SAID_KEY,
  sessionAfter,
  startContractCockpit,
} from './cockpit-harness.ts';
import {
  assistantTexts,
  conversationTexts,
  INTERRUPTED,
  INTERRUPTED_FOR_TOOL_USE,
  userTexts,
} from './harness.ts';

/**
 * The cockpit's own interrupt and end on the real agent: what each Esc it
 * presses and each signal it sends comes to, read back by the driver from
 * the transcript or the screen, and what a person's Esc in the terminal
 * leaves.
 */

/** A reply long enough to be still streaming whenever the test acts on it. */
const REPLY = Array.from(
  { length: 300 },
  (_, index) => `Line ${index + 1} of the reply: some words to wrap and stream, item ${index + 1}.`,
).join('\n');

/** The prompt given once a turn was stopped, and the scripted answer that ends its turn. */
const NEXT_PROMPT = 'go on';
const NEXT_ANSWER = turn('Going on.');

/** What the agent's screen shows while it streams a reply: the tokens it took, or the reply. */
const STREAMING = /↓ \d+ tokens|Line 1 of the reply/u;

const PERMISSION_DIALOG = 'Do you want to proceed?';

/** A cockpit whose session took one turn and is idle, the answers given scripted after it. */
async function idleCockpit(
  ...answers: ScriptedAnswer[]
): Promise<{ cockpit: ContractCockpit; session: AgentSession }> {
  const cockpit = await startContractCockpit();
  cockpit.api.script(turn('Ready.'), ...answers);
  await cockpit.say('get ready');
  await cockpit.sessionIn(SAID_KEY, 'idle');
  return { cockpit, session: cockpit.terminal(SAID_KEY) };
}

/**
 * The spinner's row: a sign, words that end in `…`, as the last row of the
 * conversation above the box (the rows under it, a tip or the effort's,
 * are indented).
 */
function spinnerRow(screen: string): string | undefined {
  const box = readInputBoxView(screen);
  if (box === undefined) return undefined;
  const last = screen
    .split('\n')
    .slice(0, box.firstRow - 1)
    .findLast((row) => row.trim() !== '' && !row.startsWith(' '));
  return last !== undefined && /^\S \S[^…]*…/u.test(last) ? last : undefined;
}

/** What the input box holds, its trailing blanks left out; `undefined` when none shows. */
async function boxOf(session: AgentSession): Promise<string | undefined> {
  return readInputBoxView(await session.screen())?.text.trimEnd();
}

/**
 * Waits until the agent shows that it took a prompt and awaits the model:
 * the spinner's row above the box, the box holding what is given.
 */
async function awaitsTheModel(session: AgentSession, box: string): Promise<void> {
  await eventually(
    async () => {
      const screen = await session.screen();
      expect(readInputBoxView(screen)?.text.trimEnd()).toBe(box);
      expect(spinnerRow(screen)).toBeDefined();
    },
    undefined,
    PATIENCE.agentStep,
  );
}

/** Types a draft as a person does, a line break as Alt+Enter, and waits until the box shows it. */
async function typeDraft(session: AgentSession, lines: readonly string[]): Promise<void> {
  for (const [index, line] of lines.entries()) {
    if (index > 0) await session.press('M-Enter');
    await session.type(line);
  }
  await eventually(async () => expect(await boxOf(session)).toBe(lines.join('\n')));
}

/** The markers of an interruption the transcript records in the user's name. */
function markersIn(session: AgentSession): string[] {
  return userTexts(session).filter((text) => text.startsWith('[Request interrupted'));
}

/** The prompts the agent took since a point of the hooks read. */
function promptsSince(cockpit: ContractCockpit, from: number): unknown[] {
  return cockpit.hooksRead
    .slice(from)
    .map((request) => request.body as HookPayload)
    .filter((payload) => payload.hook_event_name === 'UserPromptSubmit')
    .map((payload) => payload.prompt);
}

/**
 * Sends a prompt through the cockpit, and waits for the turn it began to
 * end: the barrier after which nothing of an earlier turn can come.
 *
 * @returns The prompts the agent took meanwhile, and the session once idle.
 */
async function sentAndAnswered(cockpit: ContractCockpit, prompt: string) {
  const hooksFrom = cockpit.hooksRead.length;
  const from = cockpit.timeline.length;
  const sent = await cockpit.send(SAID_KEY, prompt);
  const idle = await sessionAfter(cockpit, 'idle', from);
  return { sent, idle, prompts: promptsSince(cockpit, hooksFrom) };
}

it('130 — cockpit.interrupt on a session whose reply streams: one Esc, the transcript’s marker, interrupted and idle; the next send is taken', async () => {
  const cockpit = await startContractCockpit();
  cockpit.api.script(streamingTurn(turn(REPLY)), NEXT_ANSWER);
  await cockpit.say('stream it');
  const held = await cockpit.api.heldRequest();
  const session = cockpit.terminal(SAID_KEY);
  await eventually(async () => expect(await session.screen()).toMatch(STREAMING));

  const interrupted = await cockpit.interrupt(SAID_KEY);
  const markers = markersIn(session);
  const next = await sentAndAnswered(cockpit, NEXT_PROMPT);

  expect(interrupted).toEqual({ action: 'interrupted', state: 'idle' });
  expect(markers).toEqual([INTERRUPTED]);
  expect(await held.ended).toBe('client-gone');
  expect(next.sent).toEqual({ action: 'sent', state: expect.stringMatching(/^(busy|idle)$/) });
  expect(next.prompts).toEqual([NEXT_PROMPT]);
  expect(next.idle).toMatchObject({ state: 'idle', lastMessage: 'Going on.' });
});

const FIVE_LINES = 'p-one first line\np-two\np-three\np-four\np-five last';
/** Taller than the input box, which shows 15 rows: the withdrawn prompt scrolls inside it. */
const TALLER_THAN_THE_BOX = Array.from(
  { length: 24 },
  (_, index) => `tall line ${String(index + 1).padStart(2, '0')}`,
).join('\n');

for (const [shape, prompt] of [
  ['one line', 'withdraw me'],
  ['five lines', FIVE_LINES],
  ['24 lines, taller than the box', TALLER_THAN_THE_BOX],
] as const) {
  it(`131 — cockpit.interrupt before the model produced anything, the box empty (a prompt of ${shape}): the prompt is withdrawn, read on screen with no marker, interrupted; the cockpit clears it, and the next send arrives alone`, async () => {
    const { cockpit, session } = await idleCockpit(heldTurn(), NEXT_ANSWER);
    await cockpit.send(SAID_KEY, prompt);
    const held = await cockpit.api.heldRequest();
    await awaitsTheModel(session, '');

    const interrupted = await cockpit.interrupt(SAID_KEY);
    const box = readInputBoxView(await session.screen());
    const markers = markersIn(session);
    const next = await sentAndAnswered(cockpit, NEXT_PROMPT);

    expect(interrupted).toEqual({ action: 'interrupted', state: 'idle' });
    expect(markers).toEqual([]);
    expect(await held.ended).toBe('client-gone');
    expect({ text: box?.text.trimEnd(), hiddenAbove: box?.hiddenAbove }).toEqual({
      text: '',
      hiddenAbove: 0,
    });
    expect(next.prompts).toEqual([NEXT_PROMPT]);
    expect(next.idle).toMatchObject({ state: 'idle', lastMessage: 'Going on.' });
  });
}

it('132 — An Esc pressed in the terminal before any output: the session goes idle by the withdrawn read, and the prompt is left in the box, the person’s to submit', async () => {
  const prompt = 'withdraw me, by hand';
  const { cockpit, session } = await idleCockpit(heldTurn(), NEXT_ANSWER);
  await cockpit.send(SAID_KEY, prompt);
  const held = await cockpit.api.heldRequest();
  await awaitsTheModel(session, '');
  const from = cockpit.timeline.length;

  await session.press('Escape');
  const idle = await sessionAfter(cockpit, 'idle', from);
  const box = await boxOf(session);
  const markers = markersIn(session);
  const resubmitted = await cockpit.submitInputBoxInTerminal(SAID_KEY, prompt);

  expect(idle).toMatchObject({ state: 'idle' });
  expect(markers).toEqual([]);
  expect(await held.ended).toBe('client-gone');
  expect(box).toBe(prompt);
  expect(resubmitted.prompt).toBe(prompt);
});

it('133 — cockpit.interrupt while the box holds the person’s draft, put back by the send once its prompt was taken: interrupted, confirmed by the marker; the draft stays in the box, exact', async () => {
  const draft = ['my draft, line one', 'and line two'];
  const { cockpit, session } = await idleCockpit(heldTurn(), NEXT_ANSWER);
  await typeDraft(session, draft);
  await cockpit.send(SAID_KEY, 'the sent prompt');
  const held = await cockpit.api.heldRequest();
  await awaitsTheModel(session, draft.join('\n'));

  const interrupted = await cockpit.interrupt(SAID_KEY);
  const markers = markersIn(session);
  const box = await boxOf(session);
  const resubmitted = await cockpit.submitInputBoxInTerminal(SAID_KEY, draft.join('\n'));

  expect(interrupted).toEqual({ action: 'interrupted', state: 'idle' });
  expect(markers).toEqual([INTERRUPTED]);
  expect(await held.ended).toBe('client-gone');
  expect(box).toBe(draft.join('\n'));
  expect(resubmitted.prompt).toBe(draft.join('\n'));
});

it('134 — cockpit.end while a reply streams: the partial answer and the marker are kept in the transcript, the session ended by the app; a later send resumes the conversation with both', async () => {
  const cockpit = await startContractCockpit();
  cockpit.api.script(streamingTurn(turn(REPLY)), NEXT_ANSWER);
  await cockpit.say('stream it');
  const held = await cockpit.api.heldRequest();
  const session = cockpit.terminal(SAID_KEY);
  await eventually(async () => expect(await session.screen()).toMatch(STREAMING));

  const ended = await cockpit.end(SAID_KEY);
  const endedSession = await cockpit.sessionIn(SAID_KEY, 'ended');
  const partial = assistantTexts(session).filter((text) => text.startsWith('Line 1 of the reply'));
  const markers = markersIn(session);
  const resumed = await sentAndAnswered(cockpit, 'after the end');
  const carried = conversationTexts(await cockpit.api.conversationRequest(2));

  expect(ended).toEqual({ action: 'ended', stoppedTasks: [] });
  expect(endedSession).toMatchObject({ state: 'ended', reason: 'app', canResume: true });
  expect(await held.ended).toBe('client-gone');
  expect(markers).toEqual([INTERRUPTED]);
  expect(partial).toHaveLength(1);
  expect(REPLY.startsWith(partial[0] ?? '')).toBe(true);
  expect(partial[0]?.length).toBeLessThan(REPLY.length);
  expect(resumed.sent).toEqual({ action: 'resumed', state: expect.any(String) });
  expect(resumed.prompts).toEqual(['after the end']);
  expect(resumed.idle).toMatchObject({ state: 'idle', lastMessage: 'Going on.' });
  expect(carried).toEqual(expect.arrayContaining(['stream it', partial[0], INTERRUPTED]));
  expect(carried.indexOf(INTERRUPTED)).toBeLessThan(carried.indexOf('after the end'));
});

it('135 — cockpit.end on a session waiting at the trust dialog: the dialog unanswered, the session ended by the app (not declined), its process gone, no hook at all', async () => {
  const cockpit = await startContractCockpit({ shim: { leftOutOfRecipe: ['folder-trust'] } });
  await cockpit.say('say one line');
  const waiting = await cockpit.sessionIn(SAID_KEY, 'waiting');
  const agent = await cockpit.terminal(SAID_KEY).processId();

  const ended = await cockpit.end(SAID_KEY);
  const session = await cockpit.sessionIn(SAID_KEY, 'ended');

  expect(waiting).toMatchObject({ pending: [{ kind: 'terminal', dialog: 'trust-folder' }] });
  expect(ended).toEqual({ action: 'ended', stoppedTasks: [] });
  expect(session).toMatchObject({ state: 'ended', reason: 'app' });
  expect(session).not.toHaveProperty('dialog');
  expect(() => process.kill(agent, 0)).toThrow();
  expect(await cockpit.terminal(SAID_KEY).isLive()).toBe(false);
  expect(cockpit.hooksRead).toEqual([]);
});

it('136 — cockpit.interrupt while a permission dialog shows in the terminal (no PermissionRequest hook: the session busy): interrupted, the marker for tool use, the tool never run', async () => {
  const made = 'made-by-the-tool';
  const cockpit = await startContractCockpit();
  cockpit.api.script(
    turn(toolUse('Bash', { command: `touch ${made}`, description: 'Make a file' })),
  );
  await cockpit.say('make the file');
  const session = cockpit.terminal(SAID_KEY);
  await eventually(
    async () => expect(await session.screen()).toContain(PERMISSION_DIALOG),
    undefined,
    PATIENCE.agentStep,
  );
  const before = cockpit.cockpit.sessions.list().find((listed) => listed.key === SAID_KEY);

  const interrupted = await cockpit.interrupt(SAID_KEY);
  const markers = markersIn(session);
  await eventually(async () => expect(await session.screen()).not.toContain(PERMISSION_DIALOG));

  expect(before?.state).toBe('busy');
  expect(interrupted).toEqual({ action: 'interrupted', state: 'idle' });
  expect(markers).toEqual([INTERRUPTED_FOR_TOOL_USE]);
  expect(existsSync(join(cockpit.workFolder, made))).toBe(false);
});
