import { expect, it } from 'vitest';
import type { TranscriptEntry } from '../support/agent-session.ts';
import { eventually } from '../support/eventually.ts';
import { apiError, heldTurn, turn } from '../support/fake-api/index.ts';
import {
  type ContractCockpit,
  type HookPayload,
  SAID_KEY,
  sessionAfter,
  startContractCockpit,
} from './cockpit-harness.ts';
import { inputBoxText } from './harness.ts';

/** The footer's hint while the agent works, which the driver reads the screen by. */
const BUSY_HINT = 'esc to interrupt';

/** The rows below the input box's lower rule: its footer. */
function inputBoxFooter(screen: string): string {
  const rows = screen.split('\n');
  const lastRule = rows.findLastIndex((row) => /^─{8,}$/u.test(row.trim()));
  return rows.slice(lastRule + 1).join('\n');
}

/** A compaction a person asks for, met by a cockpit with the driver's own launch and hooks. */

it('16 — /compact fires PreCompact and PostCompact, and no turn hooks', async () => {
  const cockpit = await startContractCockpit();
  // A turn to compact, then the summary each of the compaction's two requests writes.
  cockpit.api.script(turn('Something to compact.'), turn('The summary.'), turn('The summary.'));

  await cockpit.say('say one line');
  const before = await cockpit.sessionIn(SAID_KEY, 'idle');
  const from = cockpit.timeline.length;
  const began = await cockpit.submitInTerminal(SAID_KEY, '/compact', 'PreCompact');
  const busy = await sessionAfter(cockpit, 'busy', from);
  const after = await sessionAfter(cockpit, 'idle', from);
  const hooks = cockpit.timeline
    .slice(from)
    .flatMap((moment) => ('hook' in moment ? [moment.hook] : []));

  expect(began).toMatchObject({ hook_event_name: 'PreCompact', trigger: 'manual' });
  expect(hooks.map((hook) => hook.hook_event_name)).toEqual(
    expect.arrayContaining(['PreCompact', 'PostCompact']),
  );
  expect(hooks.map((hook) => hook.hook_event_name)).not.toContain('UserPromptSubmit');
  expect(hooks.map((hook) => hook.hook_event_name)).not.toContain('Stop');
  expect(hooks.find((hook) => hook.hook_event_name === 'PostCompact')).toMatchObject({
    trigger: 'manual',
  });
  // The compaction kept the idle session it found, with its idle time.
  expect(busy.state).toBe('busy');
  expect(after).toMatchObject({ state: 'idle', since: before.since });
});

it('94 — Esc while /compact runs ends it with no PostCompact, and the input box comes back without the busy hint; the session returns to the idle session it left', async () => {
  const cockpit = await startContractCockpit();
  // A turn to compact, then the compaction's first request, held until the Esc.
  cockpit.api.script(turn('Something to compact.'), heldTurn());

  await cockpit.say('say one line');
  const before = await cockpit.sessionIn(SAID_KEY, 'idle');
  const from = cockpit.timeline.length;
  await cockpit.submitInTerminal(SAID_KEY, '/compact', 'PreCompact');
  const held = await cockpit.api.heldRequest();
  const session = cockpit.terminal(SAID_KEY);
  await eventually(async () => expect(await session.screen()).toContain(BUSY_HINT));
  const escAt = cockpit.timeline.length;
  await session.press('Escape');
  const after = await sessionAfter(cockpit, 'idle', escAt);
  const hooks = cockpit.timeline
    .slice(from)
    .flatMap((moment) => ('hook' in moment ? [moment.hook.hook_event_name] : []));
  const statesBeforeTheEsc = cockpit.timeline
    .slice(from, escAt)
    .flatMap((moment) => ('session' in moment ? [moment.session.state] : []));

  expect(await held.ended).toBe('client-gone');
  expect(hooks).toContain('PreCompact');
  expect(hooks).not.toContain('PostCompact');
  expect(statesBeforeTheEsc).toEqual(['busy']);
  expect(inputBoxFooter(await session.screen())).not.toContain(BUSY_HINT);
  // The compaction kept the idle session it found, with its idle time.
  expect(after).toEqual(before);
});

/** The text of a transcript's entry: a `system` entry's own, a `user` message's when it is one text. */
function entryText(entry: TranscriptEntry): string | undefined {
  if (typeof entry.content === 'string') return entry.content;
  const message = entry.message as { content?: unknown } | undefined;
  return typeof message?.content === 'string' ? message.content : undefined;
}

/** The texts of the local commands' entries a session's transcript holds, from a count of entries on. */
function commandEntries(cockpit: ContractCockpit, from: number): string[] {
  return cockpit
    .terminal(SAID_KEY)
    .transcript()
    .slice(from)
    .flatMap(
      (entry) => /^<(?:local-command-[a-z]+|command-name)>/.exec(entryText(entry) ?? '') ?? [],
    )
    .map(String);
}

/** The hooks read since a moment of the timeline. */
function hooksSince(cockpit: ContractCockpit, from: number): HookPayload[] {
  return cockpit.timeline.slice(from).flatMap((moment) => ('hook' in moment ? [moment.hook] : []));
}

it("123 — A /compact that fails on an API error fires PreCompact, then StopFailure carrying an agent_id that no SubagentStart named, and no PostCompact; the transcript records the command with <local-command-stderr>; the driver reads the StopFailure as the compaction's end: the session returns to the idle session it left", async () => {
  // The compaction's request is not tried again.
  const cockpit = await startContractCockpit({
    shim: { variables: { CLAUDE_CODE_MAX_RETRIES: '0' } },
  });
  cockpit.api.script(turn('Something to compact.'), apiError(500));

  await cockpit.say('say one line');
  const before = await cockpit.sessionIn(SAID_KEY, 'idle');
  const entriesBefore = cockpit.terminal(SAID_KEY).transcript().length;
  const from = cockpit.timeline.length;
  await cockpit.submitInTerminal(SAID_KEY, '/compact', 'PreCompact');
  const after = await sessionAfter(cockpit, 'idle', from);
  const hooks = hooksSince(cockpit, from);
  const entries = await eventually(() => {
    const written = commandEntries(cockpit, entriesBefore);
    expect(written).toContain('<local-command-stderr>');
    return written;
  });

  expect(hooks.map((hook) => hook.hook_event_name)).toEqual(['PreCompact', 'StopFailure']);
  expect(hooks[1]).toMatchObject({ error: 'server_error', agent_id: expect.any(String) });
  expect(hooks[1]).not.toHaveProperty('agent_type');
  expect(entries).toEqual(['<local-command-caveat>', '<command-name>', '<local-command-stderr>']);
  expect(cockpit.states(SAID_KEY).slice(-2)).toEqual(['busy', 'idle']);
  // The compaction kept the idle session it found, with its idle time.
  expect(after).toEqual(before);
});

it("124 — Esc while /compact runs fires no PostCompact and no StopFailure; the transcript records the <local-command-caveat> entry alone after PreCompact, with no command name and no output; the driver reads it as the compaction's end: the session returns to the idle session it left", async () => {
  const cockpit = await startContractCockpit();
  // A turn to compact, then the compaction's first request, held until the Esc.
  cockpit.api.script(turn('Something to compact.'), heldTurn());

  await cockpit.say('say one line');
  const before = await cockpit.sessionIn(SAID_KEY, 'idle');
  const entriesBefore = cockpit.terminal(SAID_KEY).transcript().length;
  const from = cockpit.timeline.length;
  await cockpit.submitInTerminal(SAID_KEY, '/compact', 'PreCompact');
  const held = await cockpit.api.heldRequest();
  const session = cockpit.terminal(SAID_KEY);
  await eventually(async () => expect(await session.screen()).toContain(BUSY_HINT));
  await session.press('Escape');
  const after = await sessionAfter(cockpit, 'idle', from);
  const entries = await eventually(() => {
    const written = commandEntries(cockpit, entriesBefore);
    expect(written).toContain('<local-command-caveat>');
    return written;
  });

  expect(await held.ended).toBe('client-gone');
  expect(hooksSince(cockpit, from).map((hook) => hook.hook_event_name)).toEqual(['PreCompact']);
  expect(entries).toEqual(['<local-command-caveat>']);
  // The compaction kept the idle session it found, with its idle time.
  expect(after).toEqual(before);
});

it("125 — /context, then /compact submitted at once: /context records its output, with no caveat, whenever it lands, and the session stays busy while the compaction runs; the Esc's <local-command-caveat>, recorded after the compaction began, is what returns the session to the idle session it left", async () => {
  const cockpit = await startContractCockpit();
  // A turn to compact, then the compaction's first request, held until the Esc.
  cockpit.api.script(turn('Something to compact.'), heldTurn());

  await cockpit.say('say one line');
  const before = await cockpit.sessionIn(SAID_KEY, 'idle');
  const session = cockpit.terminal(SAID_KEY);
  const entriesBefore = session.transcript().length;
  const fromContext = cockpit.timeline.length;
  await session.type('/context');
  await session.press('Enter');
  // Taken once the box lets it go: /compact typed now is a command of its own.
  await eventually(async () =>
    expect(inputBoxText(await session.screen()) ?? '/context').not.toContain('/context'),
  );
  const from = cockpit.timeline.length;
  await cockpit.submitInTerminal(SAID_KEY, '/compact', 'PreCompact');
  const held = await cockpit.api.heldRequest();
  const compacting = await sessionAfter(cockpit, 'busy', from);
  // The driver has read /context's output, whenever it was written.
  await eventually(() =>
    expect(
      cockpit.timeline
        .slice(fromContext)
        .some(
          (moment) =>
            'told' in moment &&
            moment.told.some((event) => event.type === 'command-done' && event.entry === 'result'),
        ),
    ).toBe(true),
  );
  await eventually(async () => expect(await session.screen()).toContain(BUSY_HINT));
  const escAt = cockpit.timeline.length;
  await session.press('Escape');
  const after = await sessionAfter(cockpit, 'idle', escAt);
  const caveat = await eventually(() => {
    const written = session
      .transcript()
      .slice(entriesBefore)
      .filter((entry) => entryText(entry)?.startsWith('<local-command-caveat>'));
    expect(written).toHaveLength(1);
    return written[0];
  });
  const statesBeforeTheEsc = cockpit.timeline
    .slice(from, escAt)
    .flatMap((moment) => ('session' in moment ? [moment.session.state] : []));

  expect(await held.ended).toBe('client-gone');
  expect(commandEntries(cockpit, entriesBefore)).toEqual([
    '<command-name>',
    '<local-command-stdout>',
    '<local-command-caveat>',
  ]);
  expect(statesBeforeTheEsc).toEqual(['busy']);
  expect(Date.parse(String(caveat?.timestamp))).toBeGreaterThanOrEqual(
    Date.parse(compacting.since),
  );
  // The compaction kept the idle session it found, with its idle time.
  expect(after).toEqual(before);
});
