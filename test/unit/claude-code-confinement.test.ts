import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
const HOME = '/home/someone';

/**
 * The denies that keep the agent's tools from every file a project or a
 * folder holds that starts code at the next launch: its settings, its MCP
 * servers, its hooks' scripts, its agents and skills (whose frontmatter
 * may hold hooks).
 */
const START_UP_FILE_DENIES = [
  'Edit(//**/.claude/settings.json)',
  'Edit(//**/.claude/settings.local.json)',
  'Edit(//**/.mcp.json)',
  'Edit(//**/.claude/hooks/**)',
  'Edit(//**/.claude/agents/**)',
  'Edit(//**/.claude/skills/**)',
];

/**
 * The person's own files that start code at the next launch, in the
 * configuration folder and the home: settings, the legacy configuration
 * file, a configuration file under any name, plugins, agents and skills.
 */
function personsDenies(config = CONFIG, home = HOME): string[] {
  return [
    `Edit(/${config}/settings.json)`,
    `Edit(/${config}/.config.json)`,
    `Edit(/${config}/.claude*.json)`,
    `Edit(/${home}/.claude*.json)`,
    `Edit(/${config}/plugins/**)`,
    `Edit(/${config}/agents/**)`,
    `Edit(/${config}/skills/**)`,
  ];
}

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
    environment: { PATH: '/usr/bin:/bin', HOME, CLAUDE_CONFIG_DIR: configFolder },
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
        ...START_UP_FILE_DENIES,
        ...personsDenies(),
      ],
    });
  });
});

describe("Claude Code's files that start code at the next launch, in the settings of a launch", () => {
  it("are denied to Edit wherever a project or a folder holds them (settings, MCP servers, hooks, agents, skills), and the person's own (settings, the configuration files of each folder under any name, plugins, agents, skills), after the state roots", async () => {
    const { permissions } = await settingsOf(confinementOf());

    expect(permissions.deny).toEqual([
      `Read(/${DEFAULT_ROOT}/**)`,
      `Edit(/${DEFAULT_ROOT}/**)`,
      ...START_UP_FILE_DENIES,
      ...personsDenies(),
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

    for (const config of [linked, real]) {
      expect(permissions.deny).toEqual(
        expect.arrayContaining([
          `Edit(/${config}/settings.json)`,
          `Edit(/${config}/.config.json)`,
          `Edit(/${config}/.claude*.json)`,
          `Edit(/${config}/plugins/**)`,
          `Edit(/${config}/agents/**)`,
          `Edit(/${config}/skills/**)`,
        ]),
      );
    }
  });

  it('deny the file a linked configuration file of any name leads to, in the configuration folder and the home', async () => {
    const folder = realpathSync(files);
    const config = join(folder, 'config');
    const home = join(folder, 'home');
    mkdirSync(config);
    mkdirSync(home);
    const dotfiles = join(folder, 'dotfiles');
    mkdirSync(dotfiles);
    for (const [linkedFrom, name] of [
      [config, '.claude-custom-oauth.json'],
      [config, '.config.json'],
      [home, '.claude.json'],
    ] as const) {
      const dotfile = join(dotfiles, `${linkedFrom === home ? 'home' : 'config'}${name}`);
      writeFileSync(dotfile, '{}');
      symlinkSync(dotfile, join(linkedFrom, name));
    }
    const launch = launchOf(confinementOf(), config);

    const { args } = await claudeCode().launch({
      ...launch,
      environment: { ...launch.environment, HOME: home },
    });
    const { permissions }: Settings = JSON.parse(
      readFileSync(args[args.indexOf('--settings') + 1] as string, 'utf8'),
    );

    expect(permissions.deny).toEqual(
      expect.arrayContaining([
        `Edit(/${dotfiles}/config.claude-custom-oauth.json)`,
        `Edit(/${dotfiles}/config.config.json)`,
        `Edit(/${dotfiles}/home.claude.json)`,
      ]),
    );
  });

  it("deny the person's configuration files of any name in the home by the path given and the real one", async () => {
    const folder = realpathSync(files);
    const real = join(folder, 'real-home');
    mkdirSync(real);
    const linked = join(folder, 'linked-home');
    symlinkSync(real, linked);
    const launch = launchOf(confinementOf());

    const { args } = await claudeCode().launch({
      ...launch,
      environment: { ...launch.environment, HOME: linked },
    });
    const { permissions }: Settings = JSON.parse(
      readFileSync(args[args.indexOf('--settings') + 1] as string, 'utf8'),
    );

    expect(permissions.deny).toContain(`Edit(/${linked}/.claude*.json)`);
    expect(permissions.deny).toContain(`Edit(/${real}/.claude*.json)`);
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

      expect(permissions.deny).toEqual(
        expect.arrayContaining([...START_UP_FILE_DENIES, ...personsDenies()]),
      );
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

describe('a configuration folder its denies could miss', () => {
  async function refusalWith(configFolder: string): Promise<unknown> {
    return claudeCode()
      .launch(launchOf(confinementOf(), configFolder))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
  }

  it.each([
    ['relative', 'config/claude'],
    ['holding a pattern', '/home/someone/.config/claude*'],
    ["holding a rule's bracket", '/home/someone/(claude)'],
    ['holding a control character', '/home/someone/claude\tconfig'],
  ])(
    'is refused at a launch when %s: invalid-options, nothing written',
    async (_, configFolder) => {
      const refusal = await refusalWith(configFolder);

      expect(refusal).toMatchObject({
        code: 'invalid-options',
        issues: [{ path: [], message: expect.stringContaining('CLAUDE_CONFIG_DIR') }],
      });
      expect(readdirSync(files)).toEqual([]);
    },
  );

  it('is refused when its real path holds rule syntax, a link to it named plainly', async () => {
    const folder = realpathSync(files);
    const real = join(folder, 'config[1]');
    mkdirSync(real);
    const linked = join(folder, 'config');
    symlinkSync(real, linked);

    expect(await refusalWith(linked)).toMatchObject({ code: 'invalid-options' });
  });

  it.each([
    ['holds rule syntax', '/home/some*one', 'HOME gives the folder "/home/some*one", which holds'],
    ['is relative', 'home/someone', 'HOME gives "home/someone", a relative folder'],
  ])(
    'is refused, once, for a home that %s when no configuration folder is named: the default one is under it',
    async (_, home, why) => {
      const launch = launchOf(confinementOf());

      const refusal = await claudeCode()
        .launch({ ...launch, environment: { PATH: '/usr/bin:/bin', HOME: home } })
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(refusal).toMatchObject({
        code: 'invalid-options',
        issues: [{ path: [], message: expect.stringContaining(why) }],
      });
    },
  );

  it("is refused when no configuration folder is named and the home's .claude leads to rule syntax", async () => {
    const folder = realpathSync(files);
    const real = join(folder, 'config[1]');
    mkdirSync(real);
    symlinkSync(real, join(folder, '.claude'));

    expect(await claudeCode().environmentIssues({ HOME: folder })).toEqual([
      {
        path: [],
        message: expect.stringContaining(
          `The default configuration folder, .claude in HOME, is the folder ${JSON.stringify(join(folder, '.claude'))}, whose real path ${JSON.stringify(real)} holds`,
        ),
      },
    ]);
  });

  it('lets a plain absolute folder pass, and tells createCockpit the same issues', async () => {
    const driver = claudeCode();

    expect(await driver.environmentIssues({ CLAUDE_CONFIG_DIR: CONFIG, HOME })).toEqual([]);
    expect(await driver.environmentIssues({ CLAUDE_CONFIG_DIR: 'config', HOME })).toEqual([
      { path: [], message: expect.stringContaining('CLAUDE_CONFIG_DIR') },
    ]);
  });
});
