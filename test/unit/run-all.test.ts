import { describe, expect, it } from 'vitest';
import { runAll } from '../support/run-all.ts';

describe('running every step of an ending', () => {
  it('runs each step in order, awaiting it', async () => {
    const ran: string[] = [];

    await runAll([
      async () => {
        await Promise.resolve();
        ran.push('first');
      },
      () => {
        ran.push('second');
      },
    ]);

    expect(ran).toEqual(['first', 'second']);
  });

  it('runs the steps after one that fails, and fails with its error', async () => {
    const ran: string[] = [];
    const failure = new Error('the first could not close');

    const all = runAll([
      () => Promise.reject(failure),
      () => {
        ran.push('second');
      },
    ]);

    await expect(all).rejects.toBe(failure);
    expect(ran).toEqual(['second']);
  });

  it('reports every failure when several steps fail', async () => {
    const all = runAll([
      () => {
        throw new Error('the first could not close');
      },
      () => {},
      () => Promise.reject(new Error('the third found something left')),
    ]);

    await expect(all).rejects.toThrow(
      /2 failures.*\n.*the first could not close.*\n.*the third found something left/,
    );
    await expect(all).rejects.toBeInstanceOf(AggregateError);
  });
});
