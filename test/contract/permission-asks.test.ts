import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import type { Ask, AskSettled } from '../../src/shared/ask.ts';
import type { Session } from '../../src/shared/session.ts';
import type { AgentSession } from '../support/agent-session.ts';
import { eventually } from '../support/eventually.ts';
import { toolUse, turn } from '../support/fake-api/index.ts';
import { DENIED_BY_HOOK, escaped, REFUSED_CALL } from '../support/hooks/payload-recording.ts';
import { PATIENCE } from '../support/patience.ts';
import {
  BYPASS_ACCEPTED,
  type ContractCockpit,
  type ContractCockpitOptions,
  type HookPayload,
  SAID_KEY,
  sessionAfter,
  startContractCockpit,
} from './cockpit-harness.ts';
import { toolResults } from './confinement-probes.ts';
import { answerYes, pressOnDialog, selectOnDialog, typeOnDialog } from './dialog-keys.ts';
import { INTERRUPTED_FOR_TOOL_USE, userTexts } from './harness.ts';

/**
 * The cockpit's half of the permission rows: a tool call the agent asks
 * about, held by the cockpit and offered to the app as an ask, met by the
 * real agent. What the agent does with each reply the cockpit writes (an
 * allow, a deny, a remembered rule, the interrupt), and what the cockpit
 * makes of the agent's own answers in its terminal (each Yes, each "No",
 * Esc), of its modes, and of a cockpit closed under a held ask. The
 * agent's half, its payloads met by the hook alone, is
 * `permissions.test.ts`'s.
 */

const PERMISSION_DIALOG = 'Do you want to proceed?';

/** What an app following every ask has seen of them. */
interface AsksSeen {
  /** Each ask, as it was told. */
  readonly asks: Ask[];
  /** Each settlement, as it was told. */
  readonly settled: Settlement[];
}

/** A settlement, with the event of the last hook the cockpit had read when it was told. */
interface Settlement extends AskSettled {
  readonly afterHook: unknown;
}

/** A cockpit, followed as an app follows its asks, and its session's terminal. */
interface AskingCockpit {
  readonly cockpit: ContractCockpit;
  readonly seen: AsksSeen;
  /** The session's terminal, as a person at it sees it: once the session was launched. */
  terminal(): AgentSession;
}

/** Starts a cockpit, following every ask of it from the start, as an app does. */
async function askingCockpit(options?: ContractCockpitOptions): Promise<AskingCockpit> {
  const cockpit = await startContractCockpit(options);
  const seen: AsksSeen = { asks: [], settled: [] };
  cockpit.cockpit.asks.follow('*', (ask) => seen.asks.push(ask));
  cockpit.cockpit.asks.on('settled', (settled) => {
    const afterHook = (cockpit.hooksRead.at(-1)?.body as HookPayload | undefined)?.hook_event_name;
    seen.settled.push({ ...settled, afterHook });
  });
  return { cockpit, seen, terminal: () => cockpit.terminal(SAID_KEY) };
}

/** Waits for something the agent's next steps bring, under their bound; an unscripted request fails it at once. */
function agentWill<T>(cockpit: ContractCockpit, check: () => T): Promise<T> {
  return eventually(check, () => cockpit.api.assertNothingUnexpected(), PATIENCE.agentStep);
}

/** Waits for the ask told at a place of the order the asks were told in. */
function askAt({ cockpit, seen }: AskingCockpit, index: number): Promise<Ask> {
  return agentWill(cockpit, () => {
    const ask = seen.asks[index];
    if (ask === undefined)
      throw new Error(`Waited for ask ${index + 1}; ${seen.asks.length} came.`);
    return ask;
  });
}

/** Waits for the settlement of an ask. */
function settlementOf({ cockpit, seen }: AskingCockpit, id: string): Promise<Settlement> {
  return agentWill(cockpit, () => {
    const settled = seen.settled.find((settlement) => settlement.id === id);
    if (settled === undefined) throw new Error(`Waited for the ask ${id} to be settled.`);
    return settled;
  });
}

/** Waits for the session to end a turn with a reply, as the cockpit's following told it. */
function turnEnded(cockpit: ContractCockpit, reply: string): Promise<Session> {
  return agentWill(cockpit, () => {
    const idle = cockpit.timeline
      .flatMap((moment) => ('session' in moment ? [moment.session] : []))
      .find((session) => session.state === 'idle' && session.lastMessage === reply);
    if (idle === undefined) throw new Error(`Waited for a turn to end on "${reply}".`);
    return idle;
  });
}

/** Waits until the session's terminal shows something, within the agent's step. */
function untilShown(session: AgentSession, text: string): Promise<void> {
  return eventually(
    async () => expect(await session.screen()).toContain(text),
    undefined,
    PATIENCE.agentStep,
  );
}

/** Waits until a dialog is gone from the session's terminal. */
function untilGone(session: AgentSession, text: string): Promise<void> {
  return eventually(
    async () => expect(await session.screen()).not.toContain(text),
    undefined,
    PATIENCE.dialogAnswered,
  );
}

/** Presses a key on the permission dialog, once it shows, until the dialog is gone. */
async function answerDialog(session: AgentSession, key: string): Promise<void> {
  await untilShown(session, PERMISSION_DIALOG);
  await pressOnDialog(session, key, (screen) => !screen?.includes(PERMISSION_DIALOG));
}

/** Gives the events of the hooks the cockpit read, in order. */
function eventsRead(cockpit: ContractCockpit): HookPayload[] {
  return cockpit.hooksRead.map((request) => request.body as HookPayload);
}

/** Gives the hooks the cockpit read of an event and a tool. */
function hooksOf(cockpit: ContractCockpit, event: string, tool: string): HookPayload[] {
  return eventsRead(cockpit).filter(
    (hook) => hook.hook_event_name === event && hook.tool_name === tool,
  );
}

/** Gives the interruption markers the session's transcript records. */
function markersIn(session: AgentSession): string[] {
  return userTexts(session).filter((text) => text.startsWith('[Request interrupted'));
}

/** A `Bash` call of the model's, with the description the agent shows. */
function bash(command: string) {
  return toolUse('Bash', { command, description: `Run ${command}` });
}

/**
 * The port of the listener the session's agent reports its hooks to, as
 * the settings file the cockpit launched it with says.
 */
function hooksPortOf(cockpit: ContractCockpit): number {
  const args = cockpit.launches.at(-1)?.args ?? [];
  const file = args[args.indexOf('--settings') + 1];
  if (file === undefined) throw new Error('The session was launched with no settings file.');
  const settings = JSON.parse(readFileSync(file, 'utf8')) as {
    hooks: Record<string, { hooks: { url?: string }[] }[]>;
  };
  const url = settings.hooks.PostToolUse?.[0]?.hooks[0]?.url;
  if (url === undefined) throw new Error('The settings file sends no PostToolUse to a URL.');
  return Number(new URL(url).port);
}

/**
 * The states, in `/proc/net/tcp`, of a connection whose listener's side is
 * still open: established, being opened, or closed by the agent alone
 * (`CLOSE_WAIT`). Every other state but `LISTEN` follows the listener's own
 * close, which ended the hook, whatever the agent does with its side.
 */
const OPEN_ON_THE_LISTENERS_SIDE: ReadonlySet<string> = new Set(['01', '03', '08']);

/**
 * Counts the connections still open on the listener's side of a port of
 * the loopback: a hook whose request the listener has not ended, or one
 * ended and kept alive, which the listener's server closes after its
 * keep-alive timeout (Node's 5 s) and the agent may close before.
 */
function connectionsOpenTo(port: number): number {
  const local = `:${port.toString(16).toUpperCase().padStart(4, '0')}`;
  return readFileSync('/proc/net/tcp', 'utf8')
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(
      ([, address, , state]) =>
        address?.endsWith(local) && OPEN_ON_THE_LISTENERS_SIDE.has(state ?? ''),
    ).length;
}

/**
 * Waits until no hook of the agent's is left open on the cockpit's
 * listener: each one the agent left open after an answer in its terminal
 * was ended by the cockpit. One it never ended would stay open until the
 * agent exits.
 */
function noHookLeftOpen(cockpit: ContractCockpit): Promise<void> {
  const port = hooksPortOf(cockpit);
  return agentWill(cockpit, () => expect(connectionsOpenTo(port)).toBe(0));
}

/** Every settings file the agent could write a rule into, and what each holds: `null` for none. */
function settingsFiles(cockpit: ContractCockpit): Record<string, string | null> {
  const files = [
    join(cockpit.workFolder, '.claude', 'settings.json'),
    join(cockpit.workFolder, '.claude', 'settings.local.json'),
    join(cockpit.configFolder, 'settings.json'),
    join(cockpit.home, '.claude', 'settings.json'),
  ];
  return Object.fromEntries(
    files.map((file) => [file, existsSync(file) ? readFileSync(file, 'utf8') : null]),
  );
}

/** A folder beside the work folder, inside the run's root, where reading asks. */
function outsideFolder(cockpit: ContractCockpit): string {
  const outside = join(dirname(cockpit.workFolder), 'outside');
  mkdirSync(outside, { recursive: true });
  return outside;
}

/** Writes files into a folder, each holding a line of its own name, giving their paths. */
function filesIn(folder: string, ...names: string[]): string[] {
  return names.map((name) => {
    const file = join(folder, name);
    writeFileSync(file, `${name} read\n`);
    return file;
  });
}

/**
 * Answers an ask in the terminal by an option's digit, once the dialog
 * shows that option.
 *
 * @param index - The ask's place in the order the asks were told in.
 * @returns The ask's settlement.
 */
async function yesByOption(asking: AskingCockpit, index: number, option: string) {
  const ask = await askAt(asking, index);
  const session = asking.terminal();
  await untilShown(session, `${option}. Yes`);
  await typeOnDialog(session, option, (screen) => !screen?.includes(PERMISSION_DIALOG));
  return settlementOf(asking, ask.id);
}

/** Answers the permission dialog "No" with a text, as a person does: No selected, Tab, the text, Enter. */
async function amendedNo(session: AgentSession, text: string): Promise<void> {
  await untilShown(session, PERMISSION_DIALOG);
  await selectOnDialog(session, /❯ \d\. No$/mu, 'Down', 4);
  await session.press('Tab');
  await untilShown(session, 'No, and tell Claude what to do differently');
  await session.type(text);
  await untilShown(session, `No, ${text}`);
  await session.press('Enter');
}

it("137 — The app's allow, through cockpit.asks.answer, of a held Bash call: the agent closes its dialog and runs the call (PostToolUse), the turn going on; the ask settled app", async () => {
  const asking = await askingCockpit();
  const { cockpit } = asking;
  cockpit.api.script(turn(bash('touch allowed.txt')), turn('Done.'));
  await cockpit.say('make the file');
  const session = asking.terminal();

  const ask = await askAt(asking, 0);
  await untilShown(session, PERMISSION_DIALOG);
  await cockpit.cockpit.asks.answer(ask.id, { allow: true });
  await untilGone(session, PERMISSION_DIALOG);
  await turnEnded(cockpit, 'Done.');

  expect(ask).toMatchObject({ tool: 'Bash', answerable: 'app' });
  expect(await settlementOf(asking, ask.id)).toMatchObject({ by: 'app' });
  expect(hooksOf(cockpit, 'PostToolUse', 'Bash')).toHaveLength(1);
  expect(existsSync(join(cockpit.workFolder, 'allowed.txt'))).toBe(true);
});

it("138 — The app's deny with a message, then a bare deny: the model is given the message, then the agent's own text (Permission denied by hook), neither call run, the turn going on to its end", async () => {
  const asking = await askingCockpit();
  const { cockpit } = asking;
  cockpit.api.script(
    turn(bash('touch first.txt')),
    turn(bash('touch second.txt')),
    turn('Understood.'),
  );
  await cockpit.say('make the files');

  const withMessage = await askAt(asking, 0);
  await cockpit.cockpit.asks.answer(withMessage.id, { allow: false, message: 'Not this file' });
  const bare = await askAt(asking, 1);
  await cockpit.cockpit.asks.answer(bare.id, { allow: false });
  await turnEnded(cockpit, 'Understood.');

  expect(toolResults(cockpit.api)).toEqual([
    { text: 'Not this file', isError: true },
    { text: DENIED_BY_HOOK, isError: true },
  ]);
  expect(hooksOf(cockpit, 'PostToolUse', 'Bash')).toEqual([]);
  expect(existsSync(join(cockpit.workFolder, 'first.txt'))).toBe(false);
  expect(existsSync(join(cockpit.workFolder, 'second.txt'))).toBe(false);
});

it('139 — Remembered Bash calls: a compound line remembered (its exact line) runs unasked again; touch remembered (Bash(touch:*)) lets a later touch run unasked, while a compound line with another command still asks', async () => {
  const asking = await askingCockpit();
  const { cockpit, seen } = asking;
  const compound = 'touch c1 && rm -f d1';
  const unmatched = 'touch c2 && rm -f d2';
  cockpit.api.script(
    turn(bash(compound)),
    turn(bash(compound)),
    turn(bash('touch a')),
    turn(bash('touch b')),
    turn(bash(unmatched)),
    turn('Done.'),
  );
  await cockpit.say('make the files');

  const exact = await askAt(asking, 0);
  await cockpit.cockpit.asks.answer(exact.id, { allow: true, remember: 'session' });
  const prefix = await askAt(asking, 1);
  await cockpit.cockpit.asks.answer(prefix.id, { allow: true, remember: 'session' });
  const other = await askAt(asking, 2);
  await cockpit.cockpit.asks.answer(other.id, { allow: true });
  await turnEnded(cockpit, 'Done.');

  expect(seen.asks.map((ask) => ask.input.command)).toEqual([compound, 'touch a', unmatched]);
  expect(
    hooksOf(cockpit, 'PostToolUse', 'Bash').map((hook) => (hook.tool_input as HookPayload).command),
  ).toEqual([compound, compound, 'touch a', 'touch b', unmatched]);
  for (const name of ['c1', 'a', 'b', 'c2']) {
    expect(existsSync(join(cockpit.workFolder, name))).toBe(true);
  }
});

it('139 — A compound line remembered (its exact line) once touch was remembered (Bash(touch:*)): the agent asks again for that same line, more than the rule would let run, never less', async () => {
  const asking = await askingCockpit();
  const { cockpit, seen } = asking;
  const compound = 'touch c && rm -f d';
  cockpit.api.script(
    turn(bash('touch a')),
    turn(bash(compound)),
    turn(bash(compound)),
    turn('Done.'),
  );
  await cockpit.say('make the files');

  const prefix = await askAt(asking, 0);
  await cockpit.cockpit.asks.answer(prefix.id, { allow: true, remember: 'session' });
  const exact = await askAt(asking, 1);
  await cockpit.cockpit.asks.answer(exact.id, { allow: true, remember: 'session' });
  const again = await askAt(asking, 2);
  await cockpit.cockpit.asks.answer(again.id, { allow: true });
  await turnEnded(cockpit, 'Done.');

  expect(seen.asks.map((ask) => ask.input.command)).toEqual(['touch a', compound, compound]);
});

it('140 — Remembered file calls: a Write remembered (Edit(//<path>)) lets a Write and an Edit of the file run unasked, a sibling still asking; a Read remembered (Read(//<path>)) lets the file be read again unasked, a sibling still asking; no settings file written', async () => {
  const asking = await askingCockpit();
  const { cockpit, seen } = asking;
  const written = join(cockpit.workFolder, 'in.txt');
  const sibling = join(cockpit.workFolder, 'in2.txt');
  const [read, readSibling] = filesIn(outsideFolder(cockpit), 'o.txt', 'o2.txt') as [
    string,
    string,
  ];
  cockpit.api.script(
    turn(toolUse('Write', { file_path: written, content: 'w1\n' })),
    turn(toolUse('Write', { file_path: written, content: 'w2\n' })),
    turn(toolUse('Edit', { file_path: written, old_string: 'w2', new_string: 'e2' })),
    turn(toolUse('Write', { file_path: sibling, content: 's\n' })),
    turn(toolUse('Read', { file_path: read })),
    turn(toolUse('Read', { file_path: read })),
    turn(toolUse('Read', { file_path: readSibling })),
    turn('Done.'),
  );
  const settingsBefore = settingsFiles(cockpit);
  await cockpit.say('work on the files');

  const writing = await askAt(asking, 0);
  await cockpit.cockpit.asks.answer(writing.id, { allow: true, remember: 'session' });
  const writingSibling = await askAt(asking, 1);
  await cockpit.cockpit.asks.answer(writingSibling.id, { allow: true });
  const reading = await askAt(asking, 2);
  await cockpit.cockpit.asks.answer(reading.id, { allow: true, remember: 'session' });
  const readingSibling = await askAt(asking, 3);
  await cockpit.cockpit.asks.answer(readingSibling.id, { allow: true });
  await turnEnded(cockpit, 'Done.');

  expect(seen.asks.map((ask) => [ask.tool, ask.input.file_path])).toEqual([
    ['Write', written],
    ['Write', sibling],
    ['Read', read],
    ['Read', readSibling],
  ]);
  expect(readFileSync(written, 'utf8')).toBe('e2\n');
  expect(readFileSync(sibling, 'utf8')).toBe('s\n');
  expect(hooksOf(cockpit, 'PostToolUse', 'Read')).toHaveLength(3);
  expect(settingsFiles(cockpit)).toEqual(settingsBefore);
});

it('141 — In one session, answers in the terminal with the hook held: a Yes by 1, by 2 (the folder for the session) settled terminal at PostToolUse; a Yes whose command fails (row 142) at PostToolUseFailure; an amended "No" (row 144), the agent going on, at PostToolBatch, the session busy, then idle; a Yes by 3 (auto mode) at PostToolUse; no hook the agent left open stays open, the cockpit having ended each', async () => {
  const asking = await askingCockpit();
  const { cockpit } = asking;
  const amendment = 'use mkdir instead';
  cockpit.api.script(
    turn(bash('touch yes-1.txt')),
    turn('Done 1.'),
    turn(bash('touch yes-2.txt')),
    turn('Done 2.'),
    turn(bash('exit 3')),
    turn('Failed.'),
    turn(bash('touch refused.txt')),
    turn('Understood.'),
    turn(bash('touch yes-3.txt')),
    turn('Done 3.'),
  );
  const session = () => asking.terminal();

  await cockpit.say('make file 1');
  const byOne = await yesByOption(asking, 0, '1');
  await turnEnded(cockpit, 'Done 1.');
  await cockpit.send(SAID_KEY, 'make file 2');
  const byTwo = await yesByOption(asking, 1, '2');
  await turnEnded(cockpit, 'Done 2.');

  await cockpit.send(SAID_KEY, 'fail');
  const failing = await askAt(asking, 2);
  await answerDialog(session(), 'Enter');
  const failed = await settlementOf(asking, failing.id);
  await turnEnded(cockpit, 'Failed.');

  await cockpit.send(SAID_KEY, 'make the refused file');
  const refused = await askAt(asking, 3);
  await amendedNo(session(), amendment);
  const amended = await settlementOf(asking, refused.id);
  await turnEnded(cockpit, 'Understood.');
  const states = cockpit.states(SAID_KEY);

  await cockpit.send(SAID_KEY, 'make file 3');
  const byThree = await yesByOption(asking, 4, '3');
  await turnEnded(cockpit, 'Done 3.');
  await noHookLeftOpen(cockpit);

  expect([byOne, byTwo, byThree]).toEqual(
    [1, 2, 3].map(() => expect.objectContaining({ by: 'terminal', afterHook: 'PostToolUse' })),
  );
  expect(failed).toMatchObject({ by: 'terminal', afterHook: 'PostToolUseFailure' });
  expect(amended).toMatchObject({ by: 'terminal', afterHook: 'PostToolBatch' });
  expect(states.slice(states.lastIndexOf('waiting'))).toEqual(['waiting', 'busy', 'idle']);
  expect(toolResults(cockpit.api)).toContainEqual({
    text: expect.stringMatching(new RegExp(`^${escaped(REFUSED_CALL)}[^]*${amendment}`)),
    isError: true,
  });
  for (const made of ['yes-1.txt', 'yes-2.txt', 'yes-3.txt']) {
    expect(existsSync(join(cockpit.workFolder, made))).toBe(true);
  }
  expect(existsSync(join(cockpit.workFolder, 'refused.txt'))).toBe(false);
});

it('143 — A plain "No" in the terminal, then Esc: the agent closes the held hook, each ask settled cancelled, the turn stopped (the marker for tool use) and the session idle', async () => {
  const asking = await askingCockpit();
  const { cockpit } = asking;
  cockpit.api.script(turn(bash('touch no.txt')), turn(bash('touch esc.txt')));
  await cockpit.say('make the file');
  const session = asking.terminal();

  const refused = await askAt(asking, 0);
  await untilShown(session, PERMISSION_DIALOG);
  await selectOnDialog(session, /❯ \d\. No$/mu, 'Down', 4);
  const fromNo = cockpit.timeline.length;
  await pressOnDialog(session, 'Enter', (screen) => !screen?.includes(PERMISSION_DIALOG));
  const refusedSettled = await settlementOf(asking, refused.id);
  const idleAfterNo = await sessionAfter(cockpit, 'idle', fromNo);

  await cockpit.send(SAID_KEY, 'make the other file');
  const left = await askAt(asking, 1);
  const fromEsc = cockpit.timeline.length;
  await answerDialog(session, 'Escape');
  const leftSettled = await settlementOf(asking, left.id);
  const idleAfterEsc = await sessionAfter(cockpit, 'idle', fromEsc);

  expect(refusedSettled).toMatchObject({ by: 'cancelled' });
  expect(leftSettled).toMatchObject({ by: 'cancelled' });
  expect([idleAfterNo.state, idleAfterEsc.state]).toEqual(['idle', 'idle']);
  expect(markersIn(session)).toEqual([INTERRUPTED_FOR_TOOL_USE, INTERRUPTED_FOR_TOOL_USE]);
  expect(hooksOf(cockpit, 'PostToolUse', 'Bash')).toEqual([]);
});

it('145 — cockpit.interrupt on one held ask, then on three: the agent stops each turn on the interrupt reply, one marker for tool use each time; every ask settled cancelled; interrupted, idle', async () => {
  const asking = await askingCockpit();
  const { cockpit, seen } = asking;
  const files = filesIn(outsideFolder(cockpit), 'r1.txt', 'r2.txt', 'r3.txt');
  cockpit.api.script(
    turn(bash('touch held.txt')),
    turn(...files.map((file) => toolUse('Read', { file_path: file }))),
  );
  await cockpit.say('make the file');
  const session = asking.terminal();

  await askAt(asking, 0);
  const one = await cockpit.interrupt(SAID_KEY);
  const markersAfterOne = markersIn(session);
  await cockpit.send(SAID_KEY, 'read the files');
  await askAt(asking, 3);
  const three = await cockpit.interrupt(SAID_KEY);

  expect([one, three]).toEqual([
    { action: 'interrupted', state: 'idle' },
    { action: 'interrupted', state: 'idle' },
  ]);
  expect(markersAfterOne).toEqual([INTERRUPTED_FOR_TOOL_USE]);
  expect(markersIn(session)).toEqual([INTERRUPTED_FOR_TOOL_USE, INTERRUPTED_FOR_TOOL_USE]);
  expect(seen.settled.map((settled) => settled.by)).toEqual(Array(4).fill('cancelled'));
  expect(hooksOf(cockpit, 'PostToolUse', 'Read')).toEqual([]);
  expect(existsSync(join(cockpit.workFolder, 'held.txt'))).toBe(false);
});

it('145 — cockpit.end with a permission held: the interrupt reply stops the turn (its marker recorded) before the signal ends the agent; the ask settled cancelled, the call never run', async () => {
  const asking = await askingCockpit();
  const { cockpit } = asking;
  cockpit.api.script(turn(bash('touch held.txt')));
  await cockpit.say('make the file');

  const ask = await askAt(asking, 0);
  const ended = await cockpit.end(SAID_KEY);

  expect(ended).toEqual({ action: 'ended', stoppedTasks: [] });
  expect(await settlementOf(asking, ask.id)).toMatchObject({ by: 'cancelled' });
  expect(markersIn(asking.terminal())).toEqual([INTERRUPTED_FOR_TOOL_USE]);
  expect(existsSync(join(cockpit.workFolder, 'held.txt'))).toBe(false);
});

it("146 — Three concurrent Reads of three files, answered out of the calls' order (allow, deny, allow): each answer reaches its own call; then three of one file, one remembered: the agent runs all three, each ask settled (app, then terminal at the twins' PostToolUse)", async () => {
  const asking = await askingCockpit();
  const { cockpit, seen } = asking;
  const outside = outsideFolder(cockpit);
  const files = filesIn(outside, 'r1.txt', 'r2.txt', 'r3.txt');
  const [same] = filesIn(outside, 'same.txt') as [string];
  cockpit.api.script(
    turn(...files.map((file) => toolUse('Read', { file_path: file }))),
    turn('Done 1.'),
    turn(...files.map(() => toolUse('Read', { file_path: same }))),
    turn('Done 2.'),
  );
  await cockpit.say('read the files');

  await askAt(asking, 2);
  const askOf = (file: string) => seen.asks.find((ask) => ask.input.file_path === file) as Ask;
  const [r1, r2, r3] = files as [string, string, string];
  await cockpit.cockpit.asks.answer(askOf(r3).id, { allow: true });
  await cockpit.cockpit.asks.answer(askOf(r1).id, { allow: false, message: 'Not r1' });
  await cockpit.cockpit.asks.answer(askOf(r2).id, { allow: true });
  await turnEnded(cockpit, 'Done 1.');
  const readsOfThree = hooksOf(cockpit, 'PostToolUse', 'Read').map(
    (hook) => (hook.tool_input as HookPayload).file_path,
  );

  await cockpit.send(SAID_KEY, 'read it three times');
  const twins = [await askAt(asking, 3), await askAt(asking, 4), await askAt(asking, 5)];
  await cockpit.cockpit.asks.answer((twins[1] as Ask).id, { allow: true, remember: 'session' });
  const twinsSettled = await Promise.all(twins.map((twin) => settlementOf(asking, twin.id)));
  await turnEnded(cockpit, 'Done 2.');

  expect(readsOfThree.sort()).toEqual([r2, r3]);
  expect(toolResults(cockpit.api)).toContainEqual({ text: 'Not r1', isError: true });
  expect(twinsSettled).toEqual([
    expect.objectContaining({ by: 'terminal', afterHook: 'PostToolUse' }),
    expect.objectContaining({ by: 'app' }),
    expect.objectContaining({ by: 'terminal', afterHook: 'PostToolUse' }),
  ]);
  expect(
    hooksOf(cockpit, 'PostToolUse', 'Read').filter(
      (hook) => (hook.tool_input as HookPayload).file_path === same,
    ),
  ).toHaveLength(3);
});

it("147 — In default mode through the cockpit, a touch is offered to the app (answerable app) and the app's answer settles it", async () => {
  const asking = await askingCockpit({ driver: { permissionMode: 'default' } });
  const { cockpit } = asking;
  cockpit.api.script(turn(bash('touch default.txt')), turn('Done.'));
  await cockpit.say('make the file');

  const ask = await askAt(asking, 0);
  await cockpit.cockpit.asks.answer(ask.id, { allow: true });
  await turnEnded(cockpit, 'Done.');

  expect(ask).toMatchObject({ tool: 'Bash', answerable: 'app' });
  expect(await settlementOf(asking, ask.id)).toMatchObject({ by: 'app' });
  expect(existsSync(join(cockpit.workFolder, 'default.txt'))).toBe(true);
});

it.each([
  ['acceptEdits', {}],
  ['bypassPermissions', { personsSettings: BYPASS_ACCEPTED }],
] as const)(
  '147 — In %s mode through the cockpit, a touch runs: no ask',
  async (permissionMode, options) => {
    const asking = await askingCockpit({ driver: { permissionMode }, ...options });
    const { cockpit, seen } = asking;
    cockpit.api.script(turn(bash('touch ran.txt')), turn('Done.'));
    await cockpit.say('make the file');
    await turnEnded(cockpit, 'Done.');

    expect(seen.asks).toEqual([]);
    expect(cockpit.states(SAID_KEY)).not.toContain('waiting');
    expect(existsSync(join(cockpit.workFolder, 'ran.txt'))).toBe(true);
  },
);

it('147 — In dontAsk mode through the cockpit, a touch is denied: no ask, the turn going on', async () => {
  const asking = await askingCockpit({ driver: { permissionMode: 'dontAsk' } });
  const { cockpit, seen } = asking;
  cockpit.api.script(turn(bash('touch denied.txt')), turn('Done.'));
  await cockpit.say('make the file');
  await turnEnded(cockpit, 'Done.');

  expect(seen.asks).toEqual([]);
  expect(cockpit.states(SAID_KEY)).not.toContain('waiting');
  expect(toolResults(cockpit.api)).toEqual([{ text: expect.any(String), isError: true }]);
  expect(existsSync(join(cockpit.workFolder, 'denied.txt'))).toBe(false);
});

it("147 — In auto mode through the cockpit, behind an endpoint that does not pass the server-side check: a touch runs unasked; a python3 command opens an ask answerable in the terminal alone, from the agent's Notification, the session waiting on it; the person's Yes settles it terminal", async () => {
  const asking = await askingCockpit({ driver: { permissionMode: 'auto' } });
  const { cockpit, seen } = asking;
  const python = `python3 -c "open('py.txt','w')"`;
  cockpit.api.script(
    turn(bash('touch auto.txt')),
    turn('Done 1.'),
    turn(bash(python)),
    turn('Done 2.'),
  );
  await cockpit.say('make the file');
  await turnEnded(cockpit, 'Done 1.');
  const askedOfTouch = seen.asks.length;

  await cockpit.send(SAID_KEY, 'run python');
  const ask = await askAt(asking, 0);
  const waiting = await cockpit.sessionIn(SAID_KEY, 'waiting');
  const session = asking.terminal();
  const panel = 'Enter to stay in auto mode';
  await untilShown(session, panel);
  await pressOnDialog(session, 'Enter', (screen) => !screen?.includes(panel));
  await untilShown(session, PERMISSION_DIALOG);
  await answerYes(session, PERMISSION_DIALOG, 'Down');
  const settled = await settlementOf(asking, ask.id);
  await turnEnded(cockpit, 'Done 2.');

  expect(askedOfTouch).toBe(0);
  expect(existsSync(join(cockpit.workFolder, 'auto.txt'))).toBe(true);
  expect(ask).toMatchObject({ tool: 'Bash', input: { command: python }, answerable: 'terminal' });
  expect(waiting).toMatchObject({ pending: [{ kind: 'terminal', id: ask.id }] });
  expect(
    eventsRead(cockpit).filter((hook) => hook.hook_event_name === 'PermissionRequest'),
  ).toEqual([]);
  expect(settled).toMatchObject({ by: 'terminal', afterHook: 'PostToolUse' });
  expect(existsSync(join(cockpit.workFolder, 'py.txt'))).toBe(true);
});

it("147 — In plan mode through the cockpit, behind an endpoint that does not pass the server-side check: a touch opens an ask answerable in the terminal alone, from the agent's Notification; cockpit.interrupt's Esc stops the turn (the marker for tool use), the ask settled cancelled, the call never run", async () => {
  const asking = await askingCockpit({ driver: { permissionMode: 'plan' } });
  const { cockpit } = asking;
  cockpit.api.script(turn(bash('touch plan.txt')));
  await cockpit.say('make the file');

  const ask = await askAt(asking, 0);
  const waiting = await cockpit.sessionIn(SAID_KEY, 'waiting');
  const interrupted = await cockpit.interrupt(SAID_KEY);

  expect(ask).toMatchObject({ tool: 'Bash', answerable: 'terminal' });
  expect(waiting).toMatchObject({ pending: [{ kind: 'terminal', id: ask.id }] });
  expect(interrupted).toEqual({ action: 'interrupted', state: 'idle' });
  expect(await settlementOf(asking, ask.id)).toMatchObject({ by: 'cancelled' });
  expect(markersIn(asking.terminal())).toEqual([INTERRUPTED_FOR_TOOL_USE]);
  expect(existsSync(join(cockpit.workFolder, 'plan.txt'))).toBe(false);
});

/** A listener of the test's own on a port: every hook's payload it takes, each answered `{}`. */
async function listenerOn(port: number): Promise<HookPayload[]> {
  const received: HookPayload[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as HookPayload);
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  return received;
}

it('148 — The cockpit closed under a held ask: the agent keeps its dialog; a Yes in the terminal then reaches a new listener at the same address as the call’s PostToolUse, and the call runs', async () => {
  const asking = await askingCockpit();
  const { cockpit, seen } = asking;
  cockpit.api.script(turn(bash('touch after.txt')), turn('Done.'));
  await cockpit.say('make the file');
  const session = asking.terminal();

  await askAt(asking, 0);
  await untilShown(session, PERMISSION_DIALOG);
  const port = hooksPortOf(cockpit);
  await cockpit.cockpit.close();
  const received = await listenerOn(port);
  await answerDialog(session, 'Enter');
  const ran = await agentWill(cockpit, () => {
    const hook = received.find((payload) => payload.hook_event_name === 'PostToolUse');
    if (hook === undefined) throw new Error('Waited for PostToolUse at the new listener.');
    return hook;
  });

  expect(ran).toMatchObject({ tool_name: 'Bash', tool_input: { command: 'touch after.txt' } });
  expect(seen.settled).toEqual([]);
  expect(existsSync(join(cockpit.workFolder, 'after.txt'))).toBe(true);
});
