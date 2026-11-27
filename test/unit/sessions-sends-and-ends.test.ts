import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TypingStoppedError, type TypingTerminal } from '../../src/server/driver.ts';
import {
  createSessions,
  INPUT_BOX_BOUND_MS,
  LIVENESS_INTERVAL_MS,
  PROMPT_BOUND_MS,
  SCREEN_INTERVAL_MS,
  type Sessions,
  SessionsClosedError,
} from '../../src/server/sessions/sessions.ts';
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
  host.show(key, stubScreen('ready'));
}

/** Sends a prompt, the outcome kept for the test to look at. */
function sending(prompt = 'Explain the tests.'): Promise<Session> {
  const sent = sessions.send(KEY, prompt);
  sent.catch(() => {});
  return sent;
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
      host.show(KEY, stubScreen('ready'));
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
    host.show(KEY, stubScreen('ready'));

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

  it('fails the launch `prompt-not-taken` when the agent did not take it: the session is `idle`', async () => {
    const launched = sessions.launch({
      key: KEY,
      directory: DIRECTORY,
      conversationId: CONVERSATION,
      prompt: 'A long prompt.',
    });
    launched.catch(() => {});
    await settle();
    host.show(KEY, stubScreen('ready'));
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

    host.show(KEY, stubScreen('ready'));
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

  it('keeps the session `waiting` while a dialog shows in place of the box, the launch pending, then types once the box shows, `starting` again', async () => {
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
    hook('/ready');
    host.show(KEY, stubScreen('dialog'));
    await vi.advanceTimersByTimeAsync(SCREEN_INTERVAL_MS);

    await vi.advanceTimersByTimeAsync(3 * INPUT_BOX_BOUND_MS);
    expect(writes()).toEqual([]);
    expect(sessions.session(KEY)).toMatchObject({
      state: 'waiting',
      pending: [{ kind: 'terminal' }],
    });
    expect(settled).toBeUndefined();

    host.show(KEY, stubScreen('ready'));
    await vi.advanceTimersByTimeAsync(SCREEN_INTERVAL_MS);
    expect(writes()).toContain('text:A long prompt.');
    expect(sessions.session(KEY)?.state).toBe('starting');
    hook(`${PROMPT_PATH}A long prompt.`);

    await expect(launched).resolves.toMatchObject({ state: 'busy' });
  });

  it('is typed once the person answered a start-up dialog, the launch pending until the agent took it', async () => {
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
    host.show(KEY, stubScreen('trust-folder'));
    await vi.advanceTimersByTimeAsync(300);
    expect(sessions.session(KEY)?.state).toBe('waiting');
    expect(settled).toBeUndefined();

    host.show(KEY, stubScreen('ready'));
    hook('/ready');
    await settle();
    hook(`${PROMPT_PATH}A long prompt.`);

    await expect(launched).resolves.toMatchObject({ state: 'busy' });
    expect(writes()).toContain('text:A long prompt.');
  });

  it('fails the launch when the prompt typed after a start-up dialog was not taken: `prompt-not-taken`, the session `idle`', async () => {
    const launched = sessions.launch({
      key: KEY,
      directory: DIRECTORY,
      conversationId: CONVERSATION,
      prompt: 'A long prompt.',
    });
    launched.catch(() => {});
    await settle();
    host.show(KEY, stubScreen('trust-folder'));
    await vi.advanceTimersByTimeAsync(300);

    host.show(KEY, stubScreen('ready'));
    hook('/ready');
    await vi.advanceTimersByTimeAsync(TYPING_PATIENCE_MS);

    await expect(launched).rejects.toMatchObject({ code: 'prompt-not-taken', state: 'idle' });
    expect(sessions.session(KEY)?.state).toBe('idle');
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
    host.show(KEY, stubScreen('ready'));
    await vi.advanceTimersByTimeAsync(SCREEN_INTERVAL_MS);
    hook(`${PROMPT_PATH}A long prompt.`);

    await expect(launched).resolves.toMatchObject({ state: 'busy' });
    expect(pageTerminal).toEqual(['held', 'released']);
  });

  it("lets the page's terminals' keys through while a dialog in place of the box waits for the person, held again once the box shows", async () => {
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
    expect(pageTerminal).toEqual(['held', 'released']);

    host.show(KEY, stubScreen('ready'));
    await vi.advanceTimersByTimeAsync(SCREEN_INTERVAL_MS);
    expect(pageTerminal).toEqual(['held', 'released', 'held']);
    hook(`${PROMPT_PATH}A long prompt.`);

    await expect(launched).resolves.toMatchObject({ state: 'busy' });
    expect(pageTerminal).toEqual(['held', 'released', 'held', 'released']);
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

    host.show(KEY, stubScreen('ready'));
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

  it('refuses a send from the moment it is asked, and hears nothing more of the agent, until it is gone', async () => {
    await idleSession();
    const moves: string[] = [];
    sessions.onConversation((_key, conversationId) => void moves.push(conversationId));

    const ended = sessions.end(KEY, 'session-cap');
    await expect(sending()).rejects.toMatchObject({ code: 'wrong-state', key: KEY });
    await settle();
    hook(`${CONVERSATION_PATH}c-cleared`);
    hook('/prompt-taken');

    expect(moves).toEqual([]);
    expect(sessions.conversationOf(KEY)).toBe(CONVERSATION);
    expect(sessions.session(KEY)?.state).toBe('idle');
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

  it('does nothing for a key with no live session', async () => {
    await expect(sessions.end('nothing-here', 'restarted')).resolves.toEqual([]);
    expect(signals).toEqual([]);
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
