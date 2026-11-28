import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readInputBoxView, readScreen } from '../../src/claude-code/screen-reading.ts';
import type { DriverEvent } from '../../src/server/driver.ts';
import { cameTrue, eventually } from '../support/eventually.ts';
import { heldTurn, TEXT_WRITTEN, toolUse, turn } from '../support/fake-api/index.ts';
import { PATIENCE } from '../support/patience.ts';
import type { AgentSession } from '../support/real-agent/runner.ts';
import { type Moment, SAID_KEY, sessionAfter, startContractCockpit } from './cockpit-harness.ts';
import {
  type ContractAgent,
  conversationTexts,
  INTERRUPTED,
  INTERRUPTED_FOR_TOOL_USE,
  sameText,
  spinnerRow,
  startContractAgent,
  submitInputBox,
  submitPrompt,
  userTexts,
} from './harness.ts';

/** The file a running tool call leaves, for the test to know the tool runs. */
const TOOL_STARTED = 'tool-started';

/**
 * A command that runs until it is interrupted. `timeout` ends it by itself
 * should a failed test leave it behind.
 */
const RUNS_UNTIL_INTERRUPTED = `touch ${TOOL_STARTED}; timeout 30 tail -f /dev/null`;

/** The prompt given once a turn was interrupted, and the scripted answer that ends its turn. */
const NEXT_PROMPT = 'go on';
const NEXT_ANSWER = turn('Going on.');
/**
 * Every hook of the turn that answers the next prompt: the prompt, its
 * answer shown, the end. With every event registered, these alone since
 * the Esc mean the interruption fired none.
 */
const NEXT_TURN_HOOKS = ['UserPromptSubmit', 'MessageDisplay', 'Stop'];

/**
 * Presses Esc in a session that is busy with a prompt, and checks what
 * follows. "At once" is held without a clock: the marker must be in the
 * transcript while nothing else is done to the session, so the interruption
 * alone records it — the agent writes its transcript a moment behind its
 * hooks and requests, so none of them marks the instant. The next prompt is
 * then the barrier: a hook of the interrupted turn would come before its own.
 */
async function expectInterruption(
  agent: ContractAgent,
  session: AgentSession,
  interrupted: { readonly prompt: string; readonly marker: string },
): Promise<void> {
  const hooksSince = hooksFromNow(agent);

  await session.press('Escape');

  await agent.eventually(() => expect(userTexts(session)).toContain(interrupted.marker));
  await submitPrompt(agent, session, NEXT_PROMPT);
  expect(hooksSince()).toEqual(['UserPromptSubmit']);
  const stop = await agent.hook('Stop');
  expect(stop.payload.last_assistant_message).toBe('Going on.');
  expect(hooksSince()).toEqual(NEXT_TURN_HOOKS);
  await agent.eventually(() =>
    expect(userTexts(session)).toEqual([interrupted.prompt, interrupted.marker, NEXT_PROMPT]),
  );
}

/** Gives what tells the events of the hooks received from now on. */
function hooksFromNow(agent: ContractAgent): () => string[] {
  const before = agent.hooks.events().length;
  return () => agent.hooks.events().slice(before);
}

/** What a screen's input box holds, each row without the sign's column; `undefined` when it shows no box. */
function boxOf(screen: string): string | undefined {
  return readInputBoxView(screen)?.text.trimEnd();
}

/** Waits until a session is idle, its input box empty: no spinner's row, no busy hint, read as the box free. */
async function idleAndEmpty(agent: ContractAgent, session: AgentSession): Promise<void> {
  await agent.eventually(async () => expect(isIdleAndEmpty(await session.screen())).toBe(true));
}

/** Reads a session's screen once it settled: two reads in a row agree. */
async function settledScreen(agent: ContractAgent, session: AgentSession): Promise<string> {
  return agent.eventually(async () => {
    const first = await session.screen();
    const second = await session.screen();
    expect(second).toBe(first);
    return second;
  });
}

/**
 * Gives a screen from its conversation's first row on: the welcome banner
 * above it animates by itself (its logo, the sky around it) after the agent
 * is idle, whatever its keys.
 */
function belowTheBanner(screen: string): string {
  const rows = screen.split('\n');
  return rows.slice(rows.findIndex((row) => row.startsWith('❯ '))).join('\n');
}

function isIdleAndEmpty(screen: string): boolean {
  return readScreen(screen).shows === 'input-box' && boxOf(screen) === '';
}

/** Interrupts a turn while the model's answer is awaited, after a tool call so that the turn has produced something. */
async function interruptWhileGenerating(): Promise<void> {
  const agent = await startContractAgent();
  agent.api.script(
    turn('Checking.', toolUse('Bash', { command: 'true' })),
    heldTurn(),
    NEXT_ANSWER,
  );
  const session = await agent.startNew({ prompt: 'check, then think' });
  await agent.hook('UserPromptSubmit');
  const held = await agent.waitFor('the request the API holds', agent.api.heldRequest());

  await expectInterruption(agent, session, { prompt: 'check, then think', marker: INTERRUPTED });

  expect(await agent.waitFor('the held request to end', held.ended)).toBe('client-gone');
}

async function interruptWhileAToolRuns(): Promise<void> {
  const agent = await startContractAgent();
  agent.api.script(
    turn('Waiting.', toolUse('Bash', { command: RUNS_UNTIL_INTERRUPTED })),
    NEXT_ANSWER,
  );
  const session = await agent.startNew({ prompt: 'wait' });
  await agent.hook('UserPromptSubmit');
  await agent.hook('PreToolUse');
  await agent.eventually(() => expect(existsSync(join(agent.workFolder, TOOL_STARTED))).toBe(true));

  await expectInterruption(agent, session, { prompt: 'wait', marker: INTERRUPTED_FOR_TOOL_USE });
}

it('6 — Esc while the agent generates or runs a tool fires no hook; the transcript records an interruption marker at once', async () => {
  await Promise.all([interruptWhileGenerating(), interruptWhileAToolRuns()]);
});

it('22 — Esc while the agent writes: the transcript records [Request interrupted by user] at once and no hook fires; the driver reads the marker, and the session is idle until the next prompt', async () => {
  const cockpit = await startContractCockpit();
  // Held once its text is written: the agent is writing its answer.
  cockpit.api.script(
    heldTurn(turn('Thinking it over'), { afterEvents: TEXT_WRITTEN }),
    NEXT_ANSWER,
  );

  expect(await cockpit.say('think')).toEqual({ action: 'started', state: 'busy' });
  const held = await cockpit.api.heldRequest();
  const session = cockpit.terminal(SAID_KEY);
  // The agent shows a text once its block ends; while it streams, the tokens it took.
  await eventually(async () => expect(await session.screen()).toMatch(/↓ \d+ tokens/u));
  const from = cockpit.timeline.length;
  await session.press('Escape');
  await eventually(() => expect(userTexts(session)).toContain(INTERRUPTED));
  const idle = await sessionAfter(cockpit, 'idle', from);
  const hooksOfTheEsc = cockpit.timeline.slice(from).filter((moment) => 'hook' in moment);
  await cockpit.submitInTerminal(SAID_KEY, NEXT_PROMPT);
  const taken = cockpit.timeline.findIndex(
    (moment: Moment) => 'hook' in moment && moment.hook.prompt === NEXT_PROMPT,
  );
  const answered = await sessionAfter(cockpit, 'idle', taken);

  expect(await held.ended).toBe('client-gone');
  expect(hooksOfTheEsc).toEqual([]);
  expect(idle).toMatchObject({ state: 'idle' });
  expect(answered).toMatchObject({ state: 'idle', lastMessage: 'Going on.' });
  // The agent writes its transcript a moment behind its hooks: the prompt may follow the Stop.
  await eventually(() => expect(userTexts(session)).toEqual(['think', INTERRUPTED, NEXT_PROMPT]));
});

it('95 — the interruption marker carries the time the agent recorded it, earlier than the next prompt is taken: an Esc, then a prompt at once, leave the new turn busy, whenever the driver reads the marker', async () => {
  const cockpit = await startContractCockpit();
  cockpit.api.script(
    heldTurn(turn('Thinking it over'), { afterEvents: TEXT_WRITTEN }),
    heldTurn(NEXT_ANSWER),
  );

  await cockpit.say('think');
  const first = await cockpit.api.heldRequest();
  const session = cockpit.terminal(SAID_KEY);
  await eventually(async () => expect(await session.screen()).toMatch(/↓ \d+ tokens|^●/mu));
  // Typed while the turn runs, submitted as soon as the Esc is recorded: often within one read
  // of the transcript. An Enter pressed with the Esc would be read with it as one key.
  await session.type(NEXT_PROMPT);
  await session.press('Escape');
  await eventually(() => expect(userTexts(session)).toContain(INTERRUPTED));
  await cockpit.submitInputBoxInTerminal(SAID_KEY, NEXT_PROMPT);
  const second = await cockpit.api.heldRequest(2);
  const taken = cockpit.timeline.findIndex(
    (moment: Moment) => 'hook' in moment && moment.hook.prompt === NEXT_PROMPT,
  );
  const told = await eventually(() => {
    const moment = cockpit.timeline.find(
      (each: Moment) => 'told' in each && each.told.some((event) => event.type === 'interrupted'),
    );
    expect(moment).toBeDefined();
    return moment as { readonly told: readonly DriverEvent[] };
  });
  const statesOfTheNewTurn = cockpit.timeline
    .slice(taken)
    .flatMap((moment) => ('session' in moment ? [moment.session.state] : []));
  const busyNow = cockpit.cockpit.sessions.list().find((listed) => listed.key === SAID_KEY);
  second.release();
  const answered = await sessionAfter(cockpit, 'idle', taken);

  expect(await first.ended).toBe('client-gone');
  // The agent writes its transcript a moment behind its hooks: the prompt may follow the Stop.
  await eventually(() => expect(userTexts(session)).toEqual(['think', INTERRUPTED, NEXT_PROMPT]));
  expect(told.told).toEqual([{ type: 'interrupted', at: expect.any(String) }]);
  expect(statesOfTheNewTurn).not.toContain('idle');
  expect(busyNow?.state).toBe('busy');
  expect(answered).toMatchObject({ state: 'idle', lastMessage: 'Going on.' });
});

/** A prompt the model has produced nothing for when the Esc comes. */
const WITHDRAWN = 'withdraw this prompt';

it("23 — Esc before the model produced anything, the input box empty, withdraws the prompt: it is back in the box, with no spinner's row above it; no hook fires, the transcript records nothing of the withdrawal, and the next prompt's conversation leaves it out", async () => {
  const agent = await startContractAgent();
  agent.api.script(heldTurn(), NEXT_ANSWER);
  const session = await agent.startNew();
  await agent.hook('SessionStart');
  await submitPrompt(agent, session, WITHDRAWN);
  const held = await agent.waitFor('the request the API holds', agent.api.heldRequest());
  // The turn shows running, nothing produced yet: the spinner's row over the empty box.
  await agent.eventually(async () => {
    const screen = await session.screen();
    expect(spinnerRow(screen)).toBeDefined();
    expect(boxOf(screen)).toBe('');
  });
  const hooksSince = hooksFromNow(agent);

  await session.press('Escape');

  const withdrawn = await agent.eventually(async () => {
    const screen = await session.screen();
    expect(boxOf(screen)).toBe(WITHDRAWN);
    return screen;
  });
  expect(await agent.waitFor('the held request to end', held.ended)).toBe('client-gone');
  const hooksOfTheEsc = hooksSince();
  // The barrier: the box cleared, the next prompt arrives alone, and a hook or a marker of the
  // withdrawal would come before its own.
  await session.press('C-u');
  await agent.eventually(async () => expect(boxOf(await session.screen())).toBe(''));
  await submitPrompt(agent, session, NEXT_PROMPT);
  expect(hooksSince()).toEqual(['UserPromptSubmit']);
  await agent.hook('Stop');
  const next = await agent.api.conversationRequest(2);

  expect(spinnerRow(withdrawn)).toBeUndefined();
  expect(hooksOfTheEsc).toEqual([]);
  expect(conversationTexts(next)).toContain(NEXT_PROMPT);
  expect(conversationTexts(next).join('\n')).not.toContain(WITHDRAWN);
  // The withdrawn prompt's own entry stays in the file; nothing is written of its withdrawal.
  await agent.eventually(() => expect(userTexts(session)).toEqual([WITHDRAWN, NEXT_PROMPT]));
});

it('24 — One Esc on an idle session, its input box empty, changes nothing; two quick Escs open the rewind menu', async () => {
  const agent = await startContractAgent();
  agent.api.script(turn('Ready.'));
  const session = await agent.startNew();
  await agent.hook('SessionStart');
  await submitPrompt(agent, session, 'get ready');
  await agent.hook('Stop');
  await idleAndEmpty(agent, session);
  const before = belowTheBanner(await settledScreen(agent, session));
  const hooksSince = hooksFromNow(agent);

  await session.press('Escape');
  // An absence has no sign to wait for: watched through, past the double-press window, so that
  // the next Esc does not pair with this one.
  let after = before;
  await cameTrue(async () => {
    after = belowTheBanner(await session.screen());
    return after !== before;
  }, PATIENCE.keyWithoutEffect);
  const hooksOfTheEsc = hooksSince();
  const textsAfterTheEsc = userTexts(session);
  // Two presses, two writes: each Esc reaches the agent as a key of its own, a few
  // milliseconds apart, well within the double-press window. The test shows two Escs that
  // close open the menu; how close is the agent's own window, which it does not draw.
  await session.press('Escape');
  await session.press('Escape');
  const menu = await agent.eventually(async () => {
    const screen = await session.screen();
    expect(screen).toContain('Rewind');
    expect(screen).toContain('Enter to continue · Esc to cancel');
    return screen;
  });

  expect(after).toBe(before);
  expect(hooksOfTheEsc).toEqual([]);
  expect(textsAfterTheEsc).toEqual(['get ready']);
  expect(menu).toMatch(/^\s+get ready$/mu);
  expect(readInputBoxView(menu)).toBeUndefined();
  expect(hooksSince()).toEqual([]);
});

it('25 — Ctrl+U clears the input box, and does nothing on an empty one: what the first cleared is still what Ctrl+Y puts back', async () => {
  const agent = await startContractAgent();
  const session = await agent.startNew();
  await agent.hook('SessionStart');
  await idleAndEmpty(agent, session);
  const draft = 'a draft to clear';
  await session.type(draft);
  await agent.eventually(async () => expect(boxOf(await session.screen())).toBe(draft));

  await session.press('C-u');
  await agent.eventually(async () => expect(boxOf(await session.screen())).toBe(''));
  await session.press('C-u');
  // Had the second Ctrl+U put anything in the box or the kill ring, the paste would show it.
  await session.press('C-y');

  await agent.eventually(async () => expect(boxOf(await session.screen())).toBe(draft));
  expect(agent.hooks.events()).toEqual(['SessionStart']);
});

const TASK_PROMPT = 'Count the files.';

it("28 — Esc does not stop a background subagent: it interrupts the session's turn, while the subagent runs on, finishes, and the session starts a turn of its own with a <task-notification> prompt", async () => {
  const agent = await startContractAgent();
  agent.api.script(
    turn(
      toolUse('Agent', {
        description: 'Count files',
        prompt: TASK_PROMPT,
        subagent_type: 'general-purpose',
      }),
    ),
    turn('Started.'),
    // The turn the Esc interrupts: held after a tool call, so that it has produced something
    // and the Esc does not withdraw its prompt.
    turn('Checking.', toolUse('Bash', { command: 'true' })),
    heldTurn(),
    // The turn the task's end starts.
    turn('Noted.'),
  );
  agent.api.scriptConversation(TASK_PROMPT, heldTurn(turn('Counted.')));
  const session = await agent.startNew();
  await agent.hook('SessionStart');
  await submitPrompt(agent, session, 'start a task');
  const task = await agent.waitFor("the subagent's request the API holds", agent.api.heldRequest());
  let taskEnded: string | undefined;
  void task.ended.then((outcome) => {
    taskEnded = outcome;
  });
  expect((await agent.hook('Stop')).payload.last_assistant_message).toBe('Started.');
  await submitPrompt(agent, session, 'think meanwhile');
  const meanwhile = await agent.waitFor('the turn the API holds', agent.api.heldRequest(2));

  await session.press('Escape');

  await agent.eventually(() => expect(userTexts(session)).toContain(INTERRUPTED));
  expect(await agent.waitFor('the interrupted turn to end', meanwhile.ended)).toBe('client-gone');
  const taskAfterTheEsc = taskEnded;
  const subagentStoppedBeforeItsEnd = agent.hooks.events().includes('SubagentStop');
  task.release();
  await agent.hook('SubagentStop');
  const noted = await agent.hook('Stop');
  // The session's request of the turn the task's end started: its last.
  const notified = agent.api
    .requests()
    .filter((request) => request.kind === 'conversation')
    .findLast((request) => !conversationTexts(request).join('\n').includes(TASK_PROMPT));

  expect(conversationTexts(task.request).join('\n')).toContain(TASK_PROMPT);
  expect(taskAfterTheEsc).toBeUndefined();
  expect(subagentStoppedBeforeItsEnd).toBe(false);
  expect(await task.ended).toBe('released');
  const notification = notified && conversationTexts(notified).join('\n');
  expect(notification).toContain('<task-notification>');
  // The subagent finished: its last answer is the notification's result.
  expect(notification).toMatch(/<result>\s*Counted\.\s*<\/result>/u);
  expect(noted.payload.last_assistant_message).toBe('Noted.');
});

/** How a person's draft came to be in the box when the early Esc comes. */
interface DraftCase {
  readonly name: string;
  readonly draft: string;
  /** Submits the prompt and leaves the draft in the box, the turn held before anything streamed. */
  readonly submitWithDraft: (
    agent: ContractAgent,
    session: AgentSession,
    prompt: string,
  ) => Promise<void>;
}

/**
 * Types a draft as a person does, a line break between its lines, and waits
 * until the box shows it.
 */
async function typeDraft(
  agent: ContractAgent,
  session: AgentSession,
  draft: string,
): Promise<void> {
  for (const [index, line] of draft.split('\n').entries()) {
    if (index > 0) await session.press('M-Enter');
    await session.type(line);
  }
  await agent.eventually(async () => expect(boxOf(await session.screen())).toBe(draft));
}

/**
 * Keeps a draft as the cockpit's send does: killed out of the box, the
 * prompt typed and submitted, the draft pasted back as the turn starts.
 * Each kill takes a line, then the line break before it.
 */
async function draftPutBack(
  agent: ContractAgent,
  session: AgentSession,
  draft: string,
  prompt: string,
) {
  await typeDraft(agent, session, draft);
  const kills = 2 * draft.split('\n').length - 1;
  await session.press(...Array<string>(kills).fill('C-u'));
  await agent.eventually(async () => expect(boxOf(await session.screen())).toBe(''));
  await submitPrompt(agent, session, prompt);
  await session.press('C-y');
}

const DRAFT_CASES: readonly DraftCase[] = [
  {
    name: 'a one-line draft put back as the turn starts',
    draft: 'my one-line draft',
    submitWithDraft: (agent, session, prompt) =>
      draftPutBack(agent, session, 'my one-line draft', prompt),
  },
  {
    name: 'a three-line draft put back as the turn starts',
    draft: 'draft line A\ndraft line B\ndraft line C',
    submitWithDraft: (agent, session, prompt) =>
      draftPutBack(agent, session, 'draft line A\ndraft line B\ndraft line C', prompt),
  },
  {
    name: 'a draft typed during the turn',
    draft: 'typed during the turn',
    submitWithDraft: async (agent, session, prompt) => {
      await submitPrompt(agent, session, prompt);
      await agent.waitFor('the request the API holds', agent.api.heldRequest());
      await typeDraft(agent, session, 'typed during the turn');
    },
  },
];

for (const { name, draft, submitWithDraft } of DRAFT_CASES) {
  it(`128 — An Esc before the model produced anything, with ${name} in the input box, interrupts instead of withdrawing: the transcript records [Request interrupted by user], no hook fires, and the box holds the draft alone, exactly`, async () => {
    const agent = await startContractAgent();
    const prompt = 'the prompt sent';
    agent.api.script(heldTurn(), NEXT_ANSWER);
    const session = await agent.startNew();
    await agent.hook('SessionStart');
    await submitWithDraft(agent, session, prompt);
    const held = await agent.waitFor('the request the API holds', agent.api.heldRequest());
    // The turn shows running, nothing produced yet, the draft in the box.
    await agent.eventually(async () => {
      const screen = await session.screen();
      expect(spinnerRow(screen)).toBeDefined();
      expect(boxOf(screen)).toBe(draft);
    });
    const hooksSince = hooksFromNow(agent);

    await session.press('Escape');

    await agent.eventually(() => expect(userTexts(session)).toContain(INTERRUPTED));
    const afterTheEsc = await agent.eventually(async () => {
      const screen = await session.screen();
      expect(spinnerRow(screen)).toBeUndefined();
      return screen;
    });
    expect(await agent.waitFor('the held request to end', held.ended)).toBe('client-gone');
    // The barrier: what the box holds, submitted, arrives exactly as the agent holds it.
    const { hook } = await submitInputBox(agent, session, (box) => sameText(box, draft));
    expect(hooksSince()).toEqual(['UserPromptSubmit']);
    await agent.hook('Stop');

    expect(boxOf(afterTheEsc)).toBe(draft);
    expect(hook.payload.prompt).toBe(draft);
    await agent.eventually(() => expect(userTexts(session)).toEqual([prompt, INTERRUPTED, draft]));
  });
}
