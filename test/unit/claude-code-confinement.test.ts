import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeCode } from '../../src/claude-code/index.ts';
import { confinementReader } from '../../src/server/confinement.ts';
import type { Confinement, Launch } from '../../src/server/driver.ts';

const DEFAULT_ROOT = '/home/someone/.local/state/agent-cockpit';
const APP_ROOT = '/srv/app/cockpit-state';
const CONFIG = '/home/someone/.config/claude';

/** The denies that keep the agent's tools from every settings file a project or a folder holds. */
const SETTINGS_FILE_DENIES = [
  'Edit(//**/.claude/settings.json)',
  'Edit(//**/.claude/settings.local.json)',
];

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

function launchOf(confinement: Confinement, configFolder = CONFIG): Launch {
  return {
    key: 'chapter-1',
    conversationId: '6f1c2f0e-3b1a-4c66-9d57-0a4b8a3e5c11',
    directory: '/work/app',
    files,
    hooks: { url: 'http://127.0.0.1:4100', token: 'token-of-the-launch' },
    environment: { PATH: '/usr/bin:/bin', CLAUDE_CONFIG_DIR: configFolder },
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

async function settingsOf(
  confinement: Confinement,
  driver = claudeCode(),
  configFolder = CONFIG,
): Promise<Settings> {
  const { args } = await driver.launch(launchOf(confinement, configFolder));
  return JSON.parse(readFileSync(args[args.indexOf('--settings') + 1] as string, 'utf8'));
}

describe('the state roots in the settings of a launch', () => {
  it('are denied to Read and to Edit, each root by its absolute path', async () => {
    const { permissions } = await settingsOf(
      confinementOf({ stateRoots: [DEFAULT_ROOT, APP_ROOT] }),
    );

    expect(permissions.deny.slice(0, 4)).toEqual([
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
      deny: [
        'WebFetch',
        `Read(/${DEFAULT_ROOT}/**)`,
        `Edit(/${DEFAULT_ROOT}/**)`,
        ...SETTINGS_FILE_DENIES,
        `Edit(/${CONFIG}/settings.json)`,
      ],
    });
  });
});

describe("Claude Code's settings files in the settings of a launch", () => {
  it("are denied to Edit wherever a project or a folder holds them, and the person's own, after the state roots", async () => {
    const { permissions } = await settingsOf(confinementOf());

    expect(permissions.deny).toEqual([
      `Read(/${DEFAULT_ROOT}/**)`,
      `Edit(/${DEFAULT_ROOT}/**)`,
      ...SETTINGS_FILE_DENIES,
      `Edit(/${CONFIG}/settings.json)`,
    ]);
  });

  it("deny the person's settings in .claude of the home folder when no configuration folder is named", async () => {
    const launch = launchOf(confinementOf());
    const { args } = await claudeCode().launch({
      ...launch,
      environment: { PATH: '/usr/bin:/bin' },
    });
    const { permissions }: Settings = JSON.parse(
      readFileSync(args[args.indexOf('--settings') + 1] as string, 'utf8'),
    );

    expect(permissions.deny).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Edit\(\/\/.+\/\.claude\/settings\.json\)$/)]),
    );
  });

  it("deny the person's settings by the path given and the real one, when a link leads to the folder", async () => {
    const folder = realpathSync(files);
    const real = join(folder, 'real-config');
    mkdirSync(real);
    const linked = join(folder, 'linked-config');
    symlinkSync(real, linked);

    const { permissions } = await settingsOf(confinementOf(), claudeCode(), linked);

    expect(permissions.deny).toContain(`Edit(/${linked}/settings.json)`);
    expect(permissions.deny).toContain(`Edit(/${real}/settings.json)`);
  });

  it("deny the file a linked settings file leads to, as the person's dotfiles do", async () => {
    const folder = realpathSync(files);
    const config = join(folder, 'config');
    mkdirSync(config);
    const dotfile = join(folder, 'dotfiles-claude-settings.json');
    writeFileSync(dotfile, '{}');
    symlinkSync(dotfile, join(config, 'settings.json'));

    const { permissions } = await settingsOf(confinementOf(), claudeCode(), config);

    expect(permissions.deny).toContain(`Edit(/${config}/settings.json)`);
    expect(permissions.deny).toContain(`Edit(/${dotfile})`);
  });

  it.each(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'] as const)(
    'are denied in %s, whatever the app allows',
    async (permissionMode) => {
      const { permissions } = await settingsOf(
        confinementOf(),
        claudeCode({
          permissionMode,
          acceptOpenNetwork: true,
          permissions: { allow: ['Edit', 'Write', 'Edit(//**/.claude/settings.json)'] },
        }),
      );

      expect(permissions.deny).toEqual(expect.arrayContaining(SETTINGS_FILE_DENIES));
      expect(permissions.deny).toContain(`Edit(/${CONFIG}/settings.json)`);
    },
  );
});

describe('the sandbox lines in the settings of a launch', () => {
  it("deny every address of the app's it is given, and nothing of its own", async () => {
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
    ]);
  });

  it('deny every loopback name the core gives, among them [::]', async () => {
    const confinement = await confinementReader({
      stateRoots: [],
      appPorts: () => [8765],
      listener: { host: '127.0.0.1', port: 4100 },
    })();

    const { sandbox } = await settingsOf(confinement);

    expect(sandbox.network.deniedDomains).toEqual(
      expect.arrayContaining([
        'localhost:8765',
        '127.0.0.1:8765',
        '0.0.0.0:8765',
        '[::1]:8765',
        '[::]:8765',
      ]),
    );
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
