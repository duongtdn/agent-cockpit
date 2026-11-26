import { describe, expect, it, vi } from 'vitest';
import { createFailureReport } from '../../src/server/failures.ts';
import { isCockpitError } from '../../src/shared/cockpit-error.ts';

describe('the failures the cockpit reports to the app', () => {
  it('reach every error handler as internal-failure, where it happened, what was thrown under it', () => {
    const fallback = vi.fn();
    const failures = createFailureReport(fallback);
    const first = vi.fn();
    const second = vi.fn();
    failures.on(first);
    failures.on(second);
    const thrown = new Error('broken');

    failures.report('authorize', thrown);

    for (const handler of [first, second]) {
      const [error] = handler.mock.calls[0] ?? [];
      expect(isCockpitError(error, 'internal-failure')).toBe(true);
      expect(error).toMatchObject({ where: 'authorize', cause: thrown });
    }
    expect(fallback).not.toHaveBeenCalled();
  });

  it('go to the fallback, the console, while the app has no error handler', () => {
    const fallback = vi.fn();
    const failures = createFailureReport(fallback);
    const stop = failures.on(() => {});
    stop();

    failures.report('handler', 'not even an error');

    expect(fallback).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'internal-failure',
        where: 'handler',
        cause: 'not even an error',
      }),
    );
  });

  it('keep a handler given twice as two, each stopped by its own function', () => {
    const failures = createFailureReport(vi.fn());
    const handler = vi.fn();
    const stopFirst = failures.on(handler);
    failures.on(handler);
    stopFirst();

    failures.report('agent-listener', new Error('broken'));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('give what a handler throws to the fallback, and still reach the other handlers', () => {
    const fallback = vi.fn();
    const failures = createFailureReport(fallback);
    const own = new Error('the handler’s own');
    const later = vi.fn();
    failures.on(() => {
      throw own;
    });
    failures.on(later);

    failures.report('handler', new Error('broken'));

    expect(fallback).toHaveBeenCalledWith(own);
    expect(later).toHaveBeenCalledTimes(1);
  });
});
