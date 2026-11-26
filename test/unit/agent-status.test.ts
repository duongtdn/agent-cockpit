import { describe, expect, it, vi } from 'vitest';
import { createAgentStatus, type TestedRange } from '../../src/server/agent-status.ts';
import { isCockpitError } from '../../src/shared/cockpit-error.ts';

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

  it('tells each handler of a newer version once per version a launch runs', () => {
    const status = createAgentStatus(RANGE);
    const first = vi.fn();
    const second = vi.fn();
    status.onUntested(first);
    status.onUntested(second);

    status.admit({ found: true, version: '2.2.0', standing: 'newer' });
    status.admit({ found: true, version: '2.2.0', standing: 'newer' });
    status.admit({ found: true, version: '2.1.332', standing: 'tested' });
    status.admit({ found: true, version: '2.2.0', standing: 'newer' });
    status.admit({ found: true, version: '2.3.0', standing: 'newer' });

    for (const handler of [first, second]) {
      expect(handler.mock.calls).toEqual([
        [{ agentVersion: '2.2.0', testedRange: RANGE }],
        [{ agentVersion: '2.3.0', testedRange: RANGE }],
      ]);
    }
  });

  it('tells nothing of a version read with no launch, and tells it at the first launch that runs it', () => {
    const status = createAgentStatus(RANGE);
    const handler = vi.fn();
    status.onUntested(handler);

    status.record({ found: true, version: '2.2.0', standing: 'newer' });
    expect(handler).not.toHaveBeenCalled();
    expect(status.current()).toEqual({ agentVersion: '2.2.0', tested: false, testedRange: RANGE });

    status.admit({ found: true, version: '2.2.0', standing: 'newer' });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('tells each handler of a suffixed build once, as of a newer version: no test ran on it', () => {
    const status = createAgentStatus(RANGE);
    const handler = vi.fn();
    status.onUntested(handler);

    status.admit({ found: true, version: '2.1.332-beta', standing: 'untested' });
    status.admit({ found: true, version: '2.1.332-beta', standing: 'untested' });

    expect(handler.mock.calls).toEqual([[{ agentVersion: '2.1.332-beta', testedRange: RANGE }]]);
    expect(status.current()).toEqual({
      agentVersion: '2.1.332-beta',
      tested: false,
      testedRange: RANGE,
    });
  });

  it('refuses a launch with an agent found that cannot be run: agent-not-found, why in the message, what it printed in the cause only', () => {
    const status = createAgentStatus(RANGE);
    status.record({ found: true, version: '2.1.332', standing: 'tested' });
    let refusal: unknown;
    try {
      status.admit({
        found: false,
        command: 'claude',
        failure: { reason: 'claude --version exited with status 70', output: 'a secret path' },
      });
    } catch (error) {
      refusal = error;
    }

    expect(isCockpitError(refusal, 'agent-not-found')).toBe(true);
    expect(refusal).toMatchObject({
      command: 'claude',
      message: expect.stringContaining('claude --version exited with status 70'),
    });
    expect((refusal as Error).cause).toEqual(new Error('a secret path'));
    expect(JSON.stringify(refusal)).not.toContain('a secret path');
    expect(status.current()).toEqual({ tested: false, testedRange: RANGE });
  });

  it('admits a tested version, telling nothing', () => {
    const status = createAgentStatus(RANGE);
    const handler = vi.fn();
    status.onUntested(handler);

    status.admit({ found: true, version: '2.1.332', standing: 'tested' });

    expect(handler).not.toHaveBeenCalled();
    expect(status.current()).toMatchObject({ agentVersion: '2.1.332', tested: true });
  });

  it('refuses a launch with no agent: agent-not-found, naming the command; the version forgotten', () => {
    const status = createAgentStatus(RANGE);
    status.record({ found: true, version: '2.1.332', standing: 'tested' });

    expect(() => status.admit({ found: false, command: 'claude' })).toThrow(
      expect.objectContaining({ code: 'agent-not-found', command: 'claude' }),
    );
    expect(status.current()).toEqual({ tested: false, testedRange: RANGE });
  });

  it('refuses a launch with an agent older than the range: agent-too-old, telling nothing', () => {
    const status = createAgentStatus(RANGE);
    const handler = vi.fn();
    status.onUntested(handler);

    let refusal: unknown;
    try {
      status.admit({ found: true, version: '2.0.0', standing: 'older' });
    } catch (error) {
      refusal = error;
    }

    expect(isCockpitError(refusal, 'agent-too-old')).toBe(true);
    expect(refusal).toMatchObject({ found: '2.0.0', oldestTested: RANGE.oldest });
    expect(handler).not.toHaveBeenCalled();
    expect(status.current()).toEqual({ agentVersion: '2.0.0', tested: false, testedRange: RANGE });
  });

  it('counts a newer version told while no handler listened as told', () => {
    const status = createAgentStatus(RANGE);
    status.admit({ found: true, version: '2.2.0', standing: 'newer' });
    const handler = vi.fn();
    status.onUntested(handler);

    status.admit({ found: true, version: '2.2.0', standing: 'newer' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('stops telling a handler once removed, the others still told', () => {
    const status = createAgentStatus(RANGE);
    const removed = vi.fn();
    const kept = vi.fn();
    const stop = status.onUntested(removed);
    status.onUntested(kept);

    stop();
    status.admit({ found: true, version: '2.2.0', standing: 'newer' });

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

    status.admit({ found: true, version: '2.2.0', standing: 'newer' });

    expect(fallback).toHaveBeenCalledWith(broken);
    expect(kept).toHaveBeenCalledOnce();
  });
});
