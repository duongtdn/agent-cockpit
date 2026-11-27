import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { settlesBeforeAbort } from '../../src/server/sessions/abort-race.ts';

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
