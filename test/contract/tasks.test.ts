import { expect, it } from 'vitest';
import { heldTurn, toolUse, turn } from '../support/fake-api/index.ts';
import {
  type ContractCockpit,
  type HookPayload,
  SAID_KEY,
  sessionAfter,
  startContractCockpit,
} from './cockpit-harness.ts';
import { conversationTexts } from './harness.ts';

/**
 * A task the agent runs in the background, met by a cockpit with the
 * driver's own launch and hooks: the task's hooks name it, the session's
 * do not, and the session is idle while it runs.
 */

const TASK_PROMPT = 'Count the files.';
const TASK_DESCRIPTION = 'Count files';

/**
 * Starts a cockpit whose session starts a task, its subagent held at its
 * first request, and waits for the session to be idle with the task in flight.
 *
 * @param input - What the `Agent` call carries beside its description, prompt and type.
 */
async function sessionWithATask(input: Readonly<Record<string, unknown>> = {}) {
  const cockpit = await startContractCockpit({ driver: { permissions: { allow: ['Bash'] } } });
  cockpit.api.script(
    turn(
      toolUse('Agent', {
        description: TASK_DESCRIPTION,
        prompt: TASK_PROMPT,
        subagent_type: 'general-purpose',
        ...input,
      }),
    ),
    turn('Started.'),
    // The turn the task's end starts.
    turn('Noted.'),
  );
  cockpit.api.scriptConversation(
    TASK_PROMPT,
    heldTurn(turn(toolUse('Bash', { command: 'touch inner.txt' }))),
    turn('Counted.'),
  );
  await cockpit.say('start a task');
  const idle = await cockpit.sessionIn(SAID_KEY, 'idle');
  const held = await cockpit.api.heldRequest();
  return { cockpit, idle, held };
}

function hooksOf(cockpit: ContractCockpit): HookPayload[] {
  return cockpit.hooksRead.map((request) => request.body as HookPayload);
}

function isTasks(hook: HookPayload): boolean {
  return hook.agent_id !== undefined;
}

it('15 — A background subagent: Stop lists it in background_tasks; when it ends, the session starts a turn with a <task-notification> prompt', async () => {
  const { cockpit, idle, held } = await sessionWithATask();
  const stop = hooksOf(cockpit).find((hook) => hook.hook_event_name === 'Stop');
  const from = cockpit.timeline.length;
  held.release();
  const busy = await sessionAfter(cockpit, 'busy', from);
  const busyAt = cockpit.timeline.findIndex(
    (moment) => 'session' in moment && moment.session === busy,
  );
  const after = await sessionAfter(cockpit, 'idle', busyAt);
  // The session's request of the turn the task's end started: its last.
  const notified = cockpit.api
    .requests()
    .filter((request) => request.kind === 'conversation')
    .findLast((request) => !conversationTexts(request).join('\n').includes(TASK_PROMPT));

  expect(stop).toMatchObject({
    background_tasks: [expect.objectContaining({ description: TASK_DESCRIPTION })],
  });
  const [listed] = (stop?.background_tasks ?? []) as { id: string }[];
  expect(idle).toMatchObject({
    state: 'idle',
    lastMessage: 'Started.',
    backgroundTasks: [{ id: listed?.id, type: 'general-purpose', description: TASK_DESCRIPTION }],
  });
  expect(hooksOf(cockpit)).toContainEqual(
    expect.objectContaining({ hook_event_name: 'SubagentStop', agent_id: listed?.id }),
  );
  expect(notified && conversationTexts(notified).at(-1)).toContain('<task-notification>');
  expect(after).toMatchObject({ state: 'idle', lastMessage: 'Noted.' });
  expect(after).not.toMatchObject({ backgroundTasks: [expect.anything()] });
});

it("62 — A background task's hooks carry agent_id; the session's do not", async () => {
  const { cockpit, held } = await sessionWithATask();
  const from = cockpit.timeline.length;
  held.release();
  await sessionAfter(cockpit, 'busy', from);
  await sessionAfter(cockpit, 'idle', from);

  const hooks = hooksOf(cockpit);
  const tasks = hooks.filter(isTasks).map((hook) => hook.hook_event_name);
  const sessions = hooks.filter((hook) => !isTasks(hook)).map((hook) => hook.hook_event_name);
  expect(tasks).toEqual(
    expect.arrayContaining(['SubagentStart', 'PreToolUse', 'PostToolUse', 'SubagentStop']),
  );
  expect(sessions).toEqual(
    expect.arrayContaining(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop']),
  );
  expect(sessions).not.toContain('SubagentStart');
  // The task's tool calls, the shell's, are its own; the session's only call is the Agent's.
  expect(
    hooks
      .filter((hook) => hook.hook_event_name === 'PreToolUse')
      .map((hook) => [hook.tool_name, isTasks(hook)]),
  ).toEqual([
    ['Agent', false],
    ['Bash', true],
  ]);
  // Before the task's end, its hooks moved nothing: the session stayed idle.
  const end = cockpit.timeline.findIndex(
    (moment) => 'hook' in moment && moment.hook.hook_event_name === 'SubagentStop',
  );
  const changes = cockpit.timeline.slice(from, end).filter((moment) => 'session' in moment);
  expect(changes).toEqual([]);
});

it('73 — An Agent call runs the subagent in the background even with run_in_background: false; its hooks carry agent_id', async () => {
  const { cockpit, idle, held } = await sessionWithATask({ run_in_background: false });

  // The session's turn ended while the subagent waits at its first request.
  expect(idle).toMatchObject({
    state: 'idle',
    lastMessage: 'Started.',
    backgroundTasks: [expect.objectContaining({ description: TASK_DESCRIPTION })],
  });
  expect(conversationTexts(held.request).join('\n')).toContain(TASK_PROMPT);
  const start = hooksOf(cockpit).find((hook) => hook.hook_event_name === 'SubagentStart');
  expect(start).toMatchObject({ agent_id: expect.any(String), agent_type: 'general-purpose' });
});
