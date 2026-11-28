import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import type { AgentSession } from '../support/agent-session.ts';
import { toolUse, turn } from '../support/fake-api/index.ts';
import type { ReceivedHook } from '../support/hooks/hook-receiver.ts';
import { escaped, REFUSED_CALL } from '../support/hooks/payload-recording.ts';
import type { LaunchOptions } from '../support/real-agent/runner.ts';
import { toolResults } from './confinement-probes.ts';
import { answerYes, pressOnDialog, selectOnDialog } from './dialog-keys.ts';
import { type ContractAgent, startContractAgent, submitPrompt } from './harness.ts';

/**
 * A tool call the agent asks about, met by the agent alone: what each hook
 * of the ask carries (`PermissionRequest`, `PostToolUseFailure`,
 * `PostToolBatch`, `Notification`) and when it comes, against the hook's
 * answer or the person's in the terminal. The driver reads these payloads,
 * and a recording run keeps them for its unit tests and the fake agent.
 */

const PERMISSION_DIALOG = 'Do you want to proceed?';

/** The hook's answer that lets the call run. */
const ALLOW = {
  hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
};

/** Starts the agent with no rule of the person's, so that every call that may ask, asks. */
function askingAgent(): Promise<ContractAgent> {
  return startContractAgent({ permissions: {} });
}

async function startedSession(
  agent: ContractAgent,
  options?: LaunchOptions,
): Promise<AgentSession> {
  const session = await agent.startNew(options);
  await agent.hook('SessionStart');
  return session;
}

/** Gives the hooks received so far of an event. */
function received(agent: ContractAgent, event: string): ReceivedHook[] {
  return agent.hooks.received.filter((hook) => hook.event === event);
}

/**
 * Answers a held PreToolUse, once it is sure no PermissionRequest came
 * before that answer, and waits for the ask that follows it.
 *
 * @returns How many asks had come before the answer, and the ask.
 */
async function askAfter(
  agent: ContractAgent,
  pre: ReceivedHook,
): Promise<{ askedBefore: number; ask: ReceivedHook }> {
  const askedBefore = received(agent, 'PermissionRequest').length;
  pre.answer({});
  return { askedBefore, ask: await agent.hook('PermissionRequest') };
}

/**
 * Waits for the next hook of an event that matches, each wait under the
 * bound of the agent's step, the ones before it passed over.
 */
async function nextWhere(
  agent: ContractAgent,
  event: string,
  matches: (payload: Record<string, unknown>) => boolean,
): Promise<ReceivedHook> {
  for (;;) {
    const hook = await agent.hook(event);
    if (matches(hook.payload)) return hook;
  }
}

/** Waits for the agent's Notification of a type. */
function notification(agent: ContractAgent, type: string): Promise<ReceivedHook> {
  return nextWhere(agent, 'Notification', (payload) => payload.notification_type === type);
}

it("137 — A Bash call with a description asks only once its PreToolUse is answered: PermissionRequest carries the turn's prompt_id, the mode, the call's input with its description and the agent's suggestions (the work folder for the session, acceptEdits), no tool_use_id; the hook's allow runs the call, PostToolUse naming the PreToolUse's tool_use_id", async () => {
  const agent = await askingAgent();
  const input = { command: 'touch asked.txt', description: 'Create asked.txt' };
  agent.api.script(turn(toolUse('Bash', input)), turn('Done.'));
  agent.hooks.hold('PreToolUse');
  agent.hooks.hold('PermissionRequest');
  const session = await startedSession(agent);
  await submitPrompt(agent, session, 'make the file');

  const pre = await agent.hook('PreToolUse');
  const { askedBefore, ask } = await askAfter(agent, pre);
  ask.answer(ALLOW);
  const ran = await agent.hook('PostToolUse');
  await agent.hook('Stop');

  expect(askedBefore).toBe(0);
  expect(ask.payload).toMatchObject({
    tool_name: 'Bash',
    tool_input: input,
    prompt_id: pre.payload.prompt_id,
    permission_mode: 'default',
    permission_suggestions: [
      { type: 'addDirectories', directories: [ask.payload.cwd], destination: 'session' },
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    ],
  });
  expect(ask.payload).not.toHaveProperty('tool_use_id');
  expect(ran.payload).toMatchObject({ tool_name: 'Bash', tool_use_id: pre.payload.tool_use_id });
  expect(existsSync(join(agent.workFolder, 'asked.txt'))).toBe(true);
});

it("137 — A Write in the work folder asks only once its PreToolUse is answered: PermissionRequest carries the file and its content, the agent suggesting acceptEdits for the session alone; the hook's allow writes the file", async () => {
  const agent = await askingAgent();
  const file = join(agent.workFolder, 'written.txt');
  agent.api.script(turn(toolUse('Write', { file_path: file, content: 'w\n' })), turn('Done.'));
  agent.hooks.hold('PreToolUse');
  agent.hooks.hold('PermissionRequest');
  const session = await startedSession(agent);
  await submitPrompt(agent, session, 'write the file');

  const pre = await agent.hook('PreToolUse');
  const { askedBefore, ask } = await askAfter(agent, pre);
  ask.answer(ALLOW);
  const ran = await agent.hook('PostToolUse');
  await agent.hook('Stop');

  expect(askedBefore).toBe(0);
  expect(ask.payload).toMatchObject({
    tool_name: 'Write',
    tool_input: { file_path: file, content: 'w\n' },
    prompt_id: pre.payload.prompt_id,
    permission_mode: 'default',
    permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
  });
  expect(ask.payload).not.toHaveProperty('tool_use_id');
  expect(ran.payload.tool_use_id).toBe(pre.payload.tool_use_id);
  expect(readFileSync(file, 'utf8')).toBe('w\n');
});

it("137 — A background task's call asks only once its PreToolUse is answered: PermissionRequest carries the task's agent_id and agent_type, as its PreToolUse does, while the session's turn has ended listing the task; the hook's allow runs the call in the task", async () => {
  const agent = await askingAgent();
  const taskPrompt = 'Make the inner file.';
  const input = { command: 'touch inner.txt', description: 'Create inner.txt' };
  agent.api.script(
    turn(
      toolUse('Agent', {
        description: 'Inner file',
        prompt: taskPrompt,
        subagent_type: 'general-purpose',
      }),
    ),
    turn('Started.'),
    // The turn the task's end starts.
    turn('Noted.'),
  );
  agent.api.scriptConversation(taskPrompt, turn(toolUse('Bash', input)), turn('Made.'));
  agent.hooks.hold('PreToolUse');
  agent.hooks.hold('PermissionRequest');
  const session = await startedSession(agent);
  await submitPrompt(agent, session, 'start a task');

  // The session's own call that starts the task, then the task's.
  (await agent.hook('PreToolUse')).answer({});
  const pre = await agent.hook('PreToolUse');
  const { askedBefore, ask } = await askAfter(agent, pre);
  // The ask is held: the session's turn ends meanwhile, the task still running.
  const sessionTurnEnd = await agent.hook('Stop');
  ask.answer(ALLOW);
  const ran = await nextWhere(agent, 'PostToolUse', (payload) => payload.tool_name === 'Bash');
  await agent.hook('SubagentStop');
  await agent.hook('Stop');

  expect(askedBefore).toBe(0);
  expect(sessionTurnEnd.payload).toMatchObject({
    background_tasks: [expect.objectContaining({ type: 'subagent' })],
  });
  expect(ask.payload).toMatchObject({
    tool_name: 'Bash',
    tool_input: input,
    agent_id: expect.any(String),
    agent_type: 'general-purpose',
    permission_mode: 'default',
  });
  expect(ask.payload).not.toHaveProperty('tool_use_id');
  expect(pre.payload).toMatchObject({
    tool_name: 'Bash',
    agent_id: ask.payload.agent_id,
    prompt_id: ask.payload.prompt_id,
    tool_input: input,
  });
  expect(ran.payload).toMatchObject({
    agent_id: ask.payload.agent_id,
    tool_use_id: pre.payload.tool_use_id,
  });
  expect(existsSync(join(agent.workFolder, 'inner.txt'))).toBe(true);
});

it("142 — A Bash call allowed in the terminal whose command fails: PostToolUseFailure with the PreToolUse's tool_use_id, the error, not an interruption; no PostToolUse", async () => {
  const agent = await askingAgent();
  const input = { command: 'exit 3', description: 'Fail on purpose' };
  agent.api.script(turn(toolUse('Bash', input)), turn('Done.'));
  const session = await startedSession(agent);
  await submitPrompt(agent, session, 'fail');

  const pre = await agent.hook('PreToolUse');
  await agent.hook('PermissionRequest');
  await agent.eventually(async () => expect(await session.screen()).toContain(PERMISSION_DIALOG));
  await pressOnDialog(session, 'Enter', (screen) => !screen?.includes(PERMISSION_DIALOG));
  const failure = await agent.hook('PostToolUseFailure');
  await agent.hook('Stop');

  expect(failure.payload).toMatchObject({
    tool_name: 'Bash',
    tool_input: input,
    tool_use_id: pre.payload.tool_use_id,
    prompt_id: pre.payload.prompt_id,
    error: 'Exit code 3',
    is_interrupt: false,
  });
  expect(received(agent, 'PostToolUse')).toEqual([]);
});

it('144 — A "No" amended in the terminal (No selected, Tab, a text, Enter): no hook for the call, the text in its rejected tool_result, the turn going on: PostToolBatch, then Stop', async () => {
  const agent = await askingAgent();
  const amendment = 'use mkdir instead';
  agent.api.script(
    turn(toolUse('Bash', { command: 'touch refused.txt', description: 'Create refused.txt' })),
    turn('Understood.'),
  );
  const session = await startedSession(agent);
  await submitPrompt(agent, session, 'make the file');

  const pre = await agent.hook('PreToolUse');
  await agent.hook('PermissionRequest');
  await agent.eventually(async () => expect(await session.screen()).toContain(PERMISSION_DIALOG));
  await selectOnDialog(session, /❯ 4\. No/u, 'Down', 4);
  await session.press('Tab');
  await agent.eventually(async () =>
    expect(await session.screen()).toContain('❯ 4. No, and tell Claude what to do differently'),
  );
  await session.type(amendment);
  await agent.eventually(async () =>
    expect(await session.screen()).toContain(`❯ 4. No, ${amendment}`),
  );
  await session.press('Enter');
  const batch = await agent.hook('PostToolBatch');
  await agent.hook('Stop');

  expect(batch.payload).toMatchObject({
    prompt_id: pre.payload.prompt_id,
    tool_calls: [
      expect.objectContaining({
        tool_use_id: pre.payload.tool_use_id,
        tool_response: expect.stringMatching(new RegExp(`^${escaped(REFUSED_CALL)}`)),
      }),
    ],
  });
  for (const event of ['PostToolUse', 'PostToolUseFailure', 'PermissionDenied']) {
    expect(received(agent, event)).toEqual([]);
  }
  expect(toolResults(agent.api)).toEqual([
    { text: expect.stringContaining(amendment), isError: true },
  ]);
  expect(existsSync(join(agent.workFolder, 'refused.txt'))).toBe(false);
});

it("146 — Three Reads in one reply, outside the work folder: their PreToolUse come together, and each PermissionRequest only once its own PreToolUse is answered, out of the calls' order, all of the turn's prompt_id; each allowed Read runs", async () => {
  const agent = await askingAgent();
  const outside = join(dirname(agent.workFolder), 'outside');
  mkdirSync(outside);
  const files = ['r1.txt', 'r2.txt', 'r3.txt'].map((name) => join(outside, name));
  for (const file of files) writeFileSync(file, 'read me\n');
  agent.api.script(
    turn(...files.map((file) => toolUse('Read', { file_path: file }))),
    turn('Done.'),
  );
  agent.hooks.hold('PreToolUse');
  agent.hooks.hold('PermissionRequest');
  const session = await startedSession(agent);
  await submitPrompt(agent, session, 'read the files');

  const pres: ReceivedHook[] = [];
  for (const _ of files) pres.push(await agent.hook('PreToolUse'));
  const askedBeforeAnyAnswer = received(agent, 'PermissionRequest').length;
  const asks: ReceivedHook[] = [];
  // Answered out of the calls' order: an ask must follow the answer of its own PreToolUse.
  for (const pre of [pres[2], pres[0], pres[1]] as ReceivedHook[]) {
    pre.answer({});
    asks.push(await agent.hook('PermissionRequest'));
  }
  for (const ask of asks) ask.answer(ALLOW);
  const ran: ReceivedHook[] = [];
  for (const _ of files) ran.push(await agent.hook('PostToolUse'));
  await agent.hook('Stop');

  expect(askedBeforeAnyAnswer).toBe(0);
  expect(asks.map((ask) => ask.payload.tool_input)).toEqual(
    [pres[2], pres[0], pres[1]].map((pre) => pre?.payload.tool_input),
  );
  for (const ask of asks) {
    expect(ask.payload).toMatchObject({
      tool_name: 'Read',
      prompt_id: pres[0]?.payload.prompt_id,
      permission_suggestions: [
        expect.objectContaining({ type: 'addRules', behavior: 'allow', destination: 'session' }),
      ],
    });
    expect(ask.payload).not.toHaveProperty('tool_use_id');
  }
  expect(ran.map((hook) => hook.payload.tool_use_id).sort()).toEqual(
    pres.map((pre) => pre.payload.tool_use_id).sort(),
  );
});

it('147 — In auto mode, a command that needs the server-side check the scripted API does not pass is asked in the terminal alone: the panel, Notification agent_needs_input; staying in auto, the dialog, Notification permission_prompt; never a PermissionRequest; its Yes runs the command', async () => {
  const agent = await askingAgent();
  const made = join(agent.workFolder, 'py.txt');
  agent.api.script(
    turn(
      toolUse('Bash', { command: `python3 -c "open('py.txt','w')"`, description: 'Run python' }),
    ),
    turn('Done.'),
  );
  const session = await startedSession(agent, { permissionMode: 'auto' });
  await submitPrompt(agent, session, 'run python');
  const panel = 'Enter to stay in auto mode';

  await agent.eventually(async () => expect(await session.screen()).toContain(panel));
  await notification(agent, 'agent_needs_input');
  await pressOnDialog(session, 'Enter', (screen) => !screen?.includes(panel));
  await agent.eventually(async () => expect(await session.screen()).toContain(PERMISSION_DIALOG));
  await notification(agent, 'permission_prompt');
  await answerYes(session, PERMISSION_DIALOG, 'Down');
  await agent.hook('PostToolUse');
  await agent.hook('Stop');

  expect(received(agent, 'PermissionRequest')).toEqual([]);
  expect(existsSync(made)).toBe(true);
});
