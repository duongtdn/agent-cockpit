import { expect, it } from 'vitest';
import type { PermissionMode } from '../../src/claude-code/index.ts';
import { readInputBoxView, readScreen } from '../../src/claude-code/screen-reading.ts';
import type { ScreenReading } from '../../src/server/driver.ts';
import type { AgentSession } from '../support/agent-session.ts';
import { eventually as untilItHolds } from '../support/eventually.ts';
import { heldTurn, streamingTurn, toolUse, turn } from '../support/fake-api/index.ts';
import { PATIENCE } from '../support/patience.ts';
import {
  BYPASS_ACCEPTED,
  type ContractCockpit,
  SAID_KEY,
  sessionAfter,
  startContractCockpit,
} from './cockpit-harness.ts';
import { spinnerRow, startContractAgent, submitPrompt } from './harness.ts';

/**
 * What tells a busy agent from an idle one on its screen, with a person's
 * draft in the input box or none: the driver reads it where nothing else
 * tells (a panel's close after a launch prompt opened it), and where to
 * type, and must never take a busy agent for one ready.
 */

/** The draft a person leaves in the box. */
const DRAFT = 'a draft';

/** The mode's hint, the footer's first words, as the agent draws it in each mode the driver runs. */
const MODE_HINTS: Readonly<Record<string, string>> = {
  default: '⏸ manual mode on',
  acceptEdits: '⏵⏵ accept edits on (shift+tab to cycle)',
  plan: '⏸ plan mode on (shift+tab to cycle)',
  bypassPermissions: '⏵⏵ bypass permissions on (shift+tab to cycle)',
};

/**
 * The footer without its hint `← for agents`, which comes and goes with no
 * bearing on the agent's state (seen during a compaction one run, not the next).
 */
const withoutAgentsHint = (footer: string) => footer.replace(/ · ← for agents$/u, '');

const INPUT_BOX: ScreenReading = { shows: 'input-box' };
const NOTHING: ScreenReading = { shows: 'nothing' };

/** What a screen shows of the agent's state: the spinner's row, the box's text, the footer, the driver's reading. */
interface Seen {
  readonly spinner: string | undefined;
  readonly box: string | undefined;
  readonly footer: string;
  readonly reading: ScreenReading;
}

function seen(screen: string): Seen {
  const rows = screen.split('\n');
  const box = readInputBoxView(screen);
  return {
    spinner: spinnerRow(screen),
    box: box?.text.trimEnd(),
    footer:
      box === undefined
        ? ''
        : withoutAgentsHint(
            rows
              .slice(box.lastRow + 2)
              .map((row) => row.trim())
              .filter((row) => row !== '')
              .join('\n'),
          ),
    reading: readScreen(screen),
  };
}

/**
 * The screen once it settled: the box holds what is awaited, and two reads
 * in a row agree on all but the spinner's sign and time (tmux was seen to
 * show a screen half written).
 */
async function settled(
  eventually: <T>(check: () => T | Promise<T>) => Promise<T>,
  session: AgentSession,
  box: string,
  footer: (footer: string) => boolean,
  spinner: (spinner: string | undefined) => boolean = () => true,
): Promise<Seen> {
  const shape = (view: Seen) => ({ ...view, spinner: view.spinner !== undefined });
  return eventually(async () => {
    const first = seen(await session.screen());
    const second = seen(await session.screen());
    expect(second.box).toBe(box);
    expect(footer(second.footer)).toBe(true);
    expect(spinner(second.spinner)).toBe(true);
    expect(shape(second)).toEqual(shape(first));
    return second;
  });
}

/**
 * Waits for the screen of an idle agent: no spinner's row, the box holding
 * what is awaited, the footer given, read as the input box free. The spinner stays a
 * moment past the hook that ends a turn or a compaction, while its own
 * hooks run (`Running PostCompact hooks…`).
 */
async function idleScreen(
  eventually: <T>(check: () => T | Promise<T>) => Promise<T>,
  session: AgentSession,
  box: string,
  footer: string,
): Promise<void> {
  await eventually(async () =>
    expect(seen(await session.screen())).toEqual({
      spinner: undefined,
      box,
      footer,
      reading: INPUT_BOX,
    }),
  );
}

const withHint = (footer: string) => footer.includes('esc to interrupt');
const any = () => true;
/**
 * The compaction's own spinner: until the agent redraws it, the row may
 * still name the `PreCompact` hooks it ran first (`Running PreCompact hooks…`).
 */
const compactingSpinner = (spinner: string | undefined) =>
  spinner?.includes('Compacting conversation…') === true;

/** The cockpit's waits, as the contract agent's: they fail saying what was awaited. */
function waits(cockpit: ContractCockpit) {
  return <T>(check: () => T | Promise<T>): Promise<T> =>
    untilItHolds(check, () => cockpit.api.assertNothingUnexpected(), PATIENCE.agentStep);
}

for (const mode of ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const) {
  it(`120 — In ${mode}, a busy agent (a turn, a compaction) draws its spinner's row above the input box, a draft in the box or none; the footer's "esc to interrupt" shows only over an empty box, and over a draft the footer is the mode's hint alone, busy or idle: the driver reads a busy screen as nothing and an idle one as its input box free to type into, and the cockpit keeps a compaction busy while a draft is in the box`, async () => {
    const cockpit = await startContractCockpit({
      driver: { permissionMode: mode as PermissionMode },
      personsSettings: BYPASS_ACCEPTED,
    });
    const hint = MODE_HINTS[mode] as string;
    const eventually = waits(cockpit);
    // A turn held until the test lets it go, then the compaction's two requests, the first held.
    cockpit.api.script(heldTurn(turn('Ready.')), heldTurn(turn('Summary.')), turn('Summary.'));

    await cockpit.say('get ready');
    await sessionAfter(cockpit, 'busy', 0);
    const turnHeld = await cockpit.api.heldRequest();
    const session = cockpit.terminal(SAID_KEY);
    const busy = await settled(eventually, session, '', withHint);
    await session.type(DRAFT);
    const busyOverDraft = await settled(eventually, session, DRAFT, any);
    const turnEnds = cockpit.timeline.length;
    turnHeld.release();
    await sessionAfter(cockpit, 'idle', turnEnds);
    // Idle over the draft: the footer is the mode's hint alone, as it was while busy.
    await idleScreen(eventually, session, DRAFT, hint);
    await session.press('C-u');
    await idleScreen(
      eventually,
      session,
      '',
      `${hint}${mode === 'default' ? ' · ? for shortcuts' : ''}`,
    );

    const compactionBegins = cockpit.timeline.length;
    await cockpit.submitInTerminal(SAID_KEY, '/compact', 'PreCompact');
    const compactionHeld = await cockpit.api.heldRequest(2);
    const compacting = await settled(eventually, session, '', withHint, compactingSpinner);
    await session.type(DRAFT);
    const compactingOverDraft = await settled(eventually, session, DRAFT, any, compactingSpinner);
    compactionHeld.release();
    await eventually(() =>
      expect(
        cockpit.timeline.some(
          (moment, index) =>
            index >= compactionBegins &&
            'hook' in moment &&
            moment.hook.hook_event_name === 'PostCompact',
        ),
      ).toBe(true),
    );
    await idleScreen(eventually, session, DRAFT, hint);
    const after = await sessionAfter(cockpit, 'idle', compactionBegins);
    const statesOfTheCompaction = cockpit.timeline
      .slice(compactionBegins)
      .flatMap((moment) => ('session' in moment ? [moment.session.state] : []));

    expect(busy).toMatchObject({ footer: `${hint} · esc to interrupt`, reading: NOTHING });
    expect(busy.spinner).toMatch(/…/u);
    expect(busyOverDraft).toMatchObject({ footer: hint, reading: NOTHING });
    expect(busyOverDraft.spinner).toMatch(/…/u);
    expect(compacting).toMatchObject({ footer: `${hint} · esc to interrupt`, reading: NOTHING });
    expect(compacting.spinner).toMatch(/Compacting conversation…/u);
    expect(compactingOverDraft).toMatchObject({ footer: hint, reading: NOTHING });
    expect(compactingOverDraft.spinner).toMatch(/Compacting conversation…/u);
    // Busy from the compaction's start until its PostCompact, though a draft was in the box.
    expect(statesOfTheCompaction).toEqual(['busy', 'idle']);
    expect(after.state).toBe('idle');
  });
}

it("120 — While a hook of a turn runs (UserPromptSubmit, PreToolUse, PostToolUse, Stop), the spinner's row shows above the input box, a draft in the box or none; over the draft the footer is the mode's hint alone: the driver reads each screen as nothing", async () => {
  const agent = await startContractAgent();
  agent.api.script(
    turn(toolUse('Bash', { command: 'true', description: 'Nothing' })),
    turn('Done.'),
  );
  const events = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];
  for (const event of events) agent.hooks.hold(event);
  const session = await agent.startNew();
  await agent.hook('SessionStart');
  // Submitted as the driver submits: an Enter right after SessionStart may be lost.
  const { hook: promptHeld } = await submitPrompt(agent, session, 'go');

  const screens: Record<string, { empty: Seen; overDraft: Seen }> = {};
  for (const event of events) {
    const held = event === 'UserPromptSubmit' ? promptHeld : await agent.hook(event);
    const empty = await settled(agent.eventually, session, '', withHint);
    await session.type(DRAFT);
    const overDraft = await settled(agent.eventually, session, DRAFT, any);
    await session.press('C-u');
    await settled(agent.eventually, session, '', withHint);
    screens[event] = { empty, overDraft };
    held.answer({});
  }

  for (const event of events) {
    const { empty, overDraft } = screens[event] as { empty: Seen; overDraft: Seen };
    expect(empty.spinner).toMatch(/…/u);
    expect(empty).toMatchObject({
      footer: `${MODE_HINTS.default} · esc to interrupt`,
      reading: NOTHING,
    });
    expect(overDraft.spinner).toMatch(/…/u);
    expect(overDraft).toMatchObject({ footer: MODE_HINTS.default, reading: NOTHING });
  }
});

it("126 — While a reply streams over a draft in the input box, the screen shows no spinner's row and the footer is the mode's hint alone: the driver reads it as the input box free to type into, as it reads an idle session with that draft, though the turn runs (no Stop yet); no decision may rest on the screen then", async () => {
  const agent = await startContractAgent();
  // Long enough to stream on, a piece every 20 ms, for longer than the test reads.
  const reply = Array.from(
    { length: 300 },
    (_, index) =>
      `Line ${index + 1} of the reply: some words to wrap and stream, item ${index + 1}.`,
  ).join('\n');
  agent.api.script(streamingTurn(turn(reply)));
  const session = await agent.startNew();
  await agent.hook('SessionStart');
  await submitPrompt(agent, session, 'go');
  const streaming = await agent.waitFor('the reply held as it streams', agent.api.heldRequest());
  await session.type(DRAFT);

  // The spinner's row stays a moment past the first pieces of the reply.
  const whileStreaming = await settled(
    agent.eventually,
    session,
    DRAFT,
    any,
    (spinner) => spinner === undefined,
  );
  const eventsWhileStreaming = agent.hooks.events();
  streaming.release();
  await agent.hook('Stop');
  await idleScreen(agent.eventually, session, DRAFT, MODE_HINTS.default as string);
  const idle = seen(await session.screen());

  expect(eventsWhileStreaming).toContain('UserPromptSubmit');
  expect(eventsWhileStreaming).not.toContain('Stop');
  expect(whileStreaming).toEqual({
    spinner: undefined,
    box: DRAFT,
    footer: MODE_HINTS.default,
    reading: INPUT_BOX,
  });
  expect(whileStreaming).toEqual(idle);
});
