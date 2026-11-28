import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fulfilledWithin, settlesBeforeAbort } from '../../src/server/sessions/abort-race.ts';

describe('a wait raced against an abort', () => {
  it('is `true` once the promise settled, fulfilled or rejected, and leaves no listener', async () => {
    const controller = new AbortController();

    await expect(settlesBeforeAbort(Promise.resolve('a'), controller.signal)).resolves.toBe(true);
    await expect(
      settlesBeforeAbort(Promise.reject(new Error('b')), controller.signal),
    ).resolves.toBe(true);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('is `false` once the signal aborted first, or had aborted already', async () => {
    const controller = new AbortController();
    const waiting = settlesBeforeAbort(new Promise(() => {}), controller.signal);

    controller.abort();

    await expect(waiting).resolves.toBe(false);
    await expect(settlesBeforeAbort(Promise.resolve(), controller.signal)).resolves.toBe(false);
  });

  it('keeps a listener only while it waits, however many waits raced the signal', async () => {
    const controller = new AbortController();
    const waits = Array.from({ length: 500 }, () =>
      settlesBeforeAbort(Promise.resolve(), controller.signal),
    );
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(500);

    await Promise.all(waits);

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});

describe('a wait bounded in time and raced against an abort', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives what the promise gives within the time, leaving no timer and no listener', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();

    await expect(fulfilledWithin(Promise.resolve('a'), 1000, controller.signal)).resolves.toBe('a');
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('gives `undefined` once the time passed first', async () => {
    vi.useFakeTimers();
    const waiting = fulfilledWithin(new Promise(() => {}), 1000, new AbortController().signal);
    let outcome: unknown = 'pending';
    void waiting.then((value) => {
      outcome = value;
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBeUndefined();
  });

  it('gives `undefined` once the signal aborted first, leaving no timer', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const waiting = fulfilledWithin(new Promise(() => {}), 1000, controller.signal);

    controller.abort();

    await expect(waiting).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects as the promise does within the time', async () => {
    const failure = new Error('No.');

    await expect(
      fulfilledWithin(Promise.reject(failure), 1000, new AbortController().signal),
    ).rejects.toBe(failure);
  });
});
