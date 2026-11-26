import { vi } from 'vitest';

/**
 * The browser's `CloseEvent`, as far as the page reads it. Node has no
 * global `CloseEvent` before 23, and the package supports Node 22.
 */
class FakeCloseEvent extends Event {
  readonly code: number;
  readonly reason = '';
  readonly wasClean: boolean;

  constructor(code: number) {
    super('close');
    this.code = code;
    this.wasClean = code !== 1006;
  }
}

/**
 * A browser `WebSocket` the test drives by hand: it opens, delivers, drops or
 * fails only when told. For what depends on time between connections (the
 * back-off), with fake timers; the wire itself is tested on real sockets.
 */
export class FakeWebSocket extends EventTarget {
  /** Every socket the page created, in order. */
  static readonly created: FakeWebSocket[] = [];

  /** The URL the page opened. */
  readonly url: string;
  /** The subprotocols the page offered. */
  readonly protocols: readonly string[];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  /** Whether the page closed it. */
  closedByPage = false;
  /** As the page set it. */
  binaryType: BinaryType = 'blob';
  readyState: number = FakeWebSocket.CONNECTING;
  /** Every message the page sent, in order. */
  readonly sent: (string | Uint8Array)[] = [];

  constructor(url: string | URL, protocols: string | string[] = []) {
    super();
    this.url = String(url);
    this.protocols = typeof protocols === 'string' ? [protocols] : protocols;
    FakeWebSocket.created.push(this);
  }

  /** Stubs the global `WebSocket` with this class, forgetting earlier sockets. */
  static install(): void {
    FakeWebSocket.created.length = 0;
    vi.stubGlobal('WebSocket', FakeWebSocket);
  }

  /** The last socket the page created. */
  static last(): FakeWebSocket {
    const socket = FakeWebSocket.created.at(-1);
    if (socket === undefined) throw new Error('The page opened no WebSocket.');
    return socket;
  }

  close(): void {
    this.closedByPage = true;
  }

  send(data: string | Uint8Array): void {
    if (this.readyState !== FakeWebSocket.OPEN)
      throw new Error('Sent on a socket that is not open.');
    this.sent.push(data);
  }

  /** The server accepts the handshake. */
  accept(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  /** The server sends a message. */
  deliver(data: string | ArrayBuffer): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  /** The connection ends: after `accept`, a drop; before it, a refused handshake. */
  drop(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event('error'));
    this.dispatchEvent(new FakeCloseEvent(1006));
  }

  /** The server closes the connection with a code. */
  closeWith(code: number): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new FakeCloseEvent(code));
  }
}
