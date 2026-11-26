import { describe, expect, it, vi } from 'vitest';
import { createAgentStatus, type TestedRange } from '../../src/server/agent-status.ts';

const RANGE: TestedRange = { oldest: '2.1.330', newest: '2.1.332' };

describe("the cockpit's status of the agent", () => {
  it('knows no version before one is read, and counts none as tested', () => {
    expect(createAgentStatus(RANGE).current()).toEqual({ tested: false, testedRange: RANGE });
  });

  it('gives the version last read, tested when within the range', () => {
    const status = createAgentStatus(RANGE);

    status.record({ found: true, version: '2.1.331', standing: 'tested' });

    expect(status.current()).toEqual({
      agentVersion: '2.1.331',
      tested: true,
      testedRange: RANGE,
    });
  });

  it.each([
    ['newer', '2.2.0'],
    ['older', '2.0.0'],
  ] as const)('counts a version %s than the range as untested', (standing, version) => {
    const status = createAgentStatus(RANGE);

    status.record({ found: true, version, standing });

    expect(status.current()).toEqual({ agentVersion: version, tested: false, testedRange: RANGE });
  });

  it('forgets the version once the agent is no longer found', () => {
    const status = createAgentStatus(RANGE);
    status.record({ found: true, version: '2.1.332', standing: 'tested' });

    status.record({ found: false, command: 'claude' });

    expect(status.current()).toEqual({ tested: false, testedRange: RANGE });
  });

  it('tells each handler of a newer version once per version', () => {
    const status = createAgentStatus(RANGE);
    const first = vi.fn();
    const second = vi.fn();
    status.onUntested(first);
    status.onUntested(second);

    status.record({ found: true, version: '2.2.0', standing: 'newer' });
    status.record({ found: true, version: '2.2.0', standing: 'newer' });
    status.record({ found: true, version: '2.1.332', standing: 'tested' });
    status.record({ found: true, version: '2.2.0', standing: 'newer' });
    status.record({ found: true, version: '2.3.0', standing: 'newer' });

    for (const handler of [first, second]) {
      expect(handler.mock.calls).toEqual([
        [{ agentVersion: '2.2.0', testedRange: RANGE }],
        [{ agentVersion: '2.3.0', testedRange: RANGE }],
      ]);
    }
  });

  it('tells nothing of a tested version, an older one, or none found', () => {
    const status = createAgentStatus(RANGE);
    const handler = vi.fn();
    status.onUntested(handler);

    status.record({ found: true, version: '2.1.332', standing: 'tested' });
    status.record({ found: true, version: '2.0.0', standing: 'older' });
    status.record({ found: false, command: 'claude' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('counts a newer version told while no handler listened as told', () => {
    const status = createAgentStatus(RANGE);
    status.record({ found: true, version: '2.2.0', standing: 'newer' });
    const handler = vi.fn();
    status.onUntested(handler);

    status.record({ found: true, version: '2.2.0', standing: 'newer' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('stops telling a handler once removed, the others still told', () => {
    const status = createAgentStatus(RANGE);
    const removed = vi.fn();
    const kept = vi.fn();
    const stop = status.onUntested(removed);
    status.onUntested(kept);

    stop();
    status.record({ found: true, version: '2.2.0', standing: 'newer' });

    expect(removed).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledOnce();
  });

  it('gives what a handler throws to the fallback, and still tells the others', () => {
    const fallback = vi.fn();
    const status = createAgentStatus(RANGE, fallback);
    const broken = new Error('broken');
    const kept = vi.fn();
    status.onUntested(() => {
      throw broken;
    });
    status.onUntested(kept);

    status.record({ found: true, version: '2.2.0', standing: 'newer' });

    expect(fallback).toHaveBeenCalledWith(broken);
    expect(kept).toHaveBeenCalledOnce();
  });
});
