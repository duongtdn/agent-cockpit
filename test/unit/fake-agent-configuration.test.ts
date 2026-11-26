import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readConfiguration, type StartingSession } from '../support/fake-agent/configuration.ts';
import {
  fakeAgentVersion,
  VERSION_VARIABLE,
  versionOutput,
} from '../support/fake-agent/version.ts';
import { agentConfiguration, FAKE_API_KEY } from '../support/real-agent/environment.ts';

let configFolder: string;
let session: StartingSession;

beforeEach(() => {
  configFolder = mkdtempSync(join(tmpdir(), 'cockpit-fake-agent-configuration-'));
  session = { configFolder, cwd: '/work/project', permissionMode: 'default', apiKey: FAKE_API_KEY };
});

afterEach(() => {
  rmSync(configFolder, { recursive: true, force: true });
});

function writeState(state: object): void {
  writeFileSync(join(configFolder, '.claude.json'), JSON.stringify(state));
}

function writePersonsSettings(settings: object): void {
  writeFileSync(join(configFolder, 'settings.json'), JSON.stringify(settings));
}

function readBack(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(configFolder, file), 'utf8'));
}

describe("the fake agent's configuration, read as Claude Code reads it", () => {
  it('shows nothing at the start for the recipe: onboarded, the folder trusted, the key approved', () => {
    writeState(agentConfiguration({ workFolder: '/work/project' }));

    expect(readConfiguration(session)).toMatchObject({
      startUpDialogs: [],
      hooksOff: false,
      keyRejected: false,
    });
  });

  it('plays a configuration folder with no .claude.json as the recipe', () => {
    expect(readConfiguration({ ...session, apiKey: undefined }).startUpDialogs).toEqual([]);
  });

  it('trusts a folder inside a trusted one (behavior 37)', () => {
    writeState(agentConfiguration({ workFolder: '/work' }));

    expect(readConfiguration(session).startUpDialogs).toEqual([]);
    expect(readConfiguration({ ...session, cwd: '/workshop' }).startUpDialogs).toEqual([
      'trust-folder',
    ]);
  });

  it('shows the trust dialog, then the warning of bypassPermissions, each piece left out', () => {
    writeState(agentConfiguration({ workFolder: '/work/project' }, ['folder-trust']));

    expect(
      readConfiguration({ ...session, permissionMode: 'bypassPermissions' }).startUpDialogs,
    ).toEqual(['trust-folder', 'bypass-permissions']);
  });

  it("warns no more in bypassPermissions once the person's settings accept it", () => {
    writePersonsSettings({ skipDangerousModePermissionPrompt: true });

    expect(
      readConfiguration({ ...session, permissionMode: 'bypassPermissions' }).startUpDialogs,
    ).toEqual([]);
  });

  it('asks about a key neither approved nor rejected, and tells a rejected one', () => {
    writeState(agentConfiguration({ workFolder: '/work/project' }, ['key-approval']));
    expect(readConfiguration(session).startUpDialogs).toEqual(['api-key']);

    readConfiguration(session).rejectKey();

    expect(readConfiguration(session)).toMatchObject({ startUpDialogs: [], keyRejected: true });
    expect(readBack('.claude.json').customApiKeyResponses).toEqual({
      rejected: [FAKE_API_KEY.slice(-20)],
      approved: [],
    });
  });

  it('writes the trust and the warning accepted where Claude Code does, and shows them no more', () => {
    writeState(agentConfiguration({ workFolder: '/elsewhere' }));
    const bypass = { ...session, permissionMode: 'bypassPermissions' };
    const configuration = readConfiguration(bypass);
    expect(configuration.startUpDialogs).toEqual(['trust-folder', 'bypass-permissions']);

    configuration.accept('trust-folder');
    configuration.accept('bypass-permissions');

    expect(readBack('.claude.json')).toMatchObject({
      projects: { '/work/project': { hasTrustDialogAccepted: true } },
    });
    expect(readBack('settings.json')).toEqual({ skipDangerousModePermissionPrompt: true });
    expect(readConfiguration(bypass).startUpDialogs).toEqual([]);
  });

  it('writes the key approved where Claude Code does, and asks no more', () => {
    writeState(agentConfiguration({ workFolder: '/work/project' }, ['key-approval']));

    readConfiguration(session).accept('api-key');

    expect(readBack('.claude.json').customApiKeyResponses).toEqual({
      approved: [FAKE_API_KEY.slice(-20)],
      rejected: [],
    });
    expect(readConfiguration(session).startUpDialogs).toEqual([]);
  });

  it("turns every hook off on the person's disableAllHooks", () => {
    writePersonsSettings({ disableAllHooks: true });

    expect(readConfiguration(session).hooksOff).toBe(true);
  });

  it.each([
    ['an onboarding to do', () => writeState({}), /onboarding/],
    [
      'no API key',
      () => {
        writeState(agentConfiguration({ workFolder: '/work/project' }));
        session = { ...session, apiKey: undefined };
      },
      /no API key/,
    ],
    [
      'the question about the key with another dialog',
      () => writeState(agentConfiguration({ workFolder: '/w' }, ['key-approval'])),
      /in which order was not observed/,
    ],
    [
      "a setting of the person's it does not play",
      () => writePersonsSettings({ sandbox: {} }),
      /"sandbox"/,
    ],
  ])('refuses %s', (_what, arrange, problem) => {
    arrange();

    expect(() => readConfiguration(session)).toThrow(problem);
  });
});

describe("the fake agent's version", () => {
  it("is the pinned agent's, or the test's", () => {
    expect(fakeAgentVersion({})).toMatch(/^\d+\.\d+\.\d+$/);
    expect(fakeAgentVersion({ [VERSION_VARIABLE]: '9.9.9' })).toBe('9.9.9');
  });

  it('is said as Claude Code says it', () => {
    expect(versionOutput('2.1.332')).toBe('2.1.332 (Claude Code)\n');
  });
});
