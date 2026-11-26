import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { HTTP_HOOK_EVENTS } from '../../src/claude-code/hook-payloads.ts';
import type { HookRequest, LaunchCommand } from '../../src/server/driver.ts';
import { toolUse, turn } from '../support/fake-api/index.ts';
import { type ContractCockpit, SAID_KEY, startContractCockpit } from './cockpit-harness.ts';
import { conversationTexts } from './harness.ts';

/**
 * The Claude Code driver on the real agent: a cockpit as an app makes one
 * launches it, with the driver's own command line, settings file and
 * hooks, and follows it through the core's own listener, which gives the
 * driver a hook only when it carried the session's token.
 */

/** The settings file the driver wrote for a launch, as the agent read it. */
function settingsOf(launch: LaunchCommand | undefined): {
  hooks: Record<string, { hooks: { type: string; headers?: Record<string, string> }[] }[]>;
} {
  const args = launch?.args ?? [];
  const file = args[args.indexOf('--settings') + 1] as string;
  return JSON.parse(readFileSync(file, 'utf8'));
}

function eventOf(request: HookRequest): unknown {
  return (request.body as { hook_event_name?: unknown }).hook_event_name;
}

function hookRead(cockpit: ContractCockpit, event: string): Record<string, unknown> {
  const request = cockpit.hooksRead.find((read) => eventOf(read) === event);
  if (request === undefined) throw new Error(`The driver read no ${event} hook.`);
  return request.body as Record<string, unknown>;
}

it("the driver's own launch: starting, busy, then idle with the answer; its SessionStart command hook reaches the listener with its token; ended on the agent's exit", async () => {
  const cockpit = await startContractCockpit();
  cockpit.api.script(turn('The answer.'));

  expect(await cockpit.say('give the answer')).toEqual({ action: 'started', state: 'busy' });
  const idle = await cockpit.sessionIn(SAID_KEY, 'idle');
  const start = hookRead(cockpit, 'SessionStart');
  const ended = await cockpit.exitByItself(SAID_KEY, String(start.session_id));

  expect(idle).toMatchObject({ state: 'idle', lastMessage: 'The answer.' });
  // The driver gives SessionStart a command hook only: read, it came through the hook's script.
  expect(
    settingsOf(cockpit.launches[0]).hooks.SessionStart?.flatMap((group) =>
      group.hooks.map((hook) => hook.type),
    ),
  ).toEqual(['command']);
  expect(start).toMatchObject({ hook_event_name: 'SessionStart', source: 'startup' });
  expect(ended).toMatchObject({ state: 'ended', reason: 'agent-exit', canResume: true });
  expect(cockpit.states(SAID_KEY)).toEqual(['starting', 'busy', 'idle', 'ended']);
});

it('14 — HTTP hooks carry the configured Authorization header', async () => {
  const cockpit = await startContractCockpit({ driver: { permissions: { allow: ['Bash'] } } });
  cockpit.api.script(turn(toolUse('Bash', { command: 'touch a.txt' })), turn('Touched.'));

  await cockpit.say('touch a file');
  await cockpit.sessionIn(SAID_KEY, 'idle');
  const start = hookRead(cockpit, 'SessionStart');
  await cockpit.exitByItself(SAID_KEY, String(start.session_id));

  const settings = settingsOf(cockpit.launches[0]);
  for (const event of HTTP_HOOK_EVENTS) {
    const hooks = settings.hooks[event]?.flatMap((group) => group.hooks) ?? [];
    expect(
      hooks.map((hook) => hook.type),
      event,
    ).toEqual(['http']);
    expect(hooks[0]?.headers?.Authorization, event).toMatch(/^Bearer \S{43,}$/);
    // The listener passes on a request only when it carried that header.
    expect(cockpit.hooksRead.map(eventOf), event).toContain(event);
  }
});

it('29 — A prompt after -- is read as the prompt, whatever options precede it', async () => {
  const cockpit = await startContractCockpit();
  cockpit.api.script(turn('Read as a prompt.'));
  const looksLikeOptions = '-p --permission-mode bypassPermissions --model opus';

  await cockpit.say(looksLikeOptions);
  const idle = await cockpit.sessionIn(SAID_KEY, 'idle');
  const submitted = hookRead(cockpit, 'UserPromptSubmit');
  const request = await cockpit.api.conversationRequest(1);

  expect(cockpit.launches[0]?.args.slice(-2)).toEqual(['--', looksLikeOptions]);
  expect(submitted).toMatchObject({ prompt: looksLikeOptions, permission_mode: 'default' });
  expect(conversationTexts(request)).toContain(looksLikeOptions);
  expect(idle).toMatchObject({ lastMessage: 'Read as a prompt.' });
});
