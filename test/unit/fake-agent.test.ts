import { setImmediate as afterPendingCallbacks } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { createFakeAgent } from '../support/fake-agent/agent.ts';
import type { HookRunner } from '../support/fake-agent/hook-runner.ts';
import type { TerminalAnswer } from '../support/fake-agent/script.ts';
import { recordedPayload } from '../support/recorded-hooks.ts';

/**
 * The fake agent's ask, where only the order of what reaches it decides:
 * the hook's reply first, then the person's answer in the terminal.
 */

it("leaves the call to the terminal on a reply with no decision: the person's amended No is what it plays", async () => {
  const fired: string[] = [];
  let asked: () => void = () => {};
  const permissionAsked = new Promise<void>((resolve) => {
    asked = resolve;
  });
  const hooks: HookRunner = {
    configures: () => true,
    fire(payload) {
      fired.push(String(payload.hook_event_name));
      if (payload.hook_event_name === 'PermissionRequest') asked();
      return Promise.resolve([{}]);
    },
  };
  let answer: (given: TerminalAnswer) => void = () => {};
  const answered = new Promise<TerminalAnswer>((resolve) => {
    answer = resolve;
  });
  const agent = createFakeAgent({
    prompt: 'Make b.txt',
    steps: [{ do: 'turn', reply: 'Done.', asks: [{ tool: 'Bash', input: { command: 'true' } }] }],
    hooks,
    recorded: (event, where) => recordedPayload(event, where),
    transcript: { recordPrompt() {}, recordReply() {}, recordInterruption() {} },
    released: () => Promise.resolve(),
    answeredInTerminal: () => answered,
    exit: (status) => {
      throw new Error(`exited with ${status}`);
    },
  });

  const playing = agent.start();
  await permissionAsked;
  // Every callback the reply with no decision set off has run: whatever it plays, it played.
  await afterPendingCallbacks();
  const firedOnTheReply = [...fired];
  answer('amended-no');
  await playing;

  expect(firedOnTheReply).toEqual([
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PermissionRequest',
  ]);
  expect(fired.slice(4)).toEqual(['PostToolBatch', 'Stop']);
});
