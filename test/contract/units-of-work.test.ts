import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { claudeCode } from '../../src/claude-code/index.ts';
import { readInputBoxView } from '../../src/claude-code/screen-reading.ts';
import type { Job } from '../../src/server/index.ts';
import type { Session } from '../../src/shared/session.ts';
import type { AgentSession } from '../support/agent-session.ts';
import { eventually } from '../support/eventually.ts';
import { heldTurn, TEXT_WRITTEN, toolUse, turn } from '../support/fake-api/index.ts';
import { findTranscript } from '../support/transcript-files.ts';
import {
  type ContractCockpit,
  type HookPayload,
  SAID_KEY,
  SAY,
  sessionAfter,
  startContractCockpit,
} from './cockpit-harness.ts';
import { conversationTexts } from './harness.ts';

/**
 * The units of work on the real agent, through `createCockpit` with the
 * driver's own launch, hooks and typing: what `run`, `send` and `open` rest
 * on when they resume a conversation, start a new one, end a session to
 * start again, type a first prompt too long for the command line, or type
 * over a person's draft.
 */

const keyed = z.object({ key: z.string() });

/** A job with no prompt: its session waits at `idle` for the person. */
const READY = {
  id: 'ready',
  title: 'Open a session',
  args: keyed,
  key: ({ key }: z.output<typeof keyed>) => key,
} satisfies Job<typeof keyed>;

/** {@link SAY} in the `plan` permission mode: other launch settings for the same key. */
const SAY_IN_PLAN = {
  ...SAY,
  id: 'say-in-plan',
  title: 'Say something, planning',
  driver: claudeCode.job({ permissionMode: 'plan' }),
} as unknown as Job;

/** The hooks the driver read from a moment on, in order. */
function hooksSince(cockpit: ContractCockpit, from: number): HookPayload[] {
  return cockpit.hooksRead.slice(from).map((request) => request.body as HookPayload);
}

/** What of a hook tells the conversation: its event, its session, and the reason or source it gives. */
function told(payload: HookPayload): Record<string, unknown> {
  const { hook_event_name, session_id, source, reason, prompt } = payload;
  return Object.fromEntries(
    Object.entries({ hook_event_name, session_id, source, reason, prompt }).filter(
      ([, value]) => value !== undefined,
    ),
  );
}

/** The hooks of the conversations' starts and ends, and the prompts taken, from a moment on. */
function startsEndsAndPrompts(cockpit: ContractCockpit, from: number): Record<string, unknown>[] {
  return hooksSince(cockpit, from)
    .filter((payload) =>
      ['SessionStart', 'SessionEnd', 'UserPromptSubmit'].includes(String(payload.hook_event_name)),
    )
    .map(told);
}

/** The argument that follows an option of a launch's command line. */
function optionOf(cockpit: ContractCockpit, launch: number, option: string): string | undefined {
  const args = cockpit.launches[launch]?.args ?? [];
  const at = args.indexOf(option);
  return at === -1 ? undefined : args[at + 1];
}

/**
 * Runs an operation on the cockpit, then waits until a session is `idle`
 * after it began: the session it launched or typed into, its turn over.
 *
 * @returns What the operation resolved with, and the session once idle.
 */
async function idleAfter<T>(
  cockpit: ContractCockpit,
  operation: () => Promise<T>,
): Promise<[T, Session]> {
  const from = cockpit.timeline.length;
  const result = await operation();
  return [result, await sessionAfter(cockpit, 'idle', from)];
}

/** The record of the unit of work of {@link SAID_KEY}, as the cockpit lists it now: written once a launch settled. */
function recordOf(cockpit: ContractCockpit): Session['record'] {
  return cockpit.cockpit.sessions.list().find((session) => session.key === SAID_KEY)?.record;
}

/** The transcript of a conversation; throws when the agent kept none. */
function transcriptOf(cockpit: ContractCockpit, conversationId: string): string {
  const transcript = findTranscript(cockpit.configFolder, conversationId);
  if (transcript === undefined) throw new Error(`No transcript of ${conversationId}.`);
  return transcript;
}

it('113 — run, send and open on an ended unit of work resume it with --resume: the same session id and the conversation kept; a run’s or a send’s prompt taken at the launch, an open’s session idle with none', async () => {
  const cockpit = await startContractCockpit();
  cockpit.api.script(turn('The first answer.'), turn('The second answer.'), turn('The third.'));

  await cockpit.say('the first prompt');
  await cockpit.sessionIn(SAID_KEY, 'idle');
  const conversation = cockpit.conversationOf(SAID_KEY);
  await cockpit.exitByItself(SAID_KEY, conversation);
  const [ran] = await idleAfter(cockpit, () => cockpit.say('the second prompt'));
  await cockpit.exitByItself(SAID_KEY, conversation);
  const [sent] = await idleAfter(cockpit, () => cockpit.send(SAID_KEY, 'the third prompt'));
  await cockpit.exitByItself(SAID_KEY, conversation);
  const openedFrom = cockpit.hooksRead.length;
  const [opened, idle] = await idleAfter(cockpit, () => cockpit.open(SAID_KEY));

  expect(ran).toEqual({ action: 'resumed', state: expect.stringMatching(/^(busy|idle)$/) });
  expect(sent).toEqual({ action: 'resumed', state: expect.stringMatching(/^(busy|idle)$/) });
  expect(opened).toEqual({ action: 'resumed', state: 'idle' });
  expect(cockpit.launches.map((_, launch) => optionOf(cockpit, launch, '--resume'))).toEqual([
    undefined,
    conversation,
    conversation,
    conversation,
  ]);
  expect(
    startsEndsAndPrompts(cockpit, 0).filter((hook) => hook.hook_event_name !== 'SessionEnd'),
  ).toEqual([
    { hook_event_name: 'SessionStart', session_id: conversation, source: 'startup' },
    { hook_event_name: 'UserPromptSubmit', session_id: conversation, prompt: 'the first prompt' },
    { hook_event_name: 'SessionStart', session_id: conversation, source: 'resume' },
    { hook_event_name: 'UserPromptSubmit', session_id: conversation, prompt: 'the second prompt' },
    { hook_event_name: 'SessionStart', session_id: conversation, source: 'resume' },
    { hook_event_name: 'UserPromptSubmit', session_id: conversation, prompt: 'the third prompt' },
    { hook_event_name: 'SessionStart', session_id: conversation, source: 'resume' },
  ]);
  // The open's launch carried no prompt, and no turn began.
  expect(cockpit.launches[3]?.args).not.toContain('--');
  expect(hooksSince(cockpit, openedFrom).map((hook) => hook.hook_event_name)).toEqual([
    'SessionStart',
  ]);
  const said = [
    'the first prompt',
    'The first answer.',
    'the second prompt',
    'The second answer.',
    'the third prompt',
  ];
  const texts = conversationTexts(await cockpit.api.conversationRequest(3));
  expect(texts.filter((text) => said.includes(text))).toEqual(said);
  expect(idle.state).toBe('idle');
  expect(recordOf(cockpit)?.conversationId).toBe(conversation);
  expect(
    recordOf(cockpit)?.history.map(({ operation, action }) => `${operation} ${action}`),
  ).toEqual(['run started', 'run resumed', 'open resumed']);
});

it('114 — A conversation the agent no longer keeps — never given a prompt, so never written, or its transcript deleted — is not resumed: run, send and open start a new conversation (conversation-gone), which takes the prompt', async () => {
  const cockpit = await startContractCockpit({ jobs: [READY as unknown as Job] });
  cockpit.api.script(turn('Started anew.'), turn('Sent anew.'));

  const ready = await cockpit.run(READY.id, { key: SAID_KEY });
  const unprompted = cockpit.conversationOf(SAID_KEY);
  await cockpit.exitByItself(SAID_KEY, unprompted);
  const neverWritten = findTranscript(cockpit.configFolder, unprompted);
  const [ran] = await idleAfter(cockpit, () => cockpit.say('after a conversation never written'));
  const ranIn = cockpit.conversationOf(SAID_KEY);
  await cockpit.exitByItself(SAID_KEY, ranIn);
  rmSync(transcriptOf(cockpit, ranIn));
  const [sent] = await idleAfter(cockpit, () =>
    cockpit.send(SAID_KEY, 'after the transcript was deleted'),
  );
  const sentIn = cockpit.conversationOf(SAID_KEY);
  await cockpit.exitByItself(SAID_KEY, sentIn);
  rmSync(transcriptOf(cockpit, sentIn));
  const [opened, idle] = await idleAfter(cockpit, () => cockpit.open(SAID_KEY));
  const openedIn = cockpit.conversationOf(SAID_KEY);

  expect(ready).toEqual({ action: 'started', state: 'idle' });
  expect(neverWritten).toBeUndefined();
  const gone = { action: 'started', reason: 'conversation-gone' };
  expect(ran).toEqual({ ...gone, state: expect.stringMatching(/^(busy|idle)$/) });
  expect(sent).toEqual({ ...gone, state: expect.stringMatching(/^(busy|idle)$/) });
  expect(opened).toEqual({ ...gone, state: 'idle' });
  expect(new Set([unprompted, ranIn, sentIn, openedIn]).size).toBe(4);
  // Each a new conversation: never a --resume the agent could not take.
  expect(cockpit.launches.map((_, launch) => optionOf(cockpit, launch, '--resume'))).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
  expect(
    startsEndsAndPrompts(cockpit, 0).filter((hook) => hook.hook_event_name !== 'SessionEnd'),
  ).toEqual([
    { hook_event_name: 'SessionStart', session_id: unprompted, source: 'startup' },
    { hook_event_name: 'SessionStart', session_id: ranIn, source: 'startup' },
    {
      hook_event_name: 'UserPromptSubmit',
      session_id: ranIn,
      prompt: 'after a conversation never written',
    },
    { hook_event_name: 'SessionStart', session_id: sentIn, source: 'startup' },
    {
      hook_event_name: 'UserPromptSubmit',
      session_id: sentIn,
      prompt: 'after the transcript was deleted',
    },
    { hook_event_name: 'SessionStart', session_id: openedIn, source: 'startup' },
  ]);
  expect(idle.state).toBe('idle');
  expect(recordOf(cockpit)).toMatchObject({
    conversationId: openedIn,
    earlierConversations: [unprompted, ranIn, sentIn],
  });
});

it('115 — fresh on an idle and on a busy session ends it gracefully (SIGTERM: its SessionEnd, the conversation kept), and a new conversation takes the prompt', async () => {
  const cockpit = await startContractCockpit();
  cockpit.api.script(
    turn('Before.'),
    turn('Afresh.'),
    // Held once its text is written: the agent is writing its answer.
    heldTurn(turn('Thinking it over'), { afterEvents: TEXT_WRITTEN }),
    turn('Afresh again.'),
  );

  await cockpit.say('the first conversation');
  await cockpit.sessionIn(SAID_KEY, 'idle');
  const first = cockpit.conversationOf(SAID_KEY);
  const fromIdle = cockpit.hooksRead.length;
  const [afterIdle] = await idleAfter(cockpit, () =>
    cockpit.run(SAY.id, { prompt: 'afresh from idle', key: SAID_KEY }, { fresh: true }),
  );
  const second = cockpit.conversationOf(SAID_KEY);
  await cockpit.say('think it over');
  const held = await cockpit.api.heldRequest();
  const fromBusy = cockpit.hooksRead.length;
  const [afterBusy, idle] = await idleAfter(cockpit, () =>
    cockpit.run(SAY.id, { prompt: 'afresh from busy', key: SAID_KEY }, { fresh: true }),
  );
  const third = cockpit.conversationOf(SAID_KEY);

  const fresh = { action: 'started', reason: 'fresh-on-request' };
  expect(afterIdle).toEqual({ ...fresh, state: expect.stringMatching(/^(busy|idle)$/) });
  expect(afterBusy).toEqual({ ...fresh, state: expect.stringMatching(/^(busy|idle)$/) });
  expect(new Set([first, second, third]).size).toBe(3);
  // The old session's end is read before the new one starts: the agent took SIGTERM, not a kill.
  expect(startsEndsAndPrompts(cockpit, fromIdle)).toEqual([
    { hook_event_name: 'SessionEnd', session_id: first, reason: 'other' },
    { hook_event_name: 'SessionStart', session_id: second, source: 'startup' },
    { hook_event_name: 'UserPromptSubmit', session_id: second, prompt: 'afresh from idle' },
    { hook_event_name: 'UserPromptSubmit', session_id: second, prompt: 'think it over' },
    { hook_event_name: 'SessionEnd', session_id: second, reason: 'other' },
    { hook_event_name: 'SessionStart', session_id: third, source: 'startup' },
    { hook_event_name: 'UserPromptSubmit', session_id: third, prompt: 'afresh from busy' },
  ]);
  expect(hooksSince(cockpit, fromBusy)[0]).toMatchObject({ hook_event_name: 'SessionEnd' });
  expect(await held.ended).toBe('client-gone');
  // Ended gracefully, each conversation stays the agent's to resume.
  expect(existsSync(transcriptOf(cockpit, first))).toBe(true);
  expect(existsSync(transcriptOf(cockpit, second))).toBe(true);
  expect(idle).toMatchObject({ lastMessage: 'Afresh again.' });
  expect(recordOf(cockpit)).toMatchObject({
    conversationId: third,
    earlierConversations: [first, second],
  });
});

it('116 — A run on an idle session launched with other settings ends it gracefully (restarted) and resumes the same conversation with the run’s settings, which take its prompt', async () => {
  const cockpit = await startContractCockpit({ jobs: [SAY_IN_PLAN] });
  cockpit.api.script(turn('In the default mode.'), turn('Planned.'));

  await cockpit.say('the first prompt');
  await cockpit.sessionIn(SAID_KEY, 'idle');
  const conversation = cockpit.conversationOf(SAID_KEY);
  const from = cockpit.hooksRead.length;
  const [restarted, idle] = await idleAfter(cockpit, () =>
    cockpit.run(SAY_IN_PLAN.id, {
      prompt: 'the planned prompt',
      key: SAID_KEY,
    }),
  );

  expect(restarted).toEqual({
    action: 'resumed',
    reason: 'settings-changed',
    state: expect.stringMatching(/^(busy|idle)$/),
  });
  expect(
    cockpit.timeline.flatMap((moment) =>
      'session' in moment && moment.session.state === 'ended' ? [moment.session] : [],
    ),
  ).toEqual([expect.objectContaining({ reason: 'restarted' })]);
  expect(optionOf(cockpit, 1, '--resume')).toBe(conversation);
  expect(optionOf(cockpit, 1, '--permission-mode')).toBe('plan');
  expect(startsEndsAndPrompts(cockpit, from)).toEqual([
    { hook_event_name: 'SessionEnd', session_id: conversation, reason: 'other' },
    { hook_event_name: 'SessionStart', session_id: conversation, source: 'resume' },
    { hook_event_name: 'UserPromptSubmit', session_id: conversation, prompt: 'the planned prompt' },
  ]);
  expect(
    hooksSince(cockpit, from).find((hook) => hook.hook_event_name === 'UserPromptSubmit'),
  ).toMatchObject({ permission_mode: 'plan' });
  const said = ['the first prompt', 'In the default mode.', 'the planned prompt'];
  const texts = conversationTexts(await cockpit.api.conversationRequest(2));
  expect(texts.filter((text) => said.includes(text))).toEqual(said);
  expect(idle).toMatchObject({ lastMessage: 'Planned.' });
});

/** Types a draft as a person does, a line break as Alt+Enter, and waits until the box shows it. */
async function typeDraft(session: AgentSession, lines: readonly string[]): Promise<void> {
  for (const [index, line] of lines.entries()) {
    if (index > 0) await session.press('M-Enter');
    await session.type(line);
  }
  await eventually(async () =>
    expect(readInputBoxView(await session.screen())?.text).toBe(lines.join('\n')),
  );
}

async function boxOf(session: AgentSession): Promise<string | undefined> {
  return readInputBoxView(await session.screen())?.text;
}

it('118 — A send keeps a person’s draft of several lines: the prompt typed over it is taken exact, the draft comes back exact', async () => {
  const cockpit = await startContractCockpit();
  cockpit.api.script(turn('Ready.'), turn('Sent.'));
  await cockpit.say('get ready');
  await cockpit.sessionIn(SAID_KEY, 'idle');
  const session = cockpit.terminal(SAID_KEY);
  const draft = ['the first line of my draft', '', '  the third, indented'];

  await typeDraft(session, draft);
  const from = cockpit.hooksRead.length;
  const [sent] = await idleAfter(cockpit, () => cockpit.send(SAID_KEY, 'a prompt\nof two lines'));

  expect(sent).toEqual({ action: 'sent', state: expect.stringMatching(/^(busy|idle)$/) });
  expect(
    hooksSince(cockpit, from)
      .filter((hook) => hook.hook_event_name === 'UserPromptSubmit')
      .map((hook) => hook.prompt),
  ).toEqual(['a prompt\nof two lines']);
  await eventually(async () => expect(await boxOf(session)).toBe(draft.join('\n')));
});

/**
 * Answers a permission dialog Yes as a person does, Enter on its selected
 * first option, again while the dialog stays: an Enter pressed as soon as
 * the dialog is drawn was lost in every run seen, a guard of the agent's
 * against a key typed ahead answering it.
 *
 * @returns How many Enters it took.
 */
async function answerYes(session: AgentSession): Promise<number> {
  for (let enters = 1; ; enters++) {
    await session.press('Enter');
    const gone = await eventually(
      async () => expect(await session.screen()).not.toContain('Do you want'),
      undefined,
      3000,
    ).then(
      () => true,
      () => false,
    );
    if (gone) return enters;
    if (enters === 3)
      throw new Error(`The dialog stayed after 3 Enters:\n${await session.screen()}`);
  }
}

/** A prompt of many rows of the input box, in words. */
const LONG_PROMPT = Array.from({ length: 5000 }, (_, index) => `w${index}`).join(' ');

/** The keys a send's refusal names to bring the person's draft back; none when it is in the box. */
function keysToBringBack(message: string): string[] {
  if (!message.includes('kill ring')) return [];
  return message.includes('Ctrl+Y, then Alt+Y') ? ['C-y', 'M-y'] : ['C-y'];
}

it('119 — A permission dialog drawn while a send types (a turn the agent began by itself) stops it: wrong-state, no key reaches the dialog, and the draft is where the refusal says — back in the box, or brought back by the keys it names', {
  timeout: 120_000,
}, async () => {
  const cockpit = await startContractCockpit({ driver: { permissions: { allow: ['Bash'] } } });
  const release = join(cockpit.workFolder, 'released');
  const made = join(cockpit.workFolder, 'made-by-the-tool.txt');
  cockpit.api.script(
    turn(
      toolUse('Bash', {
        command: 'until [ -e released ]; do sleep 0.1; done',
        description: 'Wait for the release',
        run_in_background: true,
      }),
    ),
    turn('Waiting in the background.'),
    // The turn the shell's end starts by itself: a tool that asks.
    turn(toolUse('Write', { file_path: made, content: 'made\n' })),
    turn('Written.'),
  );
  await cockpit.say('wait in the background');
  await cockpit.sessionIn(SAID_KEY, 'idle');
  const session = cockpit.terminal(SAID_KEY);
  await eventually(async () => expect(await session.screen()).toMatch(/1 shell/));
  await typeDraft(session, ['my draft']);

  const sending = cockpit.send(SAID_KEY, LONG_PROMPT).then(
    () => expect.fail('The send was not stopped.'),
    (error: unknown) => error as { code?: string; key?: string; message: string },
  );
  // Rows enough that clearing them outlasts the turn's first tool hook.
  await eventually(
    async () =>
      expect(Number(/↑ (\d+) more/.exec(await session.screen())?.[1] ?? 0)).toBeGreaterThanOrEqual(
        40,
      ),
    undefined,
    30_000,
  );
  writeFileSync(release, '');
  const refused = await sending;
  await eventually(async () => expect(await session.screen()).toContain('Do you want'));
  const unanswered = existsSync(made);
  const from = cockpit.timeline.length;
  await answerYes(session);
  await sessionAfter(cockpit, 'idle', from);
  const keys = keysToBringBack(refused.message);
  if (keys.length > 0) await session.press(...keys);

  expect(refused).toMatchObject({ code: 'wrong-state', key: SAID_KEY });
  expect(unanswered).toBe(false);
  expect(existsSync(made)).toBe(true);
  const prompts = cockpit.hooksRead
    .map((request) => request.body as HookPayload)
    .filter((hook) => hook.hook_event_name === 'UserPromptSubmit')
    .map((hook) => String(hook.prompt));
  expect(prompts.at(-1)).toContain('<task-notification>');
  expect(prompts).not.toContain(LONG_PROMPT);
  await eventually(async () => {
    const box = (await boxOf(session)) ?? '';
    // The box wraps the draft's words onto its rows as it wraps any text.
    if (keys.length > 0) expect(box.replace(/\s+/gu, ' ')).toMatch(/my draft$/);
    else expect(box).toBe('my draft');
  });
});
