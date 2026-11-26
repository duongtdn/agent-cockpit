import { expect, it } from 'vitest';
import { eventually } from '../support/eventually.ts';
import { heldTurn, turn } from '../support/fake-api/index.ts';
import { SAID_KEY, sessionAfter, startContractCockpit } from './cockpit-harness.ts';

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

it('94 — Esc while /compact runs ends it with no PostCompact, and the input box comes back without the busy hint; the driver reads it: the session returns to the idle session it left', async () => {
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
