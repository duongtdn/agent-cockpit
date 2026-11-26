import { describe, expect, it } from 'vitest';
import {
  agentConfiguration,
  agentEnvironment,
  FAKE_API_KEY,
  onlyTheseVariables,
  variablesAfter,
} from '../support/real-agent/environment.ts';

const folders = {
  root: '/tmp/r',
  home: '/tmp/r/home',
  configFolder: '/tmp/r/config',
  workFolder: '/tmp/r/work',
  temporaryFolder: '/tmp/r/tmp',
};

describe("the real agent's environment", () => {
  it('is the recipe that starts with no login and calls nothing but the fake API', () => {
    expect(agentEnvironment(folders, 'http://127.0.0.1:4010')).toEqual({
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/tmp/r/home',
      CLAUDE_CONFIG_DIR: '/tmp/r/config',
      TMPDIR: '/tmp/r/tmp',
      LANG: 'C.UTF-8',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4010',
      ANTHROPIC_API_KEY: FAKE_API_KEY,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
      DISABLE_AUTOUPDATER: '1',
    });
  });

  it('uses a key no one could take for a real one', () => {
    expect(FAKE_API_KEY).toMatch(/fake/i);
  });

  it('gives a session these variables and removes every one the process has beside them', () => {
    const inherited = {
      PATH: '/somewhere/bin',
      HOME: '/home/someone',
      CLAUDECODE: '1',
      CLAUDE_CODE_SSE_PORT: '1234',
      ANTHROPIC_AUTH_TOKEN: 'a real token',
      EDITOR: 'vi',
      UNSET: undefined,
    };

    const environment = onlyTheseVariables({ PATH: '/usr/bin', HOME: '/tmp/r/home' }, inherited);

    expect(environment.set).toEqual({ PATH: '/usr/bin', HOME: '/tmp/r/home' });
    expect([...environment.remove].sort()).toEqual([
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDECODE',
      'CLAUDE_CODE_SSE_PORT',
      'EDITOR',
      'UNSET',
    ]);
  });
});

describe('what a session finds in its environment', () => {
  it('is what the process has, without what is removed, with what is set', () => {
    const inherited = {
      PATH: '/somewhere/bin',
      HTTPS_PROXY: 'http://proxy',
      EDITOR: 'vi',
      UNSET: undefined,
    };

    expect(
      variablesAfter({ set: { PATH: '/usr/bin', LANG: 'C.UTF-8' }, remove: ['EDITOR'] }, inherited),
    ).toEqual({ PATH: '/usr/bin', LANG: 'C.UTF-8', HTTPS_PROXY: 'http://proxy' });
  });

  it('is the variables named alone, after onlyTheseVariables', () => {
    const inherited = { PATH: '/somewhere/bin', HTTPS_PROXY: 'http://proxy' };
    const variables = { PATH: '/usr/bin' };

    expect(variablesAfter(onlyTheseVariables(variables, inherited), inherited)).toEqual(variables);
  });
});

describe("the real agent's configuration", () => {
  it('marks onboarding done, the key approved and the work folder trusted', () => {
    expect(agentConfiguration(folders)).toEqual({
      hasCompletedOnboarding: true,
      customApiKeyResponses: { approved: [FAKE_API_KEY.slice(-20)] },
      projects: { '/tmp/r/work': { hasTrustDialogAccepted: true } },
    });
  });
});
