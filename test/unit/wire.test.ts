import { describe, expect, it } from 'vitest';
import {
  keyOfTerminalPath,
  terminalPath,
  tokenOfSubprotocols,
  WIRE_SUBPROTOCOL,
  wireSubprotocols,
} from '../../src/shared/wire.ts';

const token = 'kq3J_x-9Zt0aPbXw2eYc8vRm4nLs6uHd1oQiGfAjK7E';

/** What a browser puts in `Sec-WebSocket-Protocol` for the subprotocols it offers. */
function offeredHeader(protocols: readonly string[]): string {
  return protocols.join(', ');
}

describe('the subprotocols that carry the token', () => {
  it('offers the wire subprotocol, then the token', () => {
    const protocols = wireSubprotocols(token);

    expect(protocols[0]).toBe(WIRE_SUBPROTOCOL);
    expect(protocols).toHaveLength(2);
    expect(protocols[1]).toContain(token);
  });

  it('gives the server the token back from the handshake header', () => {
    expect(tokenOfSubprotocols(offeredHeader(wireSubprotocols(token)))).toBe(token);
  });

  it('reads the header whatever its spacing and order', () => {
    const [wire, carrier] = wireSubprotocols(token);

    expect(tokenOfSubprotocols(`${carrier},${wire}`)).toBe(token);
    expect(tokenOfSubprotocols(`  ${wire} ,  ${carrier}  `)).toBe(token);
  });

  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['the wire subprotocol alone', WIRE_SUBPROTOCOL],
    ['another subprotocol', 'graphql-ws'],
  ])('finds no token in %s', (_, header) => {
    expect(tokenOfSubprotocols(header)).toBeUndefined();
  });

  it('finds no token without the wire subprotocol beside it', () => {
    const [, carrier] = wireSubprotocols(token);

    expect(tokenOfSubprotocols(carrier)).toBeUndefined();
  });

  it('finds no token when two are offered: which one is meant cannot be told', () => {
    const [wire, carrier] = wireSubprotocols(token);
    const [, other] = wireSubprotocols('another-token');

    expect(tokenOfSubprotocols(offeredHeader([wire ?? '', carrier ?? '', other ?? '']))).toBe(
      undefined,
    );
  });

  it('finds no token in a carrier left empty', () => {
    const [wire, carrier] = wireSubprotocols(token);
    const empty = (carrier ?? '').slice(0, -token.length);

    expect(tokenOfSubprotocols(offeredHeader([wire ?? '', empty]))).toBeUndefined();
  });

  it.each([
    ['an empty token', ''],
    ['a space', 'a b'],
    ['a comma, which would split the header', 'a,b'],
    ['an equals sign, which base64 padding brings', 'abc='],
    ['a slash', 'a/b'],
    ['a character beyond ASCII', 'abcé'],
  ])('refuses %s, which no subprotocol can carry', (_, text) => {
    expect(() => wireSubprotocols(text)).toThrow(TypeError);
  });
});

describe('the path of a session terminal', () => {
  it('is read back to the key it was made from', () => {
    expect(keyOfTerminalPath(terminalPath('chapter-1-2'))).toBe('chapter-1-2');
  });

  it('starts with a slash, as every path of the wire does', () => {
    expect(terminalPath('a')).toMatch(/^\/[^/]+\/a$/);
  });

  it.each([
    ['an empty key', ''],
    ['an upper-case letter', 'Chapter'],
    ['a slash', 'a/b'],
    ['a dot segment', '..'],
  ])('refuses %s, which is no key', (_, key) => {
    expect(() => terminalPath(key)).toThrow(TypeError);
  });

  it.each([
    ['the bare prefix', terminalPath('a').slice(0, -1)],
    ['a key that is no key', terminalPath('a').replace(/a$/, 'A')],
    ['a deeper path', `${terminalPath('a')}/b`],
    ['a query', `${terminalPath('a')}?x=1`],
    ['an encoded character', terminalPath('a').replace(/a$/, '%61')],
    ['another path', '/sessions'],
  ])('reads no key from %s', (_, path) => {
    expect(keyOfTerminalPath(path)).toBeUndefined();
  });
});
