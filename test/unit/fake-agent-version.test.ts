import { describe, expect, it } from 'vitest';
import {
  fakeAgentVersion,
  VERSION_VARIABLE,
  versionOutput,
} from '../support/fake-agent/version.ts';

describe("the fake agent's version", () => {
  it("is the pinned agent's, or the test's", () => {
    expect(fakeAgentVersion({})).toMatch(/^\d+\.\d+\.\d+$/);
    expect(fakeAgentVersion({ [VERSION_VARIABLE]: '9.9.9' })).toBe('9.9.9');
  });

  it('is said as Claude Code says it', () => {
    expect(versionOutput('2.1.332')).toBe('2.1.332 (Claude Code)\n');
  });
});
