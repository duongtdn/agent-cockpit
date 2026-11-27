import { expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { type BridgedSessions, bridgeTerminal } from '../../src/server/http/pty-bridge.ts';
import { createTerminalHolds } from '../../src/server/terminal-hold.ts';
import { FELL_BEHIND_CLOSE_CODE } from '../../src/shared/wire.ts';
import { FakeAttachment } from '../support/fake-attachment.ts';
import { FakeServerSocket } from '../support/fake-server-socket.ts';

const MIB = 1024 * 1024;

/** One turn of the event loop: what arrived together has been sent. */
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

/** Opens a terminal on a session whose attachment is the one given, and waits until attached. */
async function openTerminal(attachment: FakeAttachment): Promise<FakeServerSocket> {
  const sessions: BridgedSessions = {
    attach: async () => attachment,
    isLive: async () => true,
    joinHold: (key, terminal) => createTerminalHolds().join(key, terminal),
  };
  const socket = new FakeServerSocket();
  void bridgeTerminal(socket as unknown as WebSocket, 'explain-a', sessions, []);
  socket.resize(80, 24);
  await nextTurn();
  return socket;
}

it('sends what the session draws in one turn of the event loop as one message, in order', async () => {
  const attachment = new FakeAttachment();
  const socket = await openTerminal(attachment);

  attachment.draw('one ');
  attachment.draw('two ');
  attachment.draw('three');
  expect(socket.output).toEqual([]);
  await nextTurn();
  attachment.draw('four');
  await nextTurn();

  expect(socket.output).toEqual(['one two three', 'four']);
});

it('writes a key to the session at once, and sends its echo within the turn it comes in', async () => {
  const attachment = new FakeAttachment();
  const socket = await openTerminal(attachment);

  socket.type('x');
  expect(attachment.written).toEqual(['x']);
  attachment.draw('x');
  await nextTurn();

  expect(socket.output).toEqual(['x']);
});

it('closes a terminal whose socket still holds more than 4 MiB with 4001, sending nothing more; the other terminals go on', async () => {
  const behindAttachment = new FakeAttachment();
  const otherAttachment = new FakeAttachment();
  const behind = await openTerminal(behindAttachment);
  const other = await openTerminal(otherAttachment);

  behind.bufferedAmount = 4 * MIB;
  behindAttachment.draw('still sent');
  await nextTurn();
  expect(behind.output).toEqual(['still sent']);
  expect(behind.closedWith).toBeUndefined();

  behind.bufferedAmount = 4 * MIB + 1;
  behindAttachment.draw('too far behind');
  otherAttachment.draw('on time');
  await nextTurn();

  expect(behind.closedWith).toBe(FELL_BEHIND_CLOSE_CODE);
  expect(behind.output).toEqual(['still sent']);
  expect(behindAttachment.detached).toBe(true);
  expect(other.closedWith).toBeUndefined();
  expect(other.output).toEqual(['on time']);
});

it('sends nothing drawn after the socket closed', async () => {
  const attachment = new FakeAttachment();
  const socket = await openTerminal(attachment);

  attachment.draw('late');
  socket.close(1000);
  await nextTurn();

  expect(socket.output).toEqual([]);
});
