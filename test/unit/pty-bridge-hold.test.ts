import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { type BridgedSessions, bridgeTerminal } from '../../src/server/http/pty-bridge.ts';
import { createTerminalHolds, type TerminalHolds } from '../../src/server/terminal-hold.ts';
import { FakeAttachment } from '../support/fake-attachment.ts';
import { FakeServerSocket } from '../support/fake-server-socket.ts';

const keyRules = [{ key: 'Enter', modifiers: ['shift'] as const, send: '\x1b\r' }];

let holds: TerminalHolds;
let attachment: FakeAttachment;
let attached: Promise<FakeAttachment | undefined>;
let bridges: Promise<void>[];

beforeEach(() => {
  vi.useFakeTimers();
  holds = createTerminalHolds();
  attachment = new FakeAttachment();
  attached = Promise.resolve(attachment);
  bridges = [];
});

afterEach(async () => {
  vi.useRealTimers();
});

const sessions = (): BridgedSessions => ({
  attach: () => attached,
  isLive: async () => true,
  joinHold: (key, terminal) => holds.join(key, terminal),
});

/** Opens a terminal of `explain-a` and waits until the session is attached. */
async function openTerminal(): Promise<FakeServerSocket> {
  const socket = new FakeServerSocket();
  bridges.push(bridgeTerminal(socket as unknown as WebSocket, 'explain-a', sessions(), keyRules));
  socket.resize(80, 24);
  await vi.advanceTimersByTimeAsync(0);
  return socket;
}

it('holds the keys typed during a send, then writes them in order, each as typed, at most 50 ms apart', async () => {
  const socket = await openTerminal();
  const release = holds.hold('explain-a');
  expect(socket.holdMessages()).toEqual(['held']);

  socket.type('f');
  await vi.advanceTimersByTimeAsync(20);
  socket.type('i');
  await vi.advanceTimersByTimeAsync(5_000);
  socket.type('x\r');
  expect(attachment.written).toEqual([]);

  release();
  expect(attachment.written).toEqual(['f']);
  await vi.advanceTimersByTimeAsync(19);
  expect(attachment.written).toEqual(['f']);
  await vi.advanceTimersByTimeAsync(1);
  expect(attachment.written).toEqual(['f', 'i']);
  await vi.advanceTimersByTimeAsync(49);
  expect(attachment.written).toEqual(['f', 'i']);
  expect(socket.holdMessages()).toEqual(['held']);
  await vi.advanceTimersByTimeAsync(1);
  expect(attachment.written).toEqual(['f', 'i', 'x\r']);
  expect(socket.holdMessages()).toEqual(['held', 'released']);

  socket.type('y');
  expect(attachment.written).toEqual(['f', 'i', 'x\r', 'y']);
});

it('drops the keys kept when they are discarded: none reaches the session, and the browser is told with the release', async () => {
  const socket = await openTerminal();
  const release = holds.hold('explain-a');
  socket.type('y');
  await vi.advanceTimersByTimeAsync(10);
  socket.type('\r');

  holds.discard('explain-a');
  release();
  await vi.advanceTimersByTimeAsync(100);

  expect(attachment.written).toEqual([]);
  expect(
    socket.messages.filter((message) => (message as { type: string }).type !== 'keys'),
  ).toEqual([{ type: 'held' }, { type: 'released', discarded: true }]);
  socket.type('1');
  expect(attachment.written).toEqual(['1']);
});

it('stops writing the keys kept once discarded, as they are written after a release', async () => {
  const socket = await openTerminal();
  const release = holds.hold('explain-a');
  socket.type('a');
  await vi.advanceTimersByTimeAsync(10);
  socket.type('b');
  release();
  expect(attachment.written).toEqual(['a']);

  holds.discard('explain-a');
  await vi.advanceTimersByTimeAsync(100);

  expect(attachment.written).toEqual(['a']);
  expect(socket.messages.at(-1)).toEqual({ type: 'released', discarded: true });
});

it('tells the browser the keys pass again at once when none were typed', async () => {
  const socket = await openTerminal();

  holds.hold('explain-a')();

  expect(socket.holdMessages()).toEqual(['held', 'released']);
  expect(attachment.written).toEqual([]);
});

it('queues the keys typed while the held ones are written behind them', async () => {
  const socket = await openTerminal();
  const release = holds.hold('explain-a');
  socket.type('a');
  await vi.advanceTimersByTimeAsync(10);
  socket.type('b');

  release();
  socket.type('c');
  await vi.advanceTimersByTimeAsync(100);

  expect(attachment.written).toEqual(['a', 'b', 'c']);
  expect(socket.holdMessages()).toEqual(['held', 'released']);
});

it('stops writing the held keys when the next send holds them again, and goes on after it', async () => {
  const socket = await openTerminal();
  const first = holds.hold('explain-a');
  socket.type('a');
  await vi.advanceTimersByTimeAsync(10);
  socket.type('b');
  first();
  expect(attachment.written).toEqual(['a']);

  const second = holds.hold('explain-a');
  await vi.advanceTimersByTimeAsync(1_000);
  expect(attachment.written).toEqual(['a']);
  socket.type('c');

  second();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(attachment.written).toEqual(['a', 'b', 'c']);
  expect(socket.holdMessages()).toEqual(['held', 'released']);
});

it('holds a terminal that attaches during a send, the keys it sent while attaching among them', async () => {
  const release = holds.hold('explain-a');
  let attach: (value: FakeAttachment) => void = () => {};
  attached = new Promise((resolve) => {
    attach = resolve;
  });
  const socket = new FakeServerSocket();
  bridges.push(bridgeTerminal(socket as unknown as WebSocket, 'explain-a', sessions(), keyRules));
  socket.resize(80, 24);
  socket.type('early');

  attach(attachment);
  await vi.advanceTimersByTimeAsync(0);
  socket.type(' late');
  expect(socket.messages).toEqual([{ type: 'keys', rules: keyRules }, { type: 'held' }]);
  expect(attachment.written).toEqual([]);

  release();
  await vi.advanceTimersByTimeAsync(100);
  expect(attachment.written).toEqual(['early', ' late']);
});

it('applies a resize during a send', async () => {
  const socket = await openTerminal();
  const release = holds.hold('explain-a');

  socket.resize(120, 40);

  expect(attachment.sizes).toEqual([{ columns: 120, rows: 40 }]);
  release();
});

it('drops the held keys of a terminal that closes during a send, and detaches it', async () => {
  const socket = await openTerminal();
  const release = holds.hold('explain-a');
  socket.type('lost');

  socket.close(1001);
  await Promise.all(bridges);
  release();
  await vi.advanceTimersByTimeAsync(100);

  expect(attachment.written).toEqual([]);
  expect(attachment.detached).toBe(true);
  expect(socket.holdMessages()).toEqual(['held']);
});

it('stops writing the held keys of a terminal that closes while they are written', async () => {
  const socket = await openTerminal();
  const release = holds.hold('explain-a');
  socket.type('a');
  await vi.advanceTimersByTimeAsync(10);
  socket.type('b');
  release();

  socket.close(1001);
  await vi.advanceTimersByTimeAsync(100);

  expect(attachment.written).toEqual(['a']);
});

it('closes a terminal that sends more than a megabyte of keys during a send, writing none', async () => {
  const socket = await openTerminal();
  const release = holds.hold('explain-a');

  socket.type('x'.repeat(1024 * 1024));
  expect(socket.closedWith).toBeUndefined();
  socket.type('y');
  expect(socket.closedWith).toBe(1008);

  release();
  await vi.advanceTimersByTimeAsync(100);
  expect(attachment.written).toHaveLength(0);
});
