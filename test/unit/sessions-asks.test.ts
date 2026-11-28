import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asks } from '../../src/server/asks/asks.ts';
import { SessionHostError } from '../../src/server/session-host/session-host-error.ts';
import type { JobRuns } from '../../src/server/sessions/job-runs.ts';
import {
  createSessions,
  LIVENESS_INTERVAL_MS,
  SCREEN_INTERVAL_MS,
  type Sessions,
} from '../../src/server/sessions/sessions.ts';
import { openUnitsOfWork, type UnitsOfWork } from '../../src/server/sessions/units-of-work.ts';
import { createTerminalHolds } from '../../src/server/terminal-hold.ts';
import type { AskSettled } from '../../src/shared/ask.ts';
import { CockpitError } from '../../src/shared/cockpit-error.ts';
import type { Session } from '../../src/shared/session.ts';
import {
  ASK_PATH,
  ASKED_IN_TERMINAL_PATH,
  CALL_FINISHED_PATH,
  createFakeHolds,
  createFakeHost,
  createMemoryRecords,
  createRecordingHookAccess,
  createStubDriver,
  createTestAsks,
  type FakeHeldHook,
  type FakeHolds,
  type FakeHost,
  PROMPT_PATH,
  type StubDriver,
  stubAsk,
  stubFolders,
  stubScreen,
  TYPING_PATIENCE_MS,
  withdrawnScreen,
} from '../support/sessions-doubles.ts';

const T0 = new Date('2026-11-28T10:00:00.000Z');
const KEY = 'explain-readme';
const OTHER = 'explain-tests';
const DIRECTORY = '/apps/demo';
const PROMPT = 'Explain README.md';

let host: FakeHost;
let driver: StubDriver;
let asks: Asks;
let holds: FakeHolds;
let sessions: Sessions;
/** Every settlement the asks told, in order. */
let told: AskSettled[];

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  host = createFakeHost();
  driver = createStubDriver();
  asks = createTestAsks();
  holds = createFakeHolds();
  told = [];
  asks.on('settled', (settled) => void told.push(settled));
  sessions = createSessions({
    host,
    driver,
    hooks: createRecordingHookAccess(),
    folders: stubFolders(),
    environment: () => ({ PATH: '/usr/bin' }),
    admitAgent: async () => {},
    confinement: async () => ({
      stateRoots: ['/state'],
      appAddresses: [],
      listener: { host: '127.0.0.1', port: 4000 },
    }),
    holds: createTerminalHolds(),
    asks,
    // An agent signalled stays until the test makes it go.
    signal: () => {},
  });
});

afterEach(() => {
  sessions.close();
  vi.useRealTimers();
});

/** Sends a stub hook of a session, held when the core holds it. */
function hook(path: string, key = KEY): void {
  sessions.receive({ key, path, body: {} }, holds.hold);
}

/** Reports what the transcript records, as the driver does outside the hooks. */
function recordInterruption(): void {
  driver.follows.at(-1)?.report([{ type: 'interrupted' }]);
}

const settle = () => vi.advanceTimersByTimeAsync(0);

/** Lets time pass, so that a later `since` tells apart from an earlier one. */
const later = () => vi.advanceTimersByTimeAsync(1_000);

const nowIso = () => new Date().toISOString();

/** Launches a session and brings it to `busy` on its prompt. */
async function busySession(key = KEY): Promise<void> {
  const launched = sessions.launch({ key, directory: DIRECTORY, conversationId: `c-${key}` });
  await settle();
  hook('/ready', key);
  await launched;
  host.show(key, stubScreen('input-box'));
  hook(`${PROMPT_PATH}${PROMPT}`, key);
  host.show(key, 'the agent at work');
}

/** The agent asks a permission about a call: the id of the ask it opened, and its held hook. */
function asked(ref: string, key = KEY): { id: string; held: FakeHeldHook } {
  const before = holds.held.length;
  hook(`${ASK_PATH}${ref}`, key);
  const held = holds.held[before];
  const id = asks.pending(key).at(-1)?.id;
  if (held === undefined || id === undefined) throw new Error(`No ask opened for ${ref}.`);
  return { id, held };
}

/** The agent asks a person about a call in its terminal only: the id of the ask it opened. */
function askedInTerminal(ref: string): string {
  hook(`${ASKED_IN_TERMINAL_PATH}${ref}`);
  const id = asks.pending(KEY).at(-1)?.id;
  if (id === undefined) throw new Error(`No ask opened for ${ref}.`);
  return id;
}

async function exits(key = KEY): Promise<void> {
  host.exit(key);
  await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);
}

function sessionOf(key = KEY): Session | undefined {
  return sessions.session(key);
}

describe('a permission the agent asks', () => {
  it('on a live session is held and opens an ask the app can answer: the session waits on it', async () => {
    await busySession();
    await later();

    const { id, held } = asked('call-1');

    expect(asks.pending(KEY)).toEqual([
      {
        id,
        key: KEY,
        ...stubAsk('call-1').content,
        answerable: 'app',
        since: nowIso(),
      },
    ]);
    expect(held.end).toBe('open');
    expect(sessionOf()).toEqual({
      key: KEY,
      state: 'waiting',
      since: nowIso(),
      pending: [{ kind: 'ask', id }],
    });
  });

  it('on a session still launching is held too', async () => {
    const start = host.holdNextStart();
    const launched = sessions.launch({ key: KEY, directory: DIRECTORY, conversationId: 'c-1' });
    await settle();

    const { id } = asked('call-1');

    expect(sessionOf()).toMatchObject({ state: 'waiting', pending: [{ kind: 'ask', id }] });
    start.open();
    await expect(launched).resolves.toMatchObject({ state: 'waiting' });
  });

  it('opened while its session launched is settled `cancelled`, its hook let go, when that launch fails', async () => {
    const start = host.holdNextStart();
    const launched = sessions.launch({ key: KEY, directory: DIRECTORY, conversationId: 'c-1' });
    launched.catch(() => {});
    await settle();
    const { id, held } = asked('call-1');

    start.fail(new SessionHostError('host-failed', 'tmux failed.'));
    await expect(launched).rejects.toBeInstanceOf(SessionHostError);

    expect(told).toEqual([{ id, key: KEY, by: 'cancelled' }]);
    expect(held.end).toBe('released');
    expect(asks.pending('*')).toEqual([]);
    expect(sessionOf()).toBeUndefined();
  });

  it('as the first hook heard after a start-up dialog lists the ask alone: the dialog was answered', async () => {
    const launched = sessions.launch({ key: KEY, directory: DIRECTORY, conversationId: 'c-1' });
    await settle();
    host.show(KEY, stubScreen('trust-folder'));
    await vi.advanceTimersByTimeAsync(SCREEN_INTERVAL_MS);
    await expect(launched).resolves.toMatchObject({ state: 'waiting' });

    const { id } = asked('call-1');

    expect(sessionOf()).toMatchObject({ state: 'waiting', pending: [{ kind: 'ask', id }] });
  });

  it('answered by a follower as it opens is over at once: the session goes on `busy`', async () => {
    await busySession();
    asks.follow(KEY, (ask) => void asks.answer(ask.id, { allow: true }));

    hook(`${ASK_PATH}call-1`);

    expect(holds.held[0]?.end).toBe('replied');
    expect(told).toMatchObject([{ key: KEY, by: 'app' }]);
    expect(sessionOf()?.state).toBe('busy');
  });

  it('on a session being ended is answered `{}` at once: not held, no ask', async () => {
    await busySession();
    const ended = sessions.end(KEY, 'app');
    ended.catch(() => {});
    await settle();

    hook(`${ASK_PATH}call-1`);

    expect(holds.held).toEqual([]);
    expect(asks.pending('*')).toEqual([]);
    expect(sessionOf()?.state).toBe('busy');
  });

  it('on a session ended, or a key with none, is answered `{}` at once: not held, no ask', async () => {
    await busySession();
    await exits();

    hook(`${ASK_PATH}call-1`);
    hook(`${ASK_PATH}call-2`, OTHER);

    expect(holds.held).toEqual([]);
    expect(asks.pending('*')).toEqual([]);
  });

  it('answered by the app gets the driver’s reply on its hook, settles `app`, and leaves the session `busy` from then', async () => {
    await busySession();
    const { id, held } = asked('call-1');
    await later();

    await asks.answer(id, { allow: true, remember: 'session' });

    expect(held.replies).toEqual([{ answer: { allow: true, remember: 'session' } }]);
    expect(held.end).toBe('replied');
    expect(held.releases).toBe(0);
    expect(told).toEqual([{ id, key: KEY, by: 'app' }]);
    expect(sessionOf()).toEqual({ key: KEY, state: 'busy', since: nowIso() });
  });
});

describe('a call of a pending ask that finished', () => {
  it('settles the ask `terminal`, lets its hook go with `{}`, and leaves the session `busy` from then', async () => {
    await busySession();
    const { id, held } = asked('call-1');
    await later();

    hook(`${CALL_FINISHED_PATH}call-1`);

    expect(told).toEqual([{ id, key: KEY, by: 'terminal' }]);
    expect(held.end).toBe('released');
    expect(asks.pending(KEY)).toEqual([]);
    expect(sessionOf()).toEqual({ key: KEY, state: 'busy', since: nowIso() });
  });

  it('settles only the ask about that call', async () => {
    await busySession();
    const first = asked('call-1');
    const second = asked('call-2');

    hook(`${CALL_FINISHED_PATH}call-2`);

    expect(told).toEqual([{ id: second.id, key: KEY, by: 'terminal' }]);
    expect(first.held.end).toBe('open');
    expect(sessionOf()).toMatchObject({
      state: 'waiting',
      pending: [{ kind: 'ask', id: first.id }],
    });
  });

  it('of no ask, or of one settled already, is ignored', async () => {
    await busySession();
    const { id, held } = asked('call-1');
    await asks.answer(id, { allow: false });
    const session = sessionOf();

    hook(`${CALL_FINISHED_PATH}call-1`);
    hook(`${CALL_FINISHED_PATH}call-9`);

    expect(told).toEqual([{ id, key: KEY, by: 'app' }]);
    expect(held.releases).toBe(0);
    expect(sessionOf()).toBe(session);
  });
});

describe('a held hook the agent closed', () => {
  it('settles its ask `cancelled`, lets nothing go, and leaves the session `busy` until the interruption is read', async () => {
    await busySession();
    const { id, held } = asked('call-1');
    await later();

    held.closeByAgent();

    expect(told).toEqual([{ id, key: KEY, by: 'cancelled' }]);
    expect(held.releases).toBe(0);
    expect(sessionOf()).toEqual({ key: KEY, state: 'busy', since: nowIso() });
    await later();
    recordInterruption();
    expect(sessionOf()).toEqual({ key: KEY, state: 'idle', since: nowIso() });
  });

  it('closed after its ask settled changes nothing', async () => {
    await busySession();
    const { id, held } = asked('call-1');
    hook(`${CALL_FINISHED_PATH}call-1`);
    const session = sessionOf();

    held.closeByAgent();

    expect(told).toEqual([{ id, key: KEY, by: 'terminal' }]);
    expect(sessionOf()).toBe(session);
  });

  it('found closed as the app’s answer is written: settled `cancelled`, the answer refused `already-settled`, nothing let go', async () => {
    await busySession();
    const { id, held } = asked('call-1');
    held.breakUnseen();

    await expect(asks.answer(id, { allow: true })).rejects.toMatchObject({
      code: 'already-settled',
      id,
      by: 'cancelled',
    });
    held.closeByAgent();

    expect(told).toEqual([{ id, key: KEY, by: 'cancelled' }]);
    expect(held.releases).toBe(0);
    expect(sessionOf()?.state).toBe('busy');
  });
});

describe('the asks of a session still pending at the end of a batch, a turn or the session', () => {
  /** A busy session with two asks pending: their ids and held hooks. */
  async function twoAsks(): Promise<{ ids: string[]; held: FakeHeldHook[] }> {
    await busySession();
    const first = asked('call-1');
    const second = asked('call-2');
    await later();
    return { ids: [first.id, second.id], held: [first.held, second.held] };
  }

  it.each([
    ['the batch’s end', '/batch-ended', { key: KEY, state: 'busy', since: T0 }],
    ['the turn’s end', '/turn-ended', { key: KEY, state: 'idle', lastMessage: 'Done.' }],
    [
      'the turn’s failure',
      '/turn-failed',
      { key: KEY, state: 'idle', error: { kind: 'server', message: 'Overloaded.' } },
    ],
  ])('are settled `terminal` each at %s, their hooks let go', async (_, path, after) => {
    const { ids, held } = await twoAsks();

    hook(path);

    expect(told).toEqual(ids.map((id) => ({ id, key: KEY, by: 'terminal' })));
    expect(held.map((each) => each.end)).toEqual(['released', 'released']);
    expect(sessionOf()).toEqual({ ...after, since: nowIso() });
  });

  it('are settled `cancelled` each at the interruption, their hooks let go: `idle`', async () => {
    const { ids, held } = await twoAsks();

    recordInterruption();

    expect(told).toEqual(ids.map((id) => ({ id, key: KEY, by: 'cancelled' })));
    expect(held.map((each) => each.end)).toEqual(['released', 'released']);
    expect(sessionOf()).toEqual({ key: KEY, state: 'idle', since: nowIso() });
  });

  it('are settled `cancelled` each as the session ends, their hooks let go, after its end', async () => {
    const { ids, held } = await twoAsks();
    const statesAsTold: (string | undefined)[] = [];
    asks.on('settled', () => void statesAsTold.push(sessionOf()?.state));

    await exits();

    expect(told).toEqual(ids.map((id) => ({ id, key: KEY, by: 'cancelled' })));
    expect(statesAsTold).toEqual(['ended', 'ended']);
    expect(held.map((each) => each.end)).toEqual(['released', 'released']);
    expect(asks.pending('*')).toEqual([]);
  });

  it('of another session are left pending', async () => {
    await busySession();
    await busySession(OTHER);
    const { id } = asked('call-1', OTHER);

    hook('/batch-ended');

    expect(told).toEqual([]);
    expect(asks.pending('*').map((ask) => ask.id)).toEqual([id]);
  });
});

describe('a permission asked in the terminal only', () => {
  it('opens an ask answerable in the terminal only, holds nothing, and the session waits on it there', async () => {
    await busySession();
    await later();

    const id = askedInTerminal('call-1');

    expect(holds.held).toEqual([]);
    expect(asks.pending(KEY)).toEqual([
      {
        id,
        key: KEY,
        ...stubAsk('call-1').content,
        answerable: 'terminal',
        since: nowIso(),
      },
    ]);
    expect(sessionOf()).toEqual({
      key: KEY,
      state: 'waiting',
      since: nowIso(),
      pending: [{ kind: 'terminal', id }],
    });
    await expect(asks.answer(id, { allow: true })).rejects.toMatchObject({
      code: 'terminal-only',
    });
  });

  it.each([
    ['its call finished', () => hook(`${CALL_FINISHED_PATH}call-1`), 'terminal', 'busy'],
    ['the batch’s end', () => hook('/batch-ended'), 'terminal', 'busy'],
    ['the turn’s end', () => hook('/turn-ended'), 'terminal', 'idle'],
    ['the interruption', recordInterruption, 'cancelled', 'idle'],
  ])('is settled by %s', async (_, act, by, state) => {
    await busySession();
    const id = askedInTerminal('call-1');

    act();

    expect(told).toEqual([{ id, key: KEY, by }]);
    expect(sessionOf()?.state).toBe(state);
  });

  it('on a session being ended opens nothing', async () => {
    await busySession();
    sessions.end(KEY, 'app').catch(() => {});
    await settle();

    hook(`${ASKED_IN_TERMINAL_PATH}call-1`);

    expect(asks.pending('*')).toEqual([]);
  });
});

describe('a session while asks are pending', () => {
  it('takes no first prompt typed after the start once its agent asked: the box that shows then is not typed into', async () => {
    driver.promptFitsLaunch = () => false;
    const launched = sessions.launch({
      key: KEY,
      directory: DIRECTORY,
      conversationId: 'c-1',
      prompt: PROMPT,
    });
    await settle();
    hook('/ready');
    const { id } = asked('call-1');
    await expect(launched).resolves.toMatchObject({ state: 'waiting' });

    const typed = sessions.firstPrompt(KEY);
    typed?.catch(() => {});
    host.show(KEY, stubScreen('input-box'));
    await vi.advanceTimersByTimeAsync(2 * SCREEN_INTERVAL_MS + TYPING_PATIENCE_MS);

    await expect(typed).rejects.toMatchObject({ code: 'wrong-state' });

    expect(host.writes).toEqual([]);
    expect(sessionOf()).toMatchObject({ state: 'waiting', pending: [{ kind: 'ask', id }] });
  });

  it('lists each in the order they opened, `waiting` since the first, through asks opening and settling', async () => {
    await busySession();
    await later();
    const since = nowIso();
    const first = asked('call-1');
    await later();
    const second = askedInTerminal('call-2');
    await later();
    const third = asked('call-3');

    expect(sessionOf()).toEqual({
      key: KEY,
      state: 'waiting',
      since,
      pending: [
        { kind: 'ask', id: first.id },
        { kind: 'terminal', id: second },
        { kind: 'ask', id: third.id },
      ],
    });
    await later();
    hook(`${CALL_FINISHED_PATH}call-2`);
    expect(sessionOf()).toEqual({
      key: KEY,
      state: 'waiting',
      since,
      pending: [
        { kind: 'ask', id: first.id },
        { kind: 'ask', id: third.id },
      ],
    });
  });

  it('stays `waiting` through the hooks of a concurrent call', async () => {
    await busySession();
    const { id } = asked('call-1');
    const session = sessionOf();

    hook('/working');

    expect(sessionOf()).toBe(session);
    expect(sessionOf()).toMatchObject({ state: 'waiting', pending: [{ kind: 'ask', id }] });
  });

  it('is `busy` once the last ask settles, through the app or the terminal', async () => {
    await busySession();
    const first = asked('call-1');
    asked('call-2');

    await asks.answer(first.id, { allow: true });
    expect(sessionOf()?.state).toBe('waiting');
    await later();
    hook(`${CALL_FINISHED_PATH}call-2`);

    expect(sessionOf()).toEqual({ key: KEY, state: 'busy', since: nowIso() });
  });

  it('settled by an interruption is `idle` at the turn’s end, as at its marker', async () => {
    await busySession();
    asked('call-1').held.closeByAgent();
    expect(sessionOf()?.state).toBe('busy');

    hook('/turn-ended');

    expect(sessionOf()).toMatchObject({ state: 'idle', lastMessage: 'Done.' });
  });

  it('is never read as its prompt withdrawn, once an ask opened in its turn', async () => {
    await busySession();
    asked('call-1').held.closeByAgent();

    host.show(KEY, withdrawnScreen(PROMPT));
    await vi.advanceTimersByTimeAsync(3 * SCREEN_INTERVAL_MS);

    expect(sessionOf()?.state).toBe('busy');
  });

  it('refuses a prompt sent `wrong-state`, with what it waits for', async () => {
    await busySession();
    const { id } = asked('call-1');

    const sent = sessions.send(KEY, 'And then?');

    await expect(sent).rejects.toThrow(CockpitError);
    await expect(sent).rejects.toMatchObject({
      code: 'wrong-state',
      state: 'waiting',
      pending: [{ kind: 'ask', id }],
    });
  });
});

describe('the cockpit closed with asks pending', () => {
  it('settles nothing, tells nobody, and lets go of no hook: the listener drops them', async () => {
    await busySession();
    const { held } = asked('call-1');
    const other = asked('call-2');

    sessions.close();
    held.closeByAgent();
    hook('/batch-ended');

    expect(told).toEqual([]);
    expect(other.held.releases).toBe(0);
    expect(other.held.end).toBe('open');
  });
});

describe('a unit of work whose session waits on an ask', () => {
  const JOBS: JobRuns = {
    read(jobId, args) {
      const { file } = args as { file: string };
      const run = {
        jobId,
        key: `explain-${file}`,
        prompt: `Explain ${file}.`,
        args,
        folder: { path: DIRECTORY, relative: '.' },
        fresh: false,
      };
      return { key: run.key, prompt: run.prompt, checked: async () => run };
    },
    makeFolder: async (folder) => folder,
    recordedFolder: async (relative) => ({ path: DIRECTORY, relative }),
  };
  const IDLE_TIMEOUT_MS = 500;
  let units: UnitsOfWork;

  beforeEach(async () => {
    units = await openUnitsOfWork({
      sessions,
      records: createMemoryRecords(),
      jobs: JOBS,
      driver,
      environment: () => ({ PATH: '/usr/bin' }),
      folders: stubFolders(),
      maxSessions: 1,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
    });
    const ran = units.run('explain', { file: 'readme' });
    await settle();
    hook('/start-and-take');
    await ran;
  });

  afterEach(() => units.close());

  it('refuses a run and a send `wrong-state`, with what it waits for; has nothing to open', async () => {
    const { id } = asked('call-1');
    const refusal = { code: 'wrong-state', state: 'waiting', pending: [{ kind: 'ask', id }] };

    await expect(units.run('explain', { file: 'readme' })).rejects.toMatchObject(refusal);
    await expect(units.send(KEY, 'And then?')).rejects.toMatchObject(refusal);
    await expect(units.open(KEY)).resolves.toEqual({ action: 'nothing-to-open', state: 'waiting' });
  });

  it('is never ended for idleness, nor for the cap', async () => {
    asked('call-1');

    const other = units.run('explain', { file: 'tests' });
    other.catch(() => {});
    await vi.advanceTimersByTimeAsync(10 * IDLE_TIMEOUT_MS);

    await expect(other).rejects.toMatchObject({ code: 'session-cap-reached' });
    expect(sessionOf()?.state).toBe('waiting');
    expect(host.kills).toEqual([]);
  });
});
