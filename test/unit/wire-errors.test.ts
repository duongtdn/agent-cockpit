import { describe, expect, it } from 'vitest';
import { answerOfFailure, STATUS_OF_CODE } from '../../src/server/http/wire-errors.ts';
import { SessionHostError } from '../../src/server/session-host/session-host-error.ts';
import { CockpitError } from '../../src/shared/cockpit-error.ts';

describe('the wire’s answer to a failure', () => {
  it.each([
    [new CockpitError('refused', 'Refused.', { cause: 'origin' }), 403],
    [new CockpitError('no-token', 'No token.'), 401],
    [new CockpitError('unknown-job', 'No job.', { jobId: 'x' }), 404],
    [
      new CockpitError('invalid-arguments', 'Bad.', { issues: [{ path: ['a'], message: 'm' }] }),
      400,
    ],
    [new CockpitError('wrong-state', 'Busy.', { key: 'k', state: 'busy' }), 409],
    [new CockpitError('unobservable', 'Silent.', { key: 'k', cause: 'c' }), 502],
    [new CockpitError('agent-not-found', 'None.', { command: 'claude' }), 503],
    [new CockpitError('sandbox-unavailable', 'No sandbox.', { cause: 'No bwrap.' }), 503],
  ])('carries %s with its status and its JSON, nothing else', (error, status) => {
    const answer = answerOfFailure(error);

    expect(answer.status).toBe(status);
    expect(JSON.parse(answer.body ?? '')).toEqual({ error: JSON.parse(JSON.stringify(error)) });
  });

  it('keeps the error’s own fields and drops what lies under it', () => {
    const error = new CockpitError('unknown-job', 'No job.', {
      jobId: 'x',
      cause: new Error('secret path /home/someone'),
    });

    expect(answerOfFailure(error).body).not.toMatch(/secret|stack/);
  });

  it.each([
    new SessionHostError('session-exists', 'A session of the key k lives on the host.'),
    new TypeError('"Bad Key" is no session key.'),
    'a string',
    undefined,
  ])('answers any other failure 500, with no body: %s', (failure) => {
    expect(answerOfFailure(failure)).toEqual({ status: 500 });
  });

  it('gives every code a status of failure', () => {
    for (const status of Object.values(STATUS_OF_CODE)) {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });
});
