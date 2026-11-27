import { describe, expect, it } from 'vitest';
import { isSessionKey, SESSION_KEY_MAX_LENGTH } from '../../src/shared/session.ts';

describe('a session key', () => {
  it.each(['a', 'chapter-1-2', '0', '-', 'explain-src-index-ts'])('accepts %j', (text) => {
    expect(isSessionKey(text)).toBe(true);
  });

  it('accepts a key of 100 characters, the bound', () => {
    expect(SESSION_KEY_MAX_LENGTH).toBe(100);
    expect(isSessionKey('a'.repeat(100))).toBe(true);
  });

  it('refuses a key of 101 characters: it would break a file name the key is in', () => {
    expect(isSessionKey('a'.repeat(101))).toBe(false);
  });

  it.each([
    ['an empty text', ''],
    ['an upper-case letter', 'Chapter'],
    ['an underscore', 'a_b'],
    ['a slash', 'a/b'],
    ['a dot', 'a.b'],
    ['a space', 'a b'],
    ['a line break at the end', 'a\n'],
    ['a letter beyond ASCII', 'é'],
  ])('refuses %s', (_, text) => {
    expect(isSessionKey(text)).toBe(false);
  });
});
