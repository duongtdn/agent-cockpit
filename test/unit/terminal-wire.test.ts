import { once } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  type MountedTerminal,
  mountTerminal,
  type TerminalStatus,
} from '../../src/terminal/index.ts';
import { openPage } from '../support/browser-page.ts';
import { eventually } from '../support/eventually.ts';
import { FakeResizeObserver, FakeTerminal } from '../support/fake-xterm.ts';
import { startWireServer, type WireServer } from '../support/wire-server.ts';

vi.mock('@xterm/xterm', async () => ({
  Terminal: (await import('../support/fake-xterm.ts')).FakeTerminal,
}));
vi.mock('@xterm/addon-fit', async () => ({
  FitAddon: (await import('../support/fake-xterm.ts')).FakeFitAddon,
}));

const token = 'kq3J_x-9Zt0aPbXw2eYc8vRm4nLs6uHd1oQiGfAjK7E';
const element = {} as HTMLElement;

let server: WireServer;
let terminal: MountedTerminal;
let statuses: TerminalStatus[];

beforeEach(async () => {
  server = await startWireServer();
  openPage(`http://127.0.0.1:8765/#cockpit=${token}`);
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  statuses = [];
  terminal = mountTerminal(element, 'explain-a', { baseUrl: server.baseUrl });
  terminal.on('status', (status) => statuses.push(status));
});

afterEach(async () => {
  terminal.dispose();
  vi.unstubAllGlobals();
  await server.close();
});

it('attaches on the real wire: the path, the token, the size first, keys and output both ways', async () => {
  const accepted = await server.nextSocket();
  const xterm = FakeTerminal.last();
  await eventually(() => expect(statuses).toContain('open'));

  accepted.socket.send(
    JSON.stringify({
      type: 'keys',
      rules: [{ key: 'Enter', modifiers: ['shift'], send: '\x1b\r' }],
    }),
  );
  accepted.socket.send(Buffer.from('The answer: épée', 'utf8'));
  await eventually(() => expect(xterm.text()).toBe('The answer: épée'));
  xterm.type('hi');
  xterm.press('Enter', { shift: true });

  expect(accepted.path).toBe('/terminal/explain-a');
  expect(accepted.token).toBe(token);
  await eventually(() =>
    expect(accepted.messages).toEqual([
      JSON.stringify({ type: 'resize', columns: 100, rows: 30 }),
      Buffer.from('hi'),
      Buffer.from('\x1b\r'),
    ]),
  );
});

it('is ended when the server closes with the ended code', async () => {
  const accepted = await server.nextSocket();
  await eventually(() => expect(statuses).toContain('open'));

  accepted.socket.close(4000);
  await once(accepted.socket, 'close');

  await eventually(() => expect(statuses).toEqual(['connecting', 'open', 'ended']));
});

it('reconnects after the server drops the connection', async () => {
  const first = await server.nextSocket();
  await eventually(() => expect(statuses).toContain('open'));

  first.socket.terminate();
  const second = await server.nextSocket();

  expect(second.token).toBe(token);
  await eventually(() =>
    expect(statuses).toEqual(['connecting', 'open', 'closed', 'connecting', 'open']),
  );
});
