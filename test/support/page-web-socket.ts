import { vi } from 'vitest';

/**
 * Node's own `WebSocket`, made to fail a connection as a browser does. When
 * the server refuses the handshake, a browser fires `error`, then `close`
 * with code 1006, and the page learns of the refusal from `close`. Node 22's
 * `WebSocket` fires `error` alone and leaves the socket connecting, so the
 * `close` is completed here; Node 23 and later fire it themselves, having
 * closed the socket before `error`, and are left as they are.
 */
class PageWebSocket extends WebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    this.addEventListener('error', () => {
      if (this.readyState !== WebSocket.CONNECTING) return;
      queueMicrotask(() => this.dispatchEvent(new FailedConnectionClose()));
    });
  }
}

/** The `close` a browser fires when a connection fails: code 1006, not clean. */
class FailedConnectionClose extends Event {
  readonly code = 1006;
  readonly reason = '';
  readonly wasClean = false;

  constructor() {
    super('close');
  }
}

/**
 * Gives the page a real `WebSocket` that fails a connection as a browser
 * does, whatever Node runs the test. `vi.unstubAllGlobals()` removes it.
 */
export function installPageWebSocket(): void {
  vi.stubGlobal('WebSocket', PageWebSocket);
}
