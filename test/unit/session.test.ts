import { describe, expect, it } from 'vitest';
import { isSessionKey } from '../../src/shared/session.ts';

describe('a session key', () => {
  it.each(['a', 'chapter-1-2', '0', '-', 'explain-src-index-ts'])('accepts %j', (text) => {
    expect(isSessionKey(text)).toBe(true);
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
