import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CockpitError,
  isCockpitError,
  type MountedTerminal,
  mountTerminal,
  type TerminalStatus,
} from '../../src/terminal/index.ts';
import { loadAfresh, openPage, RefusedStorage } from '../support/browser-page.ts';
import { FakeWebSocket } from '../support/fake-web-socket.ts';
import { FakeFitAddon, FakeResizeObserver, FakeTerminal } from '../support/fake-xterm.ts';

vi.mock('@xterm/xterm', async () => ({
  Terminal: (await import('../support/fake-xterm.ts')).FakeTerminal,
}));
vi.mock('@xterm/addon-fit', async () => ({
  FitAddon: (await import('../support/fake-xterm.ts')).FakeFitAddon,
}));

const token = 'kq3J_x-9Zt0aPbXw2eYc8vRm4nLs6uHd1oQiGfAjK7E';
const element = { id: 'the app element' } as unknown as HTMLElement;
const claudeCodeKeys = JSON.stringify({
  type: 'keys',
  rules: [{ key: 'Enter', modifiers: ['shift'], send: '\x1b\r' }],
});

let terminal: MountedTerminal | undefined;
let statuses: TerminalStatus[];
let clipboard: string[];
/** The requests the page sent, as `fetch` received them. */
let probes: { url: string; method: string; headers: Record<string, string> }[];
/** What the server answers the next requests. */
let probeAnswer: () => Promise<Response>;

/** The cockpit's answer when a terminal's checks pass: its path is a WebSocket's. */
const upgradeRequired = (): Promise<Response> =>
  Promise.resolve(new Response(null, { status: 426, headers: { upgrade: 'websocket' } }));

/** The cockpit's refusal of a request, as the wire carries it. */
function refusal(status: number, error: Record<string, unknown>): () => Promise<Response> {
  return () =>
    Promise.resolve(Response.json({ error: { name: 'CockpitError', ...error } }, { status }));
}

const noToken = refusal(401, { code: 'no-token', message: 'No valid token.' });
const terminalOff = refusal(403, {
  code: 'refused',
  message: 'The terminal is off.',
  cause: 'terminal-off',
});

beforeEach(() => {
  vi.useFakeTimers();
  openPage(`http://127.0.0.1:8765/#cockpit=${token}`);
  FakeWebSocket.install();
  FakeTerminal.created.length = 0;
  FakeResizeObserver.observers.length = 0;
  FakeFitAddon.proposed = { cols: 100, rows: 30 };
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  clipboard = [];
  vi.stubGlobal('navigator', {
    clipboard: {
      writeText: async (text: string) => {
        clipboard.push(text);
      },
    },
  });
  statuses = [];
  probes = [];
  probeAnswer = upgradeRequired;
  vi.stubGlobal('fetch', (url: URL, init: RequestInit) => {
    probes.push({
      url: String(url),
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
    });
    return probeAnswer();
  });
});

afterEach(() => {
  terminal?.dispose();
  terminal = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mount(options: Record<string, unknown> = {}): MountedTerminal {
  terminal = mountTerminal(element, 'explain-a', { baseUrl: '/cockpit', ...options });
  terminal.on('status', (status) => statuses.push(status));
  return terminal;
}

/** Mounts, and the server accepts and sends the driver's keys. */
function mountAttached(): { socket: FakeWebSocket; xterm: FakeTerminal } {
  mount();
  const socket = FakeWebSocket.last();
  socket.accept();
  socket.deliver(claudeCodeKeys);
  return { socket, xterm: FakeTerminal.last() };
}

const text = (data: string | Uint8Array | undefined): string | undefined =>
  data instanceof Uint8Array ? new TextDecoder().decode(data) : data;

describe('mounting', () => {
  it('opens an xterm.js terminal in the element, with the look the app gave', () => {
    mount({ theme: { background: '#11151c' }, fontFamily: 'ui-monospace', fontSize: 13 });

    const xterm = FakeTerminal.last();
    expect(xterm.element).toBe(element);
    expect(xterm.options).toMatchObject({
      theme: { background: '#11151c' },
      fontFamily: 'ui-monospace',
      fontSize: 13,
    });
  });

  it('leaves the look xterm.js gives when the app gives none', () => {
    mount();

    expect(Object.keys(FakeTerminal.last().options)).not.toContain('theme');
    expect(Object.keys(FakeTerminal.last().options)).not.toContain('fontFamily');
    expect(Object.keys(FakeTerminal.last().options)).not.toContain('fontSize');
  });

  it("opens the session's terminal path with the token as a subprotocol, never in the URL", () => {
    mount();

    const socket = FakeWebSocket.last();
    expect(socket.url).toBe('ws://127.0.0.1:8765/cockpit/terminal/explain-a');
    expect(socket.protocols).toEqual(['agent-cockpit', `agent-cockpit.token.${token}`]);
    expect(socket.binaryType).toBe('arraybuffer');
  });

  it("offers the token the page's client took from the link, when the browser refuses storage", async () => {
    const page = openPage(`http://127.0.0.1:8765/#cockpit=${token}`, {
      storage: new RefusedStorage(),
    });
    const { createCockpitClient, mountTerminal } = await loadAfresh(async () => ({
      ...(await import('../../src/client/index.ts')),
      ...(await import('../../src/terminal/index.ts')),
    }));
    createCockpitClient({ baseUrl: '/cockpit' });
    // The link is gone and the storage refused: only the client's token is left.
    expect(page.address()).toBe('http://127.0.0.1:8765/');

    terminal = mountTerminal(element, 'explain-a', { baseUrl: '/cockpit' });

    expect(FakeWebSocket.last().protocols).toEqual([
      'agent-cockpit',
      `agent-cockpit.token.${token}`,
    ]);
  });

  it('sends the size fitted to the element first, once the socket opens', () => {
    mount();
    FakeWebSocket.last().accept();

    expect(FakeWebSocket.last().sent).toEqual([
      JSON.stringify({ type: 'resize', columns: 100, rows: 30 }),
    ]);
  });

  it('refuses a key that is no session key, before anything is made', () => {
    let thrown: unknown;
    try {
      mountTerminal(element, 'Not A Key', { baseUrl: '/cockpit' });
    } catch (error) {
      thrown = error;
    }

    expect(isCockpitError(thrown, 'invalid-options')).toBe(true);
    expect((thrown as CockpitError<'invalid-options'>).issues[0]?.path).toEqual(['key']);
    expect(FakeTerminal.created).toEqual([]);
    expect(FakeWebSocket.created).toEqual([]);
  });

  it('refuses a baseUrl that is not a path or an HTTP URL', () => {
    expect(() => mountTerminal(element, 'explain-a', { baseUrl: 'ftp://host/' })).toThrow(
      expect.objectContaining({ code: 'invalid-options' }),
    );
  });

  it('gives the terminal the keyboard on focus', () => {
    mount().focus();

    expect(FakeTerminal.last().focused).toBe(true);
  });
});

describe('the session and the person', () => {
  it("writes the session's output as it comes", () => {
    const { socket, xterm } = mountAttached();

    socket.deliver(new TextEncoder().encode('hello ').buffer);
    socket.deliver(new TextEncoder().encode('épée').buffer);

    expect(xterm.text()).toBe('hello épée');
  });

  it('sends what the person types as UTF-8 bytes', () => {
    const { socket, xterm } = mountAttached();

    xterm.type('é\r');

    expect(socket.sent.at(-1)).toEqual(new TextEncoder().encode('é\r'));
  });

  it("sends xterm.js's raw bytes one byte per character", () => {
    const { socket, xterm } = mountAttached();

    xterm.typeBinary('\x1b[M\xe0!!');

    expect(socket.sent.at(-1)).toEqual(Uint8Array.from([0x1b, 0x5b, 0x4d, 0xe0, 0x21, 0x21]));
  });

  it('sends nothing typed before the socket opens', () => {
    mount();

    FakeTerminal.last().type('early');

    expect(FakeWebSocket.last().sent).toEqual([]);
  });

  it("follows the element's size: a fit, then the new size sent", () => {
    const { socket } = mountAttached();

    FakeFitAddon.proposed = { cols: 120, rows: 40 };
    FakeResizeObserver.elementResized(element);

    expect(socket.sent.at(-1)).toBe(JSON.stringify({ type: 'resize', columns: 120, rows: 40 }));
  });

  it('skips a text message that is not the keys', () => {
    const { socket, xterm } = mountAttached();

    socket.deliver('not json');
    socket.deliver(JSON.stringify({ type: 'other' }));
    socket.deliver('null');

    expect(xterm.press('Enter', { shift: true }).keydown).toBe(false);
  });
});

describe("the driver's keys", () => {
  it('sends what a rule says in place of its key, and keeps xterm.js from sending it', () => {
    const { socket, xterm } = mountAttached();

    const outcome = xterm.press('Enter', { shift: true });

    expect(outcome).toEqual({ keydown: false, keypress: false, prevented: true });
    expect(socket.sent.filter((data) => data instanceof Uint8Array).map(text)).toEqual(['\x1b\r']);
  });

  it('leaves a key with other modifiers to xterm.js', () => {
    const { socket, xterm } = mountAttached();

    expect(xterm.press('Enter')).toEqual({ keydown: true, keypress: true, prevented: false });
    expect(xterm.press('Enter', { shift: true, ctrl: true }).keydown).toBe(true);
    expect(socket.sent.filter((data) => data instanceof Uint8Array)).toEqual([]);
  });

  it('applies no rule before the server sent them', () => {
    mount();
    FakeWebSocket.last().accept();

    expect(FakeTerminal.last().press('Enter', { shift: true }).keydown).toBe(true);
  });
});

describe('copy', () => {
  it('copies to the clipboard what the session copies (OSC 52), from tmux or from a program', async () => {
    const { xterm } = mountAttached();

    xterm.sequence(52, ';Y29weSB0aGVzZSB3b3Jkcw==');
    xterm.sequence(52, 'c;w6lww6llIOS9oOWlvQ==');
    await vi.advanceTimersByTimeAsync(0);

    expect(clipboard).toEqual(['copy these words', 'épée 你好']);
  });

  it('never answers a query of the clipboard, nor takes another target', async () => {
    const { socket, xterm } = mountAttached();

    expect(xterm.sequence(52, 'c;?')).toBe(true);
    xterm.sequence(52, 'p;cHJpbWFyeQ==');
    await vi.advanceTimersByTimeAsync(0);

    expect(clipboard).toEqual([]);
    expect(socket.sent.filter((data) => data instanceof Uint8Array)).toEqual([]);
  });

  it("copies the terminal's own selection on Ctrl+C, clears it, and sends nothing", async () => {
    const { socket, xterm } = mountAttached();
    xterm.selection = 'selected text';

    const outcome = xterm.press('c', { ctrl: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(outcome.keydown).toBe(false);
    expect(outcome.prevented).toBe(true);
    expect(clipboard).toEqual(['selected text']);
    expect(xterm.hasSelection()).toBe(false);
    expect(socket.sent.filter((data) => data instanceof Uint8Array)).toEqual([]);
  });

  it('leaves Ctrl+C to the session when nothing is selected', () => {
    const { xterm } = mountAttached();

    expect(xterm.press('c', { ctrl: true }).keydown).toBe(true);
    expect(clipboard).toEqual([]);
  });

  it('leaves Ctrl+Shift+C and Ctrl+Alt+C alone, selection or not', () => {
    const { xterm } = mountAttached();
    xterm.selection = 'selected text';

    expect(xterm.press('C', { ctrl: true, shift: true }).keydown).toBe(true);
    expect(xterm.press('c', { ctrl: true, alt: true }).keydown).toBe(true);
    expect(clipboard).toEqual([]);
  });

  it('drops a write the browser refuses', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) },
    });
    const { xterm } = mountAttached();

    expect(xterm.sequence(52, 'c;dGV4dA==')).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
  });

  it('lets the terminal force its own selection with Option on macOS', () => {
    mount();

    expect(FakeTerminal.last().options.macOptionClickForcesSelection).toBe(true);
  });
});

describe('the status', () => {
  it('gives the current status at once, then each change', () => {
    mount();
    FakeWebSocket.last().accept();

    expect(statuses).toEqual(['connecting', 'open']);
  });

  it('gives a handler subscribed later the status it is in', () => {
    const mounted = mount();
    FakeWebSocket.last().accept();
    const later: TerminalStatus[] = [];

    const stop = mounted.on('status', (status) => later.push(status));
    stop();
    FakeWebSocket.last().closeWith(1006);

    expect(later).toEqual(['open']);
  });

  it('never reaches an error handler: errors are an event of their own', () => {
    const mounted = mount();
    const errors: unknown[] = [];

    const stop = mounted.on('error', (error) => errors.push(error));
    FakeWebSocket.last().accept();
    stop();

    expect(statuses).toEqual(['connecting', 'open']);
    expect(errors).toEqual([]);
  });

  it('is ended when the server closes with 4000, and never reconnects', async () => {
    const { socket } = mountAttached();

    socket.closeWith(4000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(statuses).toEqual(['connecting', 'open', 'ended']);
    expect(FakeWebSocket.created).toHaveLength(1);
  });

  it('is ended when the session is gone before the socket opened', () => {
    mount();

    FakeWebSocket.last().closeWith(4000);

    expect(statuses).toEqual(['connecting', 'ended']);
  });
});

describe('reconnecting', () => {
  it('is closed after a drop, then connects again after 0.5 s', async () => {
    const { socket } = mountAttached();

    socket.drop();
    await vi.advanceTimersByTimeAsync(499);
    expect(FakeWebSocket.created).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(FakeWebSocket.created).toHaveLength(2);
    expect(statuses).toEqual(['connecting', 'open', 'closed', 'connecting']);
  });

  it('sends the size first again on the new socket', async () => {
    const { socket } = mountAttached();
    socket.drop();
    await vi.advanceTimersByTimeAsync(500);

    FakeWebSocket.last().accept();

    expect(FakeWebSocket.last().sent).toEqual([
      JSON.stringify({ type: 'resize', columns: 100, rows: 30 }),
    ]);
  });

  it('waits longer after each attempt that reaches no session, up to 10 s', async () => {
    mount();
    const waits: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const before = FakeWebSocket.created.length;
      FakeWebSocket.last().drop();
      let waited = 0;
      while (FakeWebSocket.created.length === before) {
        await vi.advanceTimersByTimeAsync(100);
        waited += 100;
      }
      waits.push(waited);
    }

    expect(waits).toEqual([500, 1000, 2000, 4000, 8000, 10_000, 10_000]);
  });

  it('waits 0.5 s again once a connection reached the session', async () => {
    mount();
    FakeWebSocket.last().drop();
    await vi.advanceTimersByTimeAsync(500);
    FakeWebSocket.last().drop();
    await vi.advanceTimersByTimeAsync(1000);

    FakeWebSocket.last().accept();
    FakeWebSocket.last().deliver(claudeCodeKeys);
    FakeWebSocket.last().drop();
    await vi.advanceTimersByTimeAsync(500);

    expect(FakeWebSocket.created).toHaveLength(4);
  });
});

describe('errors', () => {
  let errors: CockpitError[];

  /** Mounts with an error handler. */
  function mountReporting(): MountedTerminal {
    const mounted = mount();
    errors = [];
    mounted.on('error', (error) => errors.push(error));
    return mounted;
  }

  /** The server refuses the current handshake; the terminal asks why. */
  async function refuseHandshake(): Promise<void> {
    FakeWebSocket.last().drop();
    await vi.advanceTimersByTimeAsync(0);
  }

  it("explains a refused handshake by a GET on the terminal's own path, with the token", async () => {
    probeAnswer = noToken;
    mountReporting();

    await refuseHandshake();

    expect(probes).toEqual([
      {
        url: 'http://127.0.0.1:8765/cockpit/terminal/explain-a',
        method: 'GET',
        headers: { 'cockpit-token': token },
      },
    ]);
    expect(errors.map((error) => error.toJSON())).toEqual([
      { name: 'CockpitError', code: 'no-token', message: 'No valid token.' },
    ]);
  });

  it('gives a refusal with its cause, once per failed attempt, and tries again', async () => {
    probeAnswer = refusal(403, { code: 'refused', message: 'Refused.', cause: 'origin' });
    mountReporting();

    await refuseHandshake();
    await vi.advanceTimersByTimeAsync(500);
    await refuseHandshake();

    expect(errors).toHaveLength(2);
    expect(errors.every((error) => isCockpitError(error, 'refused'))).toBe(true);
    expect((errors[0] as CockpitError<'refused'>).cause).toBe('origin');
    expect(FakeWebSocket.created).toHaveLength(2);
    expect(statuses).toEqual(['connecting', 'closed', 'connecting', 'closed']);
  });

  it('gives no-token, and goes on trying: a link opened in another tab may give one', async () => {
    probeAnswer = noToken;
    mountReporting();

    await refuseHandshake();
    await vi.advanceTimersByTimeAsync(500);
    FakeWebSocket.last().accept();

    expect(errors.map((error) => error.code)).toEqual(['no-token']);
    expect(statuses.at(-1)).toBe('open');
  });

  it('gives unreachable when the explaining request reaches nothing either', async () => {
    probeAnswer = () => Promise.reject(new TypeError('fetch failed'));
    mountReporting();

    await refuseHandshake();

    expect(errors.map((error) => error.code)).toEqual(['unreachable']);
  });

  it('gives unreachable when the checks pass yet no WebSocket opened: a proxy may not pass it', async () => {
    mountReporting();

    await refuseHandshake();

    expect(errors.map((error) => error.code)).toEqual(['unreachable']);
    expect(errors[0]?.message).toMatch(/WebSocket/);
  });

  it('gives unreachable when what answers is not the cockpit', async () => {
    probeAnswer = () => Promise.resolve(new Response('<html>Bad gateway</html>', { status: 502 }));
    mountReporting();

    await refuseHandshake();

    expect(errors.map((error) => error.code)).toEqual(['unreachable']);
  });

  it('gives nothing, and asks nothing, for a drop: it only reconnects', async () => {
    mountReporting();
    FakeWebSocket.last().accept();

    FakeWebSocket.last().drop();
    await vi.advanceTimersByTimeAsync(500);

    expect(probes).toEqual([]);
    expect(errors).toEqual([]);
    expect(FakeWebSocket.created).toHaveLength(2);
  });

  it('asks nothing when the session is gone before the socket opened', async () => {
    mountReporting();

    FakeWebSocket.last().closeWith(4000);
    await vi.advanceTimersByTimeAsync(0);

    expect(probes).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('stops trying once the terminal is off: closed, the error given once', async () => {
    probeAnswer = terminalOff;
    mountReporting();

    await refuseHandshake();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(errors.map((error) => (error as CockpitError<'refused'>).cause)).toEqual([
      'terminal-off',
    ]);
    expect(FakeWebSocket.created).toHaveLength(1);
    expect(statuses).toEqual(['connecting', 'closed']);
  });

  it('gives nothing and tries no more when disposed while it explains a refusal', async () => {
    let answer: (response: Response) => void = () => {};
    probeAnswer = () => new Promise<Response>((resolve) => (answer = resolve));
    const mounted = mountReporting();
    await refuseHandshake();

    mounted.dispose();
    answer(await noToken());
    await vi.advanceTimersByTimeAsync(60_000);

    expect(errors).toEqual([]);
    expect(FakeWebSocket.created).toHaveLength(1);
  });

  it('tells every error handler, and none that was removed', async () => {
    probeAnswer = noToken;
    const mounted = mountReporting();
    const others: CockpitError[] = [];
    const stopOthers = mounted.on('error', (error) => others.push(error));

    await refuseHandshake();
    stopOthers();
    await vi.advanceTimersByTimeAsync(500);
    await refuseHandshake();

    expect(errors).toHaveLength(2);
    expect(others).toHaveLength(1);
  });

  it('keeps trying without an error handler', async () => {
    probeAnswer = noToken;
    mount();

    await refuseHandshake();
    await vi.advanceTimersByTimeAsync(500);

    expect(FakeWebSocket.created).toHaveLength(2);
  });
});

describe('disposing', () => {
  it('closes the socket, stops reconnecting and removes the terminal', async () => {
    const mounted = mount();
    const socket = FakeWebSocket.last();
    socket.accept();

    mounted.dispose();
    socket.closeWith(1006);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(socket.closedByPage).toBe(true);
    expect(FakeWebSocket.created).toHaveLength(1);
    expect(FakeTerminal.last().disposed).toBe(true);
    expect(statuses).toEqual(['connecting', 'open']);
  });

  it('stops a reconnection already waiting', async () => {
    const mounted = mount();
    FakeWebSocket.last().drop();

    mounted.dispose();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(FakeWebSocket.created).toHaveLength(1);
  });

  it("stops following the element's size", () => {
    const { socket } = mountAttached();
    terminal?.dispose();

    FakeFitAddon.proposed = { cols: 120, rows: 40 };
    FakeResizeObserver.elementResized(element);

    expect(socket.sent).toHaveLength(1);
  });

  it('does it once', () => {
    const mounted = mount();

    mounted.dispose();
    mounted.dispose();

    expect(FakeTerminal.last().disposed).toBe(true);
  });
});
