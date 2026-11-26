import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeCode } from '../../src/claude-code/index.ts';
import { confinementReader } from '../../src/server/confinement.ts';
import type { Confinement, Launch } from '../../src/server/driver.ts';

const DEFAULT_ROOT = '/home/someone/.local/state/agent-cockpit';
const APP_ROOT = '/srv/app/cockpit-state';

let files: string;

beforeEach(() => {
  files = mkdtempSync(join(tmpdir(), 'cockpit-claude-code-confinement-'));
});

afterEach(() => {
  rmSync(files, { recursive: true, force: true });
});

function confinementOf(overrides: Partial<Confinement> = {}): Confinement {
  return {
    stateRoots: [DEFAULT_ROOT],
    appAddresses: [
      { host: 'localhost', port: 8765 },
      { host: '0.0.0.0', port: 8765 },
      { host: '127.0.0.1', port: 8765 },
    ],
    listener: { host: '127.0.0.1', port: 4100 },
    ...overrides,
  };
}

function launchOf(confinement: Confinement): Launch {
  return {
    key: 'chapter-1',
    conversationId: '6f1c2f0e-3b1a-4c66-9d57-0a4b8a3e5c11',
    directory: '/work/app',
    files,
    hooks: { url: 'http://127.0.0.1:4100', token: 'token-of-the-launch' },
    environment: { PATH: '/usr/bin:/bin' },
    confinement,
  };
}

interface Settings {
  permissions: { allow?: string[]; ask?: string[]; deny: string[] };
  sandbox: {
    network: { deniedDomains: string[]; allowedDomains: string[] };
    allowUnsandboxedCommands: boolean;
  };
}

async function settingsOf(confinement: Confinement, driver = claudeCode()): Promise<Settings> {
  const { args } = await driver.launch(launchOf(confinement));
  return JSON.parse(readFileSync(args[args.indexOf('--settings') + 1] as string, 'utf8'));
}

describe('the state roots in the settings of a launch', () => {
  it('are denied to Read and to Edit, each root by its absolute path', async () => {
    const { permissions } = await settingsOf(
      confinementOf({ stateRoots: [DEFAULT_ROOT, APP_ROOT] }),
    );

    expect(permissions.deny).toEqual([
      `Read(/${DEFAULT_ROOT}/**)`,
      `Edit(/${DEFAULT_ROOT}/**)`,
      `Read(/${APP_ROOT}/**)`,
      `Edit(/${APP_ROOT}/**)`,
    ]);
  });

  it('are denied by the path given and by the real one, when a link leads to the root', async () => {
    const folder = realpathSync(files);
    const real = join(folder, 'real-state');
    mkdirSync(real);
    const linked = join(folder, 'linked-state');
    symlinkSync(real, linked);
    const confinement = await confinementReader({
      stateRoots: [linked],
      appPorts: () => [8765],
      listener: { host: '127.0.0.1', port: 4100 },
    })();

    const { permissions } = await settingsOf(confinement);

    for (const root of [linked, real]) {
      expect(permissions.deny).toContain(`Read(/${root}/**)`);
      expect(permissions.deny).toContain(`Edit(/${root}/**)`);
    }
  });

  it("follow the app's own rules, which stay as the app wrote them", async () => {
    const permissions = { allow: ['Read'], ask: ['Bash(git push:*)'], deny: ['WebFetch'] };

    const settings = await settingsOf(confinementOf(), claudeCode({ permissions }));

    expect(settings.permissions).toEqual({
      allow: ['Read'],
      ask: ['Bash(git push:*)'],
      deny: ['WebFetch', `Read(/${DEFAULT_ROOT}/**)`, `Edit(/${DEFAULT_ROOT}/**)`],
    });
  });
});

describe('the sandbox lines in the settings of a launch', () => {
  it("deny every address of the app's, and every loopback name, on each of the app's ports", async () => {
    const { sandbox } = await settingsOf(
      confinementOf({
        appAddresses: [
          { host: 'localhost', port: 8765 },
          { host: '172.28.119.214', port: 8765 },
          { host: 'localhost', port: 8443 },
          { host: '172.28.119.214', port: 8443 },
        ],
      }),
    );

    expect(sandbox.network.deniedDomains).toEqual([
      'localhost:8765',
      '172.28.119.214:8765',
      'localhost:8443',
      '172.28.119.214:8443',
      '127.0.0.1:8765',
      '0.0.0.0:8765',
      '[::1]:8765',
      '[::]:8765',
      '127.0.0.1:8443',
      '0.0.0.0:8443',
      '[::1]:8443',
      '[::]:8443',
    ]);
  });

  it('write an IPv6 address in brackets before its port', async () => {
    const { sandbox } = await settingsOf(
      confinementOf({
        appAddresses: [
          { host: '::1', port: 8765 },
          { host: 'fe80::215:5dff:fe51:c5a9', port: 8765 },
          { host: '2001:db8::7', port: 8765 },
        ],
      }),
    );

    expect(sandbox.network.deniedDomains).toEqual(
      expect.arrayContaining([
        '[::1]:8765',
        '[fe80::215:5dff:fe51:c5a9]:8765',
        '[2001:db8::7]:8765',
      ]),
    );
    expect(sandbox.network.deniedDomains.filter((domain) => domain === '[::1]:8765')).toHaveLength(
      1,
    );
  });

  it('allow the listener alone, on 127.0.0.1', async () => {
    const { sandbox } = await settingsOf(
      confinementOf({ listener: { host: '127.0.0.1', port: 4321 } }),
    );

    expect(sandbox.network.allowedDomains).toEqual(['127.0.0.1:4321']);
  });

  it('keep every command in the sandbox, and leave turning the sandbox on to the person', async () => {
    const { sandbox } = await settingsOf(confinementOf());

    expect(sandbox.allowUnsandboxedCommands).toBe(false);
    expect(Object.keys(sandbox).sort()).toEqual(['allowUnsandboxedCommands', 'network']);
    expect(Object.keys(sandbox.network).sort()).toEqual(['allowedDomains', 'deniedDomains']);
  });

  it.each(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'] as const)(
    'are written in %s too',
    async (permissionMode) => {
      const settings = await settingsOf(
        confinementOf(),
        claudeCode({ permissionMode, acceptOpenNetwork: true }),
      );

      expect(settings.sandbox.network.deniedDomains).toContain('127.0.0.1:8765');
      expect(settings.permissions.deny).toContain(`Edit(/${DEFAULT_ROOT}/**)`);
    },
  );
});
