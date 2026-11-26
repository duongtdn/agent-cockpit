import { describe, expect, it } from 'vitest';
import { sandboxStatus } from '../support/real-agent/sandbox.ts';

const runs = () => undefined;
const cannotRun = () => 'bwrap: setting up uid map: Permission denied';

describe("the agent's sandbox, for the contract rows that turn it on", () => {
  it('is available where it runs', () => {
    expect(sandboxStatus(runs)).toEqual({ kind: 'available' });
  });

  it('is missing where it cannot run, naming why and what would make it run', () => {
    const status = sandboxStatus(cannotRun);

    expect(status).toEqual({ kind: 'missing', problem: expect.any(String) });
    const { problem } = status as { problem: string };
    expect(problem).toContain('bwrap: setting up uid map: Permission denied');
    expect(problem).toContain('bubblewrap');
    expect(problem).toContain('socat');
  });
});
