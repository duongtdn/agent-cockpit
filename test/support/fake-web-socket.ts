import { vi } from 'vitest';

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
  /** Whether the page closed it. */
  closedByPage = false;

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

  /** The server accepts the handshake. */
  accept(): void {
    this.dispatchEvent(new Event('open'));
  }

  /** The server sends a message. */
  deliver(data: string | ArrayBuffer): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  /** The connection ends: after `accept`, a drop; before it, a refused handshake. */
  drop(): void {
    this.dispatchEvent(new Event('error'));
    this.dispatchEvent(new CloseEvent('close', { code: 1006 }));
  }
}
