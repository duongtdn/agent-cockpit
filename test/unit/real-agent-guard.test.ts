import { mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type AgentFolders,
  agentEnvironment,
  ROOT_NAME_PREFIX,
} from '../support/real-agent/environment.ts';
import { assertStaysLocal, loopbackOrigin } from '../support/real-agent/guard.ts';

const temporaryFolder = realpathSync(tmpdir());
const root = mkdtempSync(join(temporaryFolder, ROOT_NAME_PREFIX));
const elsewhere = mkdtempSync(join(temporaryFolder, 'cockpit-guard-test-'));
const folders: AgentFolders = {
  root,
  home: join(root, 'home'),
  configFolder: join(root, 'config'),
  workFolder: join(root, 'work'),
  temporaryFolder: join(root, 'tmp'),
};
const environment = agentEnvironment(folders, 'http://127.0.0.1:4010');
const settings = { hooks: {}, permissions: { allow: ['Bash'] } };

afterAll(() => {
  for (const folder of [root, elsewhere]) rmSync(folder, { recursive: true, force: true });
});

/** The guard's check of the recipe's environment with some variables changed, or removed when undefined. */
function withVariables(changes: Record<string, string | undefined>): () => void {
  const changed = Object.fromEntries(
    Object.entries({ ...environment, ...changes }).filter(([, value]) => value !== undefined),
  ) as Record<string, string>;
  return () => assertStaysLocal({ environment: changed, settings, root });
}

describe('the guard of the real agent', () => {
  it("lets the recipe's environment start, with hooks and permissions as settings", () => {
    expect(withVariables({})).not.toThrow();
    expect(withVariables({ ANTHROPIC_BASE_URL: 'http://[::1]:4010' })).not.toThrow();
  });

  it.each([
    ['no address at all', undefined],
    ['what is no address', 'not a url'],
    ["Anthropic's API", 'https://api.anthropic.com'],
    ['a name, even one that means this machine', 'http://localhost:4010'],
    ['a host that only begins like the loopback', 'http://127.0.0.1.example.com:4010'],
    ['a loopback address given as the user of another host', 'http://127.0.0.1@example.com'],
    ['a loopback address that a backslash turns into a user', 'http://127.0.0.1\\@example.com'],
    ['the same with a port', 'http://127.0.0.1:4010\\@example.com'],
    ['an address with a user', 'http://someone@127.0.0.1:4010'],
    ['an address with a password', 'http://someone:secret@127.0.0.1:4010'],
    ['an address with a path', 'http://127.0.0.1:4010/v1'],
    ['an address with no port', 'http://127.0.0.1'],
    ['an address over TLS', 'https://127.0.0.1:4010'],
    ['an address of the local network', 'http://192.168.1.10:4010'],
    ['every address of the machine', 'http://0.0.0.0:4010'],
    ['an address that is not written as its origin', 'http://127.0.0.1:4010/'],
  ])('refuses an API at %s', (_what, url) => {
    expect(withVariables({ ANTHROPIC_BASE_URL: url })).toThrow(/ANTHROPIC_BASE_URL/);
  });

  it.each(['HOME', 'CLAUDE_CONFIG_DIR', 'TMPDIR'])(
    'refuses a %s that is missing, outside the root, or the root itself',
    (name) => {
      for (const folder of [
        undefined,
        '/home/someone',
        `${root}-other/x`,
        `${root}/../x`,
        root,
        'home',
      ]) {
        expect(withVariables({ [name]: folder })).toThrow(new RegExp(name));
      }
    },
  );

  it.each([
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
  ])('refuses the proxy variable %s', (name) => {
    expect(withVariables({ [name]: 'http://proxy.example.com:8080' })).toThrow(new RegExp(name));
  });

  it.each([
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BEDROCK_BASE_URL',
    'ANTHROPIC_VERTEX_PROJECT_ID',
    'ANTHROPIC_MODEL',
  ])('refuses %s, which could send the agent to another API or with another login', (name) => {
    expect(withVariables({ [name]: '1' })).toThrow(new RegExp(name));
  });

  it('refuses any variable the recipe does not name', () => {
    expect(withVariables({ NODE_OPTIONS: '--require ./x.js' })).toThrow(/NODE_OPTIONS/);
    expect(withVariables({ anthropic_base_url: 'https://example.com' })).toThrow(
      /anthropic_base_url/,
    );
  });

  it('refuses a key that is not the fake one', () => {
    expect(withVariables({ ANTHROPIC_API_KEY: 'sk-ant-api03-a-real-key' })).toThrow(
      /ANTHROPIC_API_KEY/,
    );
    expect(withVariables({ ANTHROPIC_API_KEY: undefined })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it.each([
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL',
    'DISABLE_AUTOUPDATER',
  ])('refuses an agent without %s, which would call hosts of its own', (name) => {
    expect(withVariables({ [name]: undefined })).toThrow(new RegExp(name));
    expect(withVariables({ [name]: '0' })).toThrow(new RegExp(name));
  });
});

describe("the guard of the real agent's settings", () => {
  const check = (given: unknown) => () => assertStaysLocal({ environment, settings: given, root });

  it('refuses settings that give the agent variables: they would replace the checked ones', () => {
    expect(check({ ...settings, env: { ANTHROPIC_BASE_URL: 'https://example.com' } })).toThrow(
      /settings.*"env"/,
    );
    expect(check({ ...settings, env: {} })).toThrow(/settings.*"env"/);
  });

  it('refuses settings that name a program to get a key from', () => {
    expect(check({ ...settings, apiKeyHelper: '/usr/bin/print-my-key' })).toThrow(
      /settings.*"apiKeyHelper"/,
    );
  });

  it('refuses any setting but the hooks and the permissions', () => {
    expect(check({ ...settings, forceLoginMethod: 'claudeai' })).toThrow(
      /settings.*"forceLoginMethod"/,
    );
  });

  it.each([[null], ['{}'], [[]], [undefined]])(
    'refuses settings that are no object: %j',
    (given) => {
      expect(check(given)).toThrow(/settings/);
    },
  );
});

describe("the guard of the real agent's root", () => {
  const machine = { temporaryFolder, home: '/home/someone' };
  const check =
    (given: string, on = machine) =>
    () => {
      const inGiven = (folder: string) => folder.replace(root, given);
      const moved = {
        ...environment,
        HOME: inGiven(folders.home),
        CLAUDE_CONFIG_DIR: inGiven(folders.configFolder),
        TMPDIR: inGiven(folders.temporaryFolder),
      };
      assertStaysLocal({ environment: moved, settings, root: given }, on);
    };

  it('lets a folder start that the runner made in the temporary folder', () => {
    expect(check(root)).not.toThrow();
  });

  it('refuses the file system root and the temporary folder itself', () => {
    expect(check('/')).toThrow(/root/);
    expect(check(temporaryFolder)).toThrow(/root/);
  });

  it('refuses a folder outside the temporary folder', () => {
    expect(check(root, { temporaryFolder: elsewhere, home: '/home/someone' })).toThrow(/root/);
  });

  it("refuses the person's home and every folder above it", () => {
    const home = join(root, 'people', 'someone');
    for (const given of [root, dirname(home)]) {
      expect(check(given, { temporaryFolder: '/', home })).toThrow(/home/);
    }
    expect(check(root, { temporaryFolder, home: root })).toThrow(/home/);
  });

  it('refuses a folder of the temporary folder that the runner did not make', () => {
    expect(check(elsewhere)).toThrow(/root/);
    expect(check(join(root, 'work'))).toThrow(/root/);
    expect(check(`${root}-never-made`)).toThrow(/root/);
  });

  it('refuses what is no real folder: a file, a link to a folder, a path not resolved', () => {
    const file = join(temporaryFolder, `${ROOT_NAME_PREFIX}file-${process.pid}`);
    const link = join(temporaryFolder, `${ROOT_NAME_PREFIX}link-${process.pid}`);
    writeFileSync(file, '');
    symlinkSync(root, link);
    try {
      expect(check(file)).toThrow(/root/);
      expect(check(link)).toThrow(/root/);
      expect(check(`${root}/../${root.split('/').at(-1)}`)).toThrow(/root/);
    } finally {
      unlinkSync(file);
      unlinkSync(link);
    }
  });
});

describe('the address the real agent is given', () => {
  it('is the origin of a plain address of the loopback interface', () => {
    expect(loopbackOrigin('http://127.0.0.1:4010')).toBe('http://127.0.0.1:4010');
    expect(loopbackOrigin('http://127.0.0.1:4010/')).toBe('http://127.0.0.1:4010');
    expect(loopbackOrigin('HTTP://127.1:4010')).toBe('http://127.0.0.1:4010');
    expect(loopbackOrigin('http://[::1]:4010')).toBe('http://[::1]:4010');
  });

  it.each([
    'https://api.anthropic.com',
    'http://localhost:4010',
    'http://127.0.0.1@example.com',
    'http://127.0.0.1\\@example.com',
    'http://someone@127.0.0.1:4010',
    'http://127.0.0.1:4010/v1',
    'http://127.0.0.1:4010?x=1',
    'http://127.0.0.1:4010#x',
    'http://127.0.0.1',
    'not a url',
  ])('is refused for %s', (address) => {
    expect(() => loopbackOrigin(address)).toThrow(/ANTHROPIC_BASE_URL/);
  });
});
