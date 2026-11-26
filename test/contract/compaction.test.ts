import { expect, it } from 'vitest';
import { turn } from '../support/fake-api/index.ts';
import { SAID_KEY, sessionAfter, startContractCockpit } from './cockpit-harness.ts';

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
