import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { KeyQueue } from '../../src/server/sessions/key-queue.ts';

class Refused extends Error {}

function queueClosedBy(controller: AbortController): KeyQueue {
  return new KeyQueue(controller.signal, (key) => new Refused(key));
}

/** A promise settled by hand. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('the queue of the operations on a key', () => {
  it('runs them one at a time, in the order asked, each once the one before settled', async () => {
    const queue = queueClosedBy(new AbortController());
    const order: string[] = [];
    const first = deferred();

    const one = queue.run('k', async () => {
      order.push('one began');
      await first.promise;
      order.push('one ended');
    });
    const two = queue.run('k', async () => void order.push('two'));
    await settle();
    expect(order).toEqual(['one began']);

    first.resolve();
    await Promise.all([one, two]);
    expect(order).toEqual(['one began', 'one ended', 'two']);
  });

  it('lets the next operation begin once one frees its turn, while it runs on', async () => {
    const queue = queueClosedBy(new AbortController());
    const order: string[] = [];
    const parked = deferred();

    const one = queue.run('k', async (freeTurn) => {
      freeTurn();
      await parked.promise;
      order.push('one');
    });
    const two = queue.run('k', async () => void order.push('two'));
    await two;
    expect(order).toEqual(['two']);
    expect(queue.isBusy('k')).toBe(false);

    parked.resolve();
    await one;
    expect(order).toEqual(['two', 'one']);
  });

  it('refuses every operation that has not begun once closed, and those asked after', async () => {
    const controller = new AbortController();
    const queue = queueClosedBy(controller);
    const first = deferred();
    const one = queue.run('k', () => first.promise);
    const two = queue.run('k', async () => 'ran');
    await settle();

    controller.abort();

    await expect(two).rejects.toEqual(new Refused('k'));
    await expect(queue.run('j', async () => 'ran')).rejects.toEqual(new Refused('j'));
    first.resolve();
    await expect(one).resolves.toBeUndefined();
  });

  it('keeps nothing of an operation once it settled: no listener on the closing signal grows', async () => {
    const controller = new AbortController();
    const queue = queueClosedBy(controller);
    const runs: Promise<unknown>[] = [];
    for (let each = 0; each < 1000; each += 1) {
      runs.push(queue.run('k', async () => each));
      runs.push(queue.run(`k${each % 7}`, async () => each));
    }
    expect(getEventListeners(controller.signal, 'abort').length).toBeGreaterThan(0);

    await Promise.all(runs);

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(queue.isBusy('k')).toBe(false);
  });
});
