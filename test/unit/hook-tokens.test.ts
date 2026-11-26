import { describe, expect, it } from 'vitest';
import { createHookTokens } from '../../src/server/agent-listener/hook-tokens.ts';
import { isWireToken } from '../../src/shared/wire.ts';

const URL = 'http://127.0.0.1:4567';

describe('hook tokens', () => {
  it('grants a session the listener’s address and a token of its own', () => {
    const tokens = createHookTokens(URL);
    const address = tokens.grant('a');
    expect(address.url).toBe(URL);
    expect(isWireToken(address.token)).toBe(true);
    expect(Buffer.from(address.token, 'base64url')).toHaveLength(32);
    expect(tokens.grant('b').token).not.toBe(address.token);
  });

  it('tells whose a token is', () => {
    const tokens = createHookTokens(URL);
    const a = tokens.grant('a');
    const b = tokens.grant('b');
    expect(tokens.keyOf(a.token)).toBe('a');
    expect(tokens.keyOf(b.token)).toBe('b');
  });

  it.each([
    ['none', undefined],
    ['an empty one', ''],
    ['an unknown one', 'x'.repeat(43)],
  ])('knows no session by %s', (_, token) => {
    const tokens = createHookTokens(URL);
    tokens.grant('a');
    expect(tokens.keyOf(token)).toBeUndefined();
  });

  it('refuses a revoked token', () => {
    const tokens = createHookTokens(URL);
    const { token } = tokens.grant('a');
    tokens.revoke('a');
    expect(tokens.keyOf(token)).toBeUndefined();
  });

  it('takes a new launch’s token in place of the earlier one', () => {
    const tokens = createHookTokens(URL);
    const earlier = tokens.grant('a');
    const later = tokens.grant('a');
    expect(tokens.keyOf(earlier.token)).toBeUndefined();
    expect(tokens.keyOf(later.token)).toBe('a');
  });

  it('revokes nothing on a key it never granted', () => {
    const tokens = createHookTokens(URL);
    const { token } = tokens.grant('a');
    tokens.revoke('b');
    expect(tokens.keyOf(token)).toBe('a');
  });
});
