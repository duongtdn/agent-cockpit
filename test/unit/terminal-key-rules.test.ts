import { expect, it } from 'vitest';
import type { KeyRule } from '../../src/shared/wire.ts';
import { ruleForKey } from '../../src/terminal/key-rules.ts';

const none = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false };
const rules: KeyRule[] = [
  { key: 'Enter', modifiers: ['shift'], send: 'shift-enter' },
  { key: 'Enter', modifiers: [], send: 'enter' },
  { key: 'k', modifiers: ['ctrl', 'alt', 'meta'], send: 'chord' },
];

it('matches the key with exactly the modifiers held', () => {
  expect(ruleForKey(rules, { ...none, key: 'Enter', shiftKey: true })?.send).toBe('shift-enter');
  expect(ruleForKey(rules, { ...none, key: 'Enter' })?.send).toBe('enter');
  expect(
    ruleForKey(rules, { ...none, key: 'k', ctrlKey: true, altKey: true, metaKey: true })?.send,
  ).toBe('chord');
});

it('matches no rule when a modifier is missing or one more is held', () => {
  expect(ruleForKey(rules, { ...none, key: 'Enter', shiftKey: true, metaKey: true })).toBe(
    undefined,
  );
  expect(ruleForKey(rules, { ...none, key: 'k', ctrlKey: true, altKey: true })).toBe(undefined);
  expect(ruleForKey(rules, { ...none, key: 'Tab' })).toBe(undefined);
});
