import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TypingStoppedError, type TypingTerminal } from '../../src/server/driver.ts';
import { SessionHostError } from '../../src/server/session-host/session-host-error.ts';
import {
  createSessions,
  INPUT_BOX_BOUND_MS,
  LIVENESS_INTERVAL_MS,
  PROMPT_BOUND_MS,
  SCREEN_INTERVAL_MS,
  type Sessions,
  SessionsClosedError,
} from '../../src/server/sessions/sessions.ts';
import { START_DEADLINE_MS } from '../../src/server/sessions/start-up-watch.ts';
import { createTerminalHolds, type TerminalHolds } from '../../src/server/terminal-hold.ts';
import type { Session } from '../../src/shared/session.ts';
import {
  CONVERSATION_PATH,
  createFakeHost,
  createRecordingHookAccess,
  createStubDriver,
  type FakeHost,
  PROMPT_PATH,
  type StubDriver,
  stubFolders,
  stubScreen,
  TYPING_PATIENCE_MS,
  typeAsADriverDoes,
} from '../support/sessions-doubles.ts';

const T0 = new Date('2026-11-27T10:00:00.000Z');
const KEY = 'explain-readme';
const DIRECTORY = '/apps/demo';
const CONVERSATION = '3f2c1a9e-8d4b-4c6a-9e1f-0a7b5c3d2e10';

let host: FakeHost;
let driver: StubDriver;
let holds: TerminalHolds;
let sessions: Sessions;
/** Every signal sent, `<pid> <signal>`. */
let signals: string[];
/** The terminal of the page joined to the key's holds: what it was told. */
let pageTerminal: string[];

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  host = createFakeHost();
  driver = createStubDriver();
  holds = createTerminalHolds();
  signals = [];
  pageTerminal = [];
  holds.join(KEY, {
    hold: () => void pageTerminal.push('held'),
    release: () => void pageTerminal.push('released'),
    discard: () => void pageTerminal.push('discarded'),
  });
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
    holds,
    signal: (pid, signal) => void signals.push(`${pid} ${signal}`),
  });
});

afterEach(() => {
  sessions.close();
  vi.useRealTimers();
});

function hook(path: string, key = KEY): void {
  sessions.receive({ key, path, body: {} });
}

const settle = () => vi.advanceTimersByTimeAsync(0);

/** Launches a session and brings it to `idle`, its input box on screen. */
async function idleSession(key = KEY): Promise<void> {
  const launched = sessions.launch({ key, directory: DIRECTORY, conversationId: CONVERSATION });
  await settle();
  hook('/ready', key);
  await launched;
  host.show(key, stubScreen('input-box'));
}

/** Sends a prompt, the outcome kept for the test to look at. */
function sending(prompt = 'Explain the tests.'): Promise<Session> {
  const sent = sessions.send(KEY, prompt);
  sent.catch(() => {});
  return sent;
}

/** A promise whose outcome the test can look at before it awaits it. */
function settledLater<T>(promise: Promise<T> | undefined): {
  promise: Promise<T>;
  readonly outcome: 'fulfilled' | 'rejected' | undefined;
} {
  if (promise === undefined) throw new Error('No promise to follow.');
  let outcome: 'fulfilled' | 'rejected' | undefined;
  promise.then(
    () => {
      outcome = 'fulfilled';
    },
    () => {
      outcome = 'rejected';
    },
  );
  return {
    promise,
    get outcome() {
      return outcome;
    },
  };
}

/** The writes into the key's session, without its name. */
function writes(): string[] {
  return host.writes.map((write) => write.slice(KEY.length + 1));
}

describe('a prompt sent to an `idle` session', () => {
  it("is typed by the driver into the session's terminal, and resolves `busy` once the agent took it", async () => {
    await idleSession();

    const sent = sending('Explain the tests.');
    await settle();
    hook(`${PROMPT_PATH}Explain the tests.`);

    await expect(sent).resolves.toMatchObject({ key: KEY, state: 'busy' });
    expect(writes()).toEqual(['C-u', 'text:Explain the tests.', 'Enter', 'C-y']);
  });

  it("holds the page's terminals' keys from the first write to the last, then releases them", async () => {
    await idleSession();
    const typing = driver.typePrompt;
    driver.typePrompt = async (prompt, terminal) => {
      expect(pageTerminal).toEqual(['held']);
      return typing(prompt, terminal);
    };

    const sent = sending();
    await settle();
    hook(`${PROMPT_PATH}Explain the tests.`);
    await sent;

    expect(pageTerminal).toEqual(['held', 'released']);
  });

  it('counts a prompt the agent took before the driver asked', async () => {
    await idleSession();
    driver.typePrompt = async (prompt, terminal) => {
      await terminal.pressKeys(['Enter']);
      hook(`${PROMPT_PATH}${prompt}`);
      return (await terminal.promptTaken(prompt, 0)) ? 'taken' : 'not-taken';
    };

    await expect(sending()).resolves.toMatchObject({ state: 'busy' });
  });

  it(`fails \`prompt-not-taken\` when the agent took none within the driver's patience, the keys released`, async () => {
    await idleSession();

    const sent = sending();
    await vi.advanceTimersByTimeAsync(TYPING_PATIENCE_MS);

    await expect(sent).rejects.toMatchObject({
      code: 'prompt-not-taken',
      key: KEY,
      state: 'idle',
    });
    expect(pageTerminal).toEqual(['held', 'released']);
  });

  it('fails `wrong-state`, with the state, when the driver found no input box to type into', async () => {
    await idleSession();
    driver.typePrompt = async () => 'no-input-box';

    await expect(sending()).rejects.toMatchObject({ code: 'wrong-state', state: 'idle' });
    expect(pageTerminal).toEqual(['held', 'released']);
  });

  it('is never typed while the screen shows anything but the input box: `wrong-state`, nothing written', async () => {
    await idleSession();
    host.show(KEY, stubScreen('dialog'));

    await expect(sending()).rejects.toMatchObject({ code: 'wrong-state', state: 'idle' });
    expect(writes()).toEqual([]);
  });

  it('stops at the first write after the agent began a turn by itself: `wrong-state`, `busy`', async () => {
    await idleSession();
    let terminalOf: TypingTerminal | undefined;
    driver.typePrompt = async (prompt, terminal) => {
      terminalOf = terminal;
      await terminal.pressKeys(['C-u']);
      hook(`${PROMPT_PATH}<task-notification>`);
      return typeAsADriverDoes(prompt, terminal);
    };

    await expect(sending()).rejects.toMatchObject({ code: 'wrong-state', state: 'busy' });
    expect(writes()).toEqual(['C-u']);
    // Refused once, every later write is refused too.
    await expect(terminalOf?.pressKeys(['C-y'])).rejects.toThrow();
  });

  it("puts the person's draft back during the prompt's own turn, but not once another prompt was taken", async () => {
    await idleSession();
    driver.typePrompt = async (prompt, terminal) => {
      await terminal.pressKeys(['Enter']);
      hook(`${PROMPT_PATH}${prompt}`);
      await terminal.promptTaken(prompt, 0);
      await terminal.pressKeys(['C-y']);
      hook(`${PROMPT_PATH}another`);
      await terminal.pressKeys(['BSpace']);
      return 'taken';
    };

    await expect(sending()).rejects.toMatchObject({ code: 'wrong-state', state: 'busy' });
    expect(writes()).toEqual(['Enter', 'C-y']);
  });

  it("refuses to put the person's draft back during the prompt's own turn once the agent used a tool, which may ask over the box", async () => {
    await idleSession();
    driver.typePrompt = async (prompt, terminal) => {
      await terminal.pressKeys(['Enter']);
      hook(`${PROMPT_PATH}${prompt}`);
      await terminal.promptTaken(prompt, 0);
      hook('/working');
      await expect(terminal.pressKeys(['C-y'])).rejects.toThrow(TypingStoppedError);
      await expect(terminal.restoring.pressKeys(['C-y'])).rejects.toThrow(TypingStoppedError);
      return 'taken';
    };

    await expect(sending()).resolves.toMatchObject({ state: 'busy' });
    expect(writes()).toEqual(['Enter']);
  });

  it("lets the driver put the person's draft back once the typing stopped, while the screen shows the input box", async () => {
    await idleSession();
    driver.typePrompt = async (prompt, terminal) => {
      await terminal.pressKeys(['C-u']);
      hook(`${PROMPT_PATH}<task-notification>`);
      await expect(terminal.typeText(prompt)).rejects.toThrow(TypingStoppedError);
      await terminal.restoring.pressKeys(['C-y']);
      return 'no-input-box';
    };

    await expect(sending()).rejects.toMatchObject({ code: 'wrong-state', state: 'busy' });
    expect(writes()).toEqual(['C-u', 'C-y']);
  });

  it('refuses to put the draft back once the agent used a tool, which may ask over the box', async () => {
    await idleSession();
    driver.typePrompt = async (prompt, terminal) => {
      await terminal.pressKeys(['C-u']);
      hook(`${PROMPT_PATH}<task-notification>`);
      hook('/working');
      await expect(terminal.typeText(prompt)).rejects.toThrow(TypingStoppedError);
      await expect(terminal.restoring.pressKeys(['C-y'])).rejects.toThrow(TypingStoppedError);
      return { draftLeft: 'In the kill ring.' };
    };

    await expect(sending()).rejects.toMatchObject({ code: 'wrong-state', state: 'busy' });
    expect(writes()).toEqual(['C-u']);
  });

  it('refuses to put the draft back while the screen shows no input box, and every write after', async () => {
    await idleSession();
    let terminalOf: TypingTerminal | undefined;
    driver.typePrompt = async (prompt, terminal) => {
      terminalOf = terminal;
      await terminal.pressKeys(['C-u']);
      host.show(KEY, stubScreen('dialog'));
      await expect(terminal.typeText(prompt)).rejects.toThrow(TypingStoppedError);
      await expect(terminal.restoring.pressKeys(['C-y'])).rejects.toThrow(TypingStoppedError);
      host.show(KEY, stubScreen('input-box'));
      await expect(terminal.restoring.pressKeys(['C-y'])).rejects.toThrow(TypingStoppedError);
      return { draftLeft: 'The draft is in the kill ring: Ctrl+Y brings it back.' };
    };

    const refused = await sending().catch((error: unknown) => error);

    expect(refused).toMatchObject({
      code: 'wrong-state',
      state: 'idle',
      message: expect.stringContaining('The draft is in the kill ring: Ctrl+Y brings it back.'),
    });
    expect(writes()).toEqual(['C-u']);
    // The typing over, nothing more is written.
    await expect(terminalOf?.restoring.pressKeys(['C-y'])).rejects.toThrow(TypingStoppedError);
  });

  it('stops when the session ends while it is typed', async () => {
    await idleSession();
    driver.typePrompt = async (prompt, terminal) => {
      host.exit(KEY);
      return typeAsADriverDoes(prompt, terminal);
    };

    await expect(sending()).rejects.toMatchObject({ code: 'wrong-state' });
    expect(writes()).toEqual([]);
  });

  it('stops when the session is gone as the driver reads its screen: `wrong-state`, no error of the host', async () => {
    await idleSession();
    driver.typePrompt = async (prompt, terminal) => {
      await terminal.pressKeys(['C-u']);
      host.exit(KEY);
      await expect(terminal.readScreen()).rejects.toThrow(TypingStoppedError);
      await expect(terminal.restoring.readScreen()).rejects.toThrow(TypingStoppedError);
      return typeAsADriverDoes(prompt, terminal);
    };

    await expect(sending()).rejects.toMatchObject({ code: 'wrong-state', key: KEY });
  });

  it.each([
    ['starting', [] as string[]],
    ['busy', ['/prompt-taken']],
  ])('is refused on `%s` with `wrong-state`, nothing typed', async (state, paths) => {
    const launched = sessions.launch({
      key: KEY,
      directory: DIRECTORY,
      conversationId: CONVERSATION,
      prompt: 'Hi',
    });
    launched.catch(() => {});
    await settle();
    for (const path of paths) hook(path);

    await expect(sending()).rejects.toMatchObject({ code: 'wrong-state', key: KEY, state });
    expect(writes()).toEqual([]);
    expect(pageTerminal).toEqual([]);
  });

  it('is refused with `wrong-state` on a key with no session', async () => {
    await expect(sending()).rejects.toMatchObject({ code: 'wrong-state', key: KEY });
  });
});

describe('a first prompt too long for the command line', () => {
  beforeEach(() => {
    driver.promptFitsLaunch = () => false;
  });

  it('is launched with none, typed once the agent is ready, the session `starting` until the agent took it', async () => {
    // Patient past the bound a launch prompt is read on screen after: the box shows meanwhile.
    driver.typePrompt = async (prompt, terminal) => {
      await terminal.typeText(prompt);
      await terminal.pressKeys(['Enter']);
      return (await terminal.promptTaken(prompt, 2 * PROMPT_BOUND_MS)) ? 'taken' : 'not-taken';
    };
    const launched = sessions.launch({
      key: KEY,
      directory: DIRECTORY,
      conversationId: CONVERSATION,
      prompt: 'A long prompt.',
    });
    let settled: Session | undefined;
    void launched.then((session) => {
      settled = session;
    });
    await settle();
    expect(driver.launches[0]).not.toHaveProperty('prompt');
    host.show(KEY, stubScreen('input-box'));

    hook('/ready');
    await settle();
    expect(writes()).toEqual(['text:A long prompt.', 'Enter']);
    await vi.advanceTimersByTimeAsync(PROMPT_BOUND_MS + 1000);
    expect(settled).toBeUndefined();
    expect(sessions.session(KEY)?.state).toBe('starting');

    hook(`${PROMPT_PATH}A long prompt.`);

    await expect(launched).resolves.toMatchObject({ state: 'busy' });
    expect(pageTerminal).toEqual(['held', 'released']);
  });

  it('asks the driver once whether the prompt fits the command line', async () => {
    const asked: string[] = [];
    driver.promptFitsLaunch = (prompt) => {
      asked.push(prompt);
      return false;
    };

    const launched = sessions.launch({
      key: KEY,
      directory: DIRECTORY,
      conversationId: CONVERSATION,
      prompt: 'A long prompt.',
    });
    launched.catch(() => {});
    await settle();

    expect(asked).toEqual(['A long prompt.']);
  });

  it('fails the launch `prompt-not-taken` when the agent did not take it: the session is `idle`', async () => {
    const launched = sessions.launch({
      key: KEY,
      directory: DIRECTORY,
      conversationId: CONVERSATION,
      prompt: 'A long prompt.',
    });
    launched.catch(() => {});
    await settle();
    host.show(KEY, stubScreen('input-box'));
    hook('/ready');

    await vi.advanceTimersByTimeAsync(TYPING_PATIENCE_MS);

    await expect(launched).rejects.toMatchObject({ code: 'prompt-not-taken', state: 'idle' });
    expect(sessions.session(KEY)?.state).toBe('idle');
  });

  it('waits for the input box the agent draws after it said it started: nothing typed on a blank screen', async () => {
    const launched = sessions.launch({
      key: KEY,
      directory: DIRECTORY,
      conversationId: CONVERSATION,
      prompt: 'A long prompt.',
    });
    await settle();

    hook('/ready');
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes()).toEqual([]);
    expect(sessions.session(KEY)?.state).toBe('starting');

    host.show(KEY, stubScreen('input-box'));
    await vi.advanceTimersByTimeAsync(SCREEN_INTERVAL_MS);
    expect(writes()).toContain('text:A long prompt.');
    hook(`${PROMPT_PATH}A long prompt.`);

    await expect(launched).resolves.toMatchObject({ state: 'busy' });
  });

  it('fails the launch `wrong-state`, nothing typed, when no input box showed within its bound: the session is `idle`', async () => {
    const launched = sessions.launch({
      key: KEY,
      directory: DIRECTORY,
      conversationId: CONVERSATION,
      prompt: 'A long prompt.',
    });
    launched.catch(() => {});
    await settle();
    hook('/ready');

    await vi.advanceTimersByTimeAsync(INPUT_BOX_BOUND_MS - SCREEN_INTERVAL_MS);
    expect(sessions.session(KEY)?.state).toBe('starting');
    await vi.advanceTimersByTimeAsync(2 * SCREEN_INTERVAL_MS);

    await expect(launched).rejects.toMatchObject({ code: 'wrong-state', state: 'idle' });
    expect(writes()).toEqual([]);
    expect(sessions.session(KEY)?.state).toBe('idle');
  });

  it('stops waiting for the box when the session ends meanwhile: the launch resolves `ended`, nothing typed', async () => {
    const launched = sessions.launch({
      key: KEY,
      directory: DIRECTORY,
      conversationId: CONVERSATION,
      prompt: 'A long prompt.',
    });
    await settle();
    hook('/ready');
    await vi.advanceTimersByTimeAsync(SCREEN_INTERVAL_MS);

    host.exit(KEY);
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);

    await expect(launched).resolves.toMatchObject({ state: 'ended' });
    await vi.advanceTimersByTimeAsync(INPUT_BOX_BOUND_MS);
    expect(writes()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles the launch `waiting` while a dialog shows in place of the box, then types once the box shows, `starting` again: the first prompt settles once the agent took it', async () => {
    const launched = sessions.launch({
      key: KEY,
      directory: DIRECTORY,
      conversationId: CONVERSATION,
      prompt: 'A long prompt.',
    });
    await settle();
    hook('/ready');
    host.show(KEY, stubScreen('dialog'));
    await vi.advanceTimersByTimeAsync(SCREEN_INTERVAL_MS);

    await expect(launched).resolves.toMatchObject({
      state: 'waiting',
      pending: [{ kind: 'terminal' }],
    });
    const firstPrompt = settledLater(sessions.firstPrompt(KEY));
    await vi.advanceTimersByTimeAsync(3 * INPUT_BOX_BOUND_MS);
    expect(writes()).toEqual([]);
    expect(sessions.session(KEY)?.state).toBe('waiting');
    expect(firstPrompt.outcome).toBeUndefined();

    host.show(KEY, stubScreen('input-box'));
    await vi.advanceTimersByTimeAsync(SCREEN_INTERVAL_MS);
    expect(writes()).toContain('text:A long prompt.');
    expect(sessions.session(KEY)?.state).toBe('starting');
    hook(`${PROMPT_PATH}A long prompt.`);

    await expect(firstPrompt.promise).resolves.toMatchObject({ state: 'busy' });
  });

  it('is typed once the person answered a start-up dialog: the launch settles `waiting`, the first prompt once the agent took it', async () => {
    const launched = sessions.launch({
      key: KEY,
      directory: DIRECTORY,
      conversationId: CONVERSATION,
      prompt: 'A long prompt.',
    });
    await settle();
    host.show(KEY, stubScreen('trust-folder'));
    await vi.advanceTimersByTimeAsync(300);
    await expect(launched).resolves.toMatchObject({
      state: 'waiting',
      pending: [{ kind: 'terminal', dialog: 'trust-folder' }],
    });
    const firstPrompt = settledLater(sessions.firstPrompt(KEY));
    expect(firstPrompt.outcome).toBeUndefined();

    host.show(KEY, stubScreen('input-box'));
    hook('/ready');
    await settle();
    hook(`${PROMPT_PATH}A long prompt.`);

    await expect(firstPrompt.promise).resolves.toMatchObject({ state: 'busy' });
    expect(writes()).toContain('text:A long prompt.');
  });

  it('fails the first prompt typed after a start-up dialog when it was not taken: `prompt-not-taken`, the session `idle`', async () => {
    const launched = sessions.launch({
      key: KEY,
      directory: DIRECTORY,
      conversationId: CONVERSATION,
      prompt: 'A long prompt.',
    });
    await settle();
    host.show(KEY, stubScreen('trust-folder'));
    await vi.advanceTimersByTimeAsync(300);
    await expect(launched).resolves.toMatchObject({ state: 'waiting' });
    const firstPrompt = settledLater(sessions.firstPrompt(KEY));

    host.show(KEY, stubScreen('input-box'));
    hook('/ready');
    await vi.advanceTimersByTimeAsync(TYPING_PATIENCE_MS);

    await expect(firstPrompt.promise).rejects.toMatchObject({
      code: 'prompt-not-taken',
      state: 'idle',
    });
    expect(sessions.session(KEY)?.state).toBe('idle');
  });

  it('settles the first prompt `ended` when the session ends while a start-up dialog waits, nothing typed', async () => {
    const launched = sessions.launch({
      key: KEY,
      directory: DIRECTORY,
      conversationId: CONVERSATION,
      prompt: 'A long prompt.',
    });
    await settle();
    host.show(KEY, stubScreen('trust-folder'));
    await vi.advanceTimersByTimeAsync(300);
    await launched;

    const ended = sessions.end(KEY, 'restarted');
    await settle();
    host.exit(KEY);
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);
    await ended;

    await expect(sessions.firstPrompt(KEY)).resolves.toMatchObject({
      state: 'ended',
      reason: 'restarted',
    });
    expect(writes()).toEqual([]);
  });

  /** Launches with a long first prompt, the agent ready, then a dialog in place of its box: the launch settled `waiting`. */
  async function parkedAfterReady(): Promise<void> {
    const launched = sessions.launch({
      key: KEY,
      directory: DIRECTORY,
      conversationId: CONVERSATION,
      prompt: 'A long prompt.',
    });
    await settle();
    hook('/ready');
    host.show(KEY, stubScreen('dialog'));
    await vi.advanceTimersByTimeAsync(SCREEN_INTERVAL_MS);
    await expect(launched).resolves.toMatchObject({ state: 'waiting' });
  }

  it('settles the first prompt `ended` when the session is ended while a dialog shown once the agent was ready waits, nothing typed', async () => {
    await parkedAfterReady();

    const ended = sessions.end(KEY, 'restarted');
    await settle();
    host.exit(KEY);
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);
    await ended;

    await expect(sessions.firstPrompt(KEY)).resolves.toMatchObject({
      state: 'ended',
      reason: 'restarted',
    });
    expect(writes()).toEqual([]);
  });

  it('settles the first prompt `ended` when the agent exits while a dialog shown once it was ready waits', async () => {
    await parkedAfterReady();

    host.exit(KEY);
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);

    await expect(sessions.firstPrompt(KEY)).resolves.toMatchObject({ state: 'ended' });
    expect(writes()).toEqual([]);
  });

  it('settles the first prompt `ended` when the agent exits while its input box is awaited past a dialog and the screen cannot be read (scrolled back)', async () => {
    const launched = sessions.launch({
      key: KEY,
      directory: DIRECTORY,
      conversationId: CONVERSATION,
      prompt: 'A long prompt.',
    });
    await settle();
    hook('/ready');
    host.show(KEY, stubScreen('dialog'));
    await vi.advanceTimersByTimeAsync(SCREEN_INTERVAL_MS);
    await launched;
    host.scrollBack(KEY, true);
    await vi.advanceTimersByTimeAsync(3 * INPUT_BOX_BOUND_MS);

    host.exit(KEY);
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);

    await expect(sessions.firstPrompt(KEY)).resolves.toMatchObject({ state: 'ended' });
  });

  it('rejects the first prompt still to be typed once the core is closed', async () => {
    const launched = sessions.launch({
      key: KEY,
      directory: DIRECTORY,
      conversationId: CONVERSATION,
      prompt: 'A long prompt.',
    });
    await settle();
    host.show(KEY, stubScreen('trust-folder'));
    await vi.advanceTimersByTimeAsync(300);
    await launched;

    sessions.close();

    await expect(sessions.firstPrompt(KEY)).rejects.toThrow(SessionsClosedError);
  });

  it('has no first prompt to tell of when the prompt went on the command line', async () => {
    driver.promptFitsLaunch = () => true;
    const launched = sessions.launch({
      key: KEY,
      directory: DIRECTORY,
      conversationId: CONVERSATION,
      prompt: 'A short prompt.',
    });
    await settle();
    hook('/start-and-take');
    await launched;

    expect(sessions.firstPrompt(KEY)).toBeUndefined();
  });

  it("holds the page's terminals' keys from the agent's start, through the wait for the box and the typing", async () => {
    const launched = sessions.launch({
      key: KEY,
      directory: DIRECTORY,
      conversationId: CONVERSATION,
      prompt: 'A long prompt.',
    });
    await settle();

    hook('/ready');
    await settle();
    expect(pageTerminal).toEqual(['held']);
    host.show(KEY, stubScreen('input-box'));
    await vi.advanceTimersByTimeAsync(SCREEN_INTERVAL_MS);
    hook(`${PROMPT_PATH}A long prompt.`);

    await expect(launched).resolves.toMatchObject({ state: 'busy' });
    expect(pageTerminal).toEqual(['held', 'released']);
  });

  it("discards the page's terminals' keys kept when a dialog shows in place of the box, then lets them through for the person to answer it, held again once the box shows", async () => {
    void sessions.launch({
      key: KEY,
      directory: DIRECTORY,
      conversationId: CONVERSATION,
      prompt: 'A long prompt.',
    });
    await settle();
    hook('/ready');
    host.show(KEY, stubScreen('dialog'));
    await vi.advanceTimersByTimeAsync(SCREEN_INTERVAL_MS);
    // Kept for the box, they would answer a dialog the person had not seen.
    expect(pageTerminal).toEqual(['held', 'discarded', 'released']);

    host.show(KEY, stubScreen('input-box'));
    await vi.advanceTimersByTimeAsync(SCREEN_INTERVAL_MS);
    expect(pageTerminal).toEqual(['held', 'discarded', 'released', 'held']);
    hook(`${PROMPT_PATH}A long prompt.`);

    await expect(sessions.firstPrompt(KEY)).resolves.toMatchObject({ state: 'busy' });
    expect(pageTerminal).toEqual(['held', 'discarded', 'released', 'held', 'released']);
  });

  it('types nothing into a session no longer `starting` once the box shows: the launch fails `wrong-state` with its state', async () => {
    const launched = sessions.launch({
      key: KEY,
      directory: DIRECTORY,
      conversationId: CONVERSATION,
      prompt: 'A long prompt.',
    });
    launched.catch(() => {});
    await settle();
    hook('/ready');
    // A prompt of a person's own, typed in the terminal: the agent began its turn.
    hook('/prompt-taken');

    host.show(KEY, stubScreen('input-box'));
    await vi.advanceTimersByTimeAsync(SCREEN_INTERVAL_MS);

    await expect(launched).rejects.toMatchObject({ code: 'wrong-state', state: 'busy' });
    expect(writes()).toEqual([]);
    expect(sessions.session(KEY)?.state).toBe('busy');
    expect(pageTerminal).toEqual(['held', 'released']);
  });
});

describe('ending a live session gracefully', () => {
  it("sends the driver's signal to its agent, and resolves once it is gone, `ended` for the reason given", async () => {
    await idleSession();
    const pid = host.pidOf(KEY);

    const ended = sessions.end(KEY, 'restarted');
    await settle();
    expect(signals).toEqual([`${pid} SIGTERM`]);
    host.exit(KEY);
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);

    await expect(ended).resolves.toEqual([]);
    expect(sessions.session(KEY)).toMatchObject({ state: 'ended', reason: 'restarted' });
    expect(host.kills).toEqual([]);
  });

  it('gives the background tasks the `idle` session listed', async () => {
    const launched = sessions.launch({
      key: KEY,
      directory: DIRECTORY,
      conversationId: CONVERSATION,
      prompt: 'Hi',
    });
    await settle();
    hook('/start-and-take');
    await launched;
    hook('/turn-ended-with-a-task');

    const ended = sessions.end(KEY, 'session-cap');
    await settle();
    host.exit(KEY);
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);

    await expect(ended).resolves.toEqual([{ id: 'a1', type: 'general-purpose' }]);
  });

  it("kills it on the host once the driver's bound passed: `ended` for the reason given", async () => {
    await idleSession();

    const ended = sessions.end(KEY, 'restarted');
    await vi.advanceTimersByTimeAsync(driver.ending.boundMs);

    await expect(ended).resolves.toEqual([]);
    expect(host.kills).toEqual([KEY]);
    expect(sessions.session(KEY)).toMatchObject({ state: 'ended', reason: 'restarted' });
  });

  it('keeps its reason whatever the agent tells as it goes', async () => {
    await idleSession();

    const ended = sessions.end(KEY, 'restarted');
    await settle();
    hook('/prompt-taken');
    hook('/agent-exit');
    host.exit(KEY);
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);
    await ended;

    expect(sessions.session(KEY)).toMatchObject({ state: 'ended', reason: 'restarted' });
  });

  it('refuses a send from the moment it is asked until the session is gone, the agent heard as it goes', async () => {
    await idleSession();

    const ended = sessions.end(KEY, 'session-cap');
    await expect(sending()).rejects.toMatchObject({ code: 'wrong-state', key: KEY, state: 'idle' });
    await settle();
    hook('/prompt-taken');
    expect(sessions.session(KEY)?.state).toBe('busy');
    await expect(sending()).rejects.toMatchObject({ code: 'wrong-state', key: KEY });

    host.exit(KEY);
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);
    await ended;
    expect(writes()).toEqual([]);
    expect(sessions.session(KEY)).toMatchObject({ state: 'ended', reason: 'session-cap' });
  });

  it('is refused once the core is closed: nothing signalled or killed', async () => {
    await idleSession();
    sessions.close();

    await expect(sessions.end(KEY, 'restarted')).rejects.toThrow(SessionsClosedError);
    await vi.advanceTimersByTimeAsync(driver.ending.boundMs);
    expect(signals).toEqual([]);
    expect(host.kills).toEqual([]);
  });

  it('kills nothing once the core is closed while it waits for the agent to exit', async () => {
    await idleSession();
    const ended = sessions.end(KEY, 'restarted');
    ended.catch(() => {});
    await settle();
    expect(signals).toHaveLength(1);

    sessions.close();

    await expect(ended).rejects.toThrow(SessionsClosedError);
    await vi.advanceTimersByTimeAsync(driver.ending.boundMs);
    expect(host.kills).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits, asked again while the session is being ended, for that end: its reason kept, no tasks given', async () => {
    await idleSession();
    const first = settledLater(sessions.end(KEY, 'app'));
    await settle();

    const again = settledLater(sessions.end(KEY, 'session-cap'));
    await settle();
    expect(again.outcome).toBeUndefined();

    await vi.advanceTimersByTimeAsync(driver.ending.boundMs);
    await expect(again.promise).resolves.toEqual([]);
    await first.promise;
    expect(signals).toHaveLength(1);
    expect(host.kills).toEqual([KEY]);
    expect(sessions.session(KEY)).toMatchObject({ state: 'ended', reason: 'app' });
  });

  it('gives up waiting for an end under way once the kill failed, the session live again', async () => {
    await idleSession();
    host.failNextKill(new SessionHostError('host-failed', 'tmux failed.'));
    const first = sessions.end(KEY, 'app');
    first.catch(() => {});
    await settle();

    const again = sessions.end(KEY, 'session-cap');
    await vi.advanceTimersByTimeAsync(driver.ending.boundMs);

    await expect(first).rejects.toThrow('tmux failed.');
    await expect(again).resolves.toEqual([]);
    expect(sessions.session(KEY)?.state).toBe('idle');
  });

  it('does nothing for a key with no live session', async () => {
    await expect(sessions.end('nothing-here', 'restarted')).resolves.toEqual([]);
    expect(signals).toEqual([]);
  });

  it('leaves the session live when the kill fails: the end fails with the host, the agent is heard again, and a later end kills it', async () => {
    await idleSession();
    host.failNextKill(new SessionHostError('host-failed', 'tmux failed.'));

    const failed = sessions.end(KEY, 'restarted');
    failed.catch(() => {});
    await vi.advanceTimersByTimeAsync(driver.ending.boundMs);
    await expect(failed).rejects.toThrow('tmux failed.');
    hook('/prompt-taken');
    expect(sessions.session(KEY)?.state).toBe('busy');

    const ended = sessions.end(KEY, 'restarted');
    await vi.advanceTimersByTimeAsync(driver.ending.boundMs);
    await ended;
    expect(host.kills).toEqual([KEY]);
    expect(sessions.session(KEY)).toMatchObject({ state: 'ended', reason: 'restarted' });
  });

  it('resolves only once the session ended, though the liveness watch began its going while the kill ran: a launch of the key then starts', async () => {
    await idleSession();
    const kill = host.holdNextKill();
    const resume = driver.holdNextResume();

    const ended = settledLater(sessions.end(KEY, 'restarted'));
    await vi.advanceTimersByTimeAsync(driver.ending.boundMs);
    host.exit(KEY);
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);
    kill.open();
    await settle();
    expect(ended.outcome).toBeUndefined();

    resume.open();
    await ended.promise;
    expect(sessions.session(KEY)).toMatchObject({ state: 'ended', reason: 'restarted' });
    const launched = sessions.launch({ key: KEY, directory: DIRECTORY, conversationId: 'next' });
    await settle();
    hook('/ready');
    await expect(launched).resolves.toMatchObject({ state: 'idle' });
  });

  it('ends the session once, for the reason given, when its agent was gone just before the bound passed', async () => {
    await idleSession();
    const ends: Session[] = [];
    sessions.follow((list) => {
      const session = list.find((each) => each.key === KEY);
      if (session?.state === 'ended' && ends.at(-1) !== session) ends.push(session);
    });
    const resume = driver.holdNextResume();

    const ended = sessions.end(KEY, 'restarted');
    await settle();
    host.exit(KEY);
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(driver.ending.boundMs);
    resume.open();
    await ended;
    await settle();

    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ reason: 'restarted' });
  });

  it('keeps the reason given when the end was asked of a session whose agent never reported, before its start-up deadline', async () => {
    const launched = sessions.launch({
      key: KEY,
      directory: DIRECTORY,
      conversationId: CONVERSATION,
    });
    launched.catch(() => {});
    await vi.advanceTimersByTimeAsync(START_DEADLINE_MS - driver.ending.boundMs / 2);

    // The deadline passes while the end waits for the agent to exit.
    const ended = sessions.end(KEY, 'restarted');
    await vi.advanceTimersByTimeAsync(driver.ending.boundMs);
    await ended;

    expect(sessions.session(KEY)).toMatchObject({ state: 'ended', reason: 'restarted' });
  });
});

describe('what the core keeps of the sessions a key had', () => {
  it('keeps nothing of an ended session once a later launch of its key is live, however many were ended', async () => {
    setFlagsFromString('--expose-gc');
    const collect = runInNewContext('gc') as () => void;
    let first: WeakRef<Session> | undefined;
    for (let each = 0; each < 20; each += 1) {
      await idleSession();
      const ended = sessions.end(KEY, 'restarted');
      await settle();
      host.exit(KEY);
      await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);
      await ended;
      first ??= new WeakRef(sessions.session(KEY) as Session);
    }
    await idleSession();
    // The stub keeps every following it was asked for, the core's callbacks with them.
    driver.follows.splice(0);

    collect();

    expect(first?.deref()).toBeUndefined();
    expect(sessions.list()).toMatchObject([{ key: KEY, state: 'idle' }]);
  });
});

describe('what the core tells of its sessions for the units of work', () => {
  it('tells each move of an agent to another conversation, and the conversation it works in now', async () => {
    await idleSession();
    const moves: string[] = [];
    sessions.onConversation((key, conversationId) => moves.push(`${key} ${conversationId}`));
    expect(sessions.conversationOf(KEY)).toBe(CONVERSATION);

    hook(`${CONVERSATION_PATH}${CONVERSATION}`);
    hook(`${CONVERSATION_PATH}new-one`);

    expect(moves).toEqual([`${KEY} new-one`]);
    expect(sessions.conversationOf(KEY)).toBe('new-one');
  });

  it('lists the keys whose session lives, one being launched among them, an ended one not', async () => {
    await idleSession('one');
    await idleSession('two');
    const third = sessions.launch({ key: 'three', directory: DIRECTORY, conversationId: 'c-3' });
    third.catch(() => {});
    host.exit('two');
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);

    expect(sessions.liveKeys()).toEqual(['one', 'three']);
  });

  it('counts the terminals attached to a session on the host', async () => {
    await idleSession();
    host.attachTerminals(KEY, 2);

    await expect(sessions.terminalsAttached(KEY)).resolves.toBe(2);
  });
});
