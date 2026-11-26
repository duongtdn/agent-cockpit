import { describe, expect, it } from 'vitest';
import { mintToken, tokensMatch } from '../../src/server/state/tokens.ts';
import { isWireToken } from '../../src/shared/wire.ts';

describe('mintToken', () => {
  it('gives 256 random bits as base64url without padding, which a subprotocol can carry', () => {
    const token = mintToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(isWireToken(token)).toBe(true);
  });

  it('never gives the same token twice', () => {
    const tokens = new Set(Array.from({ length: 1000 }, mintToken));
    expect(tokens.size).toBe(1000);
  });
});

describe('tokensMatch', () => {
  const token = mintToken();

  it('matches the same token', () => {
    expect(tokensMatch(token, `${token}`)).toBe(true);
  });

  it.each([
    ['another token', mintToken()],
    ['a prefix', token.slice(0, 42)],
    ['a longer one', `${token}A`],
    ['an empty one', ''],
    ['none', undefined],
  ])('does not match %s', (_, candidate) => {
    expect(tokensMatch(token, candidate)).toBe(false);
  });
});
