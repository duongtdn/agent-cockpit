import { describe, expect, it } from 'vitest';
import { slownessOf } from '../support/patience.ts';

describe('the slowness factor', () => {
  it('is 1 when the machine says nothing', () => {
    expect(slownessOf(undefined)).toBe(1);
    expect(slownessOf('')).toBe(1);
  });

  it('is the number the machine gives', () => {
    expect(slownessOf('2')).toBe(2);
    expect(slownessOf('1.5')).toBe(1.5);
  });

  it.each(['0.5', '0', '-2', 'two', 'Infinity'])(
    'refuses %s, which would shorten every wait or make none end',
    (value) => {
      expect(() => slownessOf(value)).toThrow('COCKPIT_TEST_SLOWNESS');
    },
  );
});
