import { describe, expect, it } from 'vitest';
import { carriesAppToken } from '../../src/server/http/request-token.ts';
import { TOKEN_HEADER, wireSubprotocols } from '../../src/shared/wire.ts';

const TOKEN = 'the-apps-token_0123456789abcdefABCDEF-xyz';
const matches = (candidate: string | undefined) => candidate === TOKEN;
const upgrade = { upgrade: 'websocket', connection: 'Upgrade' };

describe('whether a request carries the app’s token', () => {
  it('reads an HTTP request’s token from its header', () => {
    expect(carriesAppToken({ headers: { [TOKEN_HEADER]: TOKEN } }, matches)).toBe(true);
    expect(carriesAppToken({ headers: { [TOKEN_HEADER]: 'another' } }, matches)).toBe(false);
    expect(carriesAppToken({ headers: {} }, matches)).toBe(false);
  });

  it('reads a WebSocket handshake’s token from its subprotocol, as the handler does', () => {
    const offered = wireSubprotocols(TOKEN).join(', ');

    expect(
      carriesAppToken({ headers: { ...upgrade, 'sec-websocket-protocol': offered } }, matches),
    ).toBe(true);
    expect(
      carriesAppToken(
        { headers: { upgrade: 'WebSocket', 'sec-websocket-protocol': offered } },
        matches,
      ),
    ).toBe(true);
    expect(carriesAppToken({ headers: { ...upgrade, [TOKEN_HEADER]: TOKEN } }, matches)).toBe(
      false,
    );
  });

  it('never reads a plain request’s token from a subprotocol', () => {
    const offered = wireSubprotocols(TOKEN).join(', ');

    expect(carriesAppToken({ headers: { 'sec-websocket-protocol': offered } }, matches)).toBe(
      false,
    );
  });
});
