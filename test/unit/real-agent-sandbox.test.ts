import { describe, expect, it } from 'vitest';
import { SANDBOX_LACKING_VARIABLE, sandboxStatus } from '../support/real-agent/sandbox.ts';

const runs = () => undefined;
const cannotRun = () => 'bwrap: setting up uid map: Permission denied';

describe("the agent's sandbox, for the contract rows that turn it on", () => {
  it('is available where it runs, whatever the variables say', () => {
    expect(sandboxStatus({}, runs)).toEqual({ kind: 'available' });
    expect(
      sandboxStatus({ CI: 'true', [SANDBOX_LACKING_VARIABLE]: 'no namespaces' }, runs),
    ).toEqual({ kind: 'available' });
  });

  it('is missing where it cannot run, naming why and what would tell the platform lacks it', () => {
    const status = sandboxStatus({}, cannotRun);

    expect(status).toEqual({ kind: 'missing', problem: expect.any(String) });
    const { problem } = status as { problem: string };
    expect(problem).toContain('bwrap: setting up uid map: Permission denied');
    expect(problem).toContain('bubblewrap');
    expect(problem).toContain(SANDBOX_LACKING_VARIABLE);
  });

  it('is declared lacking only by CI, with the reason CI gives', () => {
    expect(
      sandboxStatus(
        { CI: 'true', [SANDBOX_LACKING_VARIABLE]: 'the runner has no namespaces' },
        cannotRun,
      ),
    ).toEqual({
      kind: 'declared-lacking',
      reason: 'the runner has no namespaces',
      problem: 'bwrap: setting up uid map: Permission denied',
    });
  });

  it.each([
    ['outside CI', { [SANDBOX_LACKING_VARIABLE]: 'lacking' }],
    ['with an empty reason', { CI: 'true', [SANDBOX_LACKING_VARIABLE]: '' }],
    ['when CI is not true', { CI: '1', [SANDBOX_LACKING_VARIABLE]: 'lacking' }],
  ])('is still missing %s: a person cannot declare it away', (_where, variables) => {
    expect(sandboxStatus(variables, cannotRun)).toMatchObject({ kind: 'missing' });
  });
});
