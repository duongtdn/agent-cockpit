import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  type AgentFolders,
  agentEnvironment,
  ROOT_NAME_PREFIX,
  TERMINAL_VARIABLES,
} from '../support/real-agent/environment.ts';
import { type AgentLaunch, assertStaysLocal, loopbackOrigin } from '../support/real-agent/guard.ts';

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
for (const folder of Object.values(folders)) mkdirSync(folder, { recursive: true });
const environment = agentEnvironment(folders, 'http://127.0.0.1:4010');
const settings = { hooks: {}, permissions: { allow: ['Bash'] } };
const managedSettingsFolder = join(elsewhere, 'managed');
const machine = {
  temporaryFolder,
  home: '/home/someone',
  managedSettingsFolders: [managedSettingsFolder],
};
const SESSION = ['--session-id', '0c9a3d4e-0000-4000-8000-000000000000'];
/** What a test made inside the root or the managed folder, removed after it. */
const made: string[] = [];

afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});

afterAll(() => {
  for (const folder of [root, elsewhere]) rmSync(folder, { recursive: true, force: true });
});

function argsWith(given: unknown): string[] {
  return [...SESSION, '--settings', JSON.stringify(given), '--permission-mode', 'default'];
}

/** The guard's check of a launch that would pass, with some of it changed. */
function check(changes: Partial<AgentLaunch> = {}): () => void {
  const launch = { environment, args: argsWith(settings), workFolder: folders.workFolder, root };
  return () => assertStaysLocal({ ...launch, ...changes }, machine);
}

/** The guard's check of the recipe's environment with some variables changed, or removed when undefined. */
function withVariables(changes: Record<string, string | undefined>): () => void {
  const changed = Object.fromEntries(
    Object.entries({ ...environment, ...changes }).filter(([, value]) => value !== undefined),
  ) as Record<string, string>;
  return check({ environment: changed });
}

/** Makes a folder and those above it that are missing; what it made goes with the test. */
function makeFolder(path: string): void {
  const firstMade = mkdirSync(path, { recursive: true });
  if (firstMade !== undefined) made.push(firstMade);
}

function writeFile(path: string, content: string): string {
  makeFolder(dirname(path));
  writeFileSync(path, content);
  made.push(path);
  return path;
}

/** Makes what a folder variable must not be, each inside the root by its path's text. */
function notRealFolders(): Record<string, string> {
  const paths = {
    'a folder that does not exist': join(root, 'never-made'),
    'a file': writeFile(join(root, 'a-file'), ''),
    'a link to a folder outside the root': join(root, 'link-out'),
    'a link to a folder inside the root': join(root, 'link-in'),
    'a folder behind a link': join(root, 'link-in', 'below'),
  };
  makeFolder(join(folders.home, 'below'));
  symlinkSync(elsewhere, paths['a link to a folder outside the root']);
  symlinkSync(folders.home, paths['a link to a folder inside the root']);
  made.push(...Object.values(paths));
  return paths;
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

  it.each(['HOME', 'CLAUDE_CONFIG_DIR', 'TMPDIR'])(
    'refuses a %s that is no real folder, whatever its path says',
    (name) => {
      for (const [what, path] of Object.entries(notRealFolders())) {
        expect(withVariables({ [name]: path }), what).toThrow(
          new RegExp(`${name} is not a real folder inside`),
        );
      }
    },
  );

  it('refuses a work folder that is outside the root, no real folder, or a link that leads out of it', () => {
    const { 'a link to a folder inside the root': _linkIn, ...others } = notRealFolders();
    for (const path of [elsewhere, root, ...Object.values(others)]) {
      expect(check({ workFolder: path }), path).toThrow(
        /the work folder .* is (not a real folder|a link that leads to no real folder)/,
      );
    }
  });

  it('lets a work folder start that is a link inside the root to a real folder inside it', () => {
    const link = join(root, 'linked-work');
    symlinkSync(folders.workFolder, link);
    made.push(link);

    expect(check({ workFolder: link })).not.toThrow();
  });

  it('refuses a link to a work folder whose settings, above the folder it leads to, send the agent elsewhere', () => {
    const below = join(folders.home, 'project');
    makeFolder(below);
    writeFile(
      join(folders.home, '.claude', 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://example.com' } }),
    );
    const link = join(root, 'linked-project');
    symlinkSync(below, link);
    made.push(link);

    expect(check({ workFolder: link })).toThrow(join(folders.home, '.claude', 'settings.json'));
  });

  it('refuses a link inside the root that leads nowhere, or out of it', () => {
    const nowhere = join(root, 'link-to-nowhere');
    symlinkSync(join(root, 'never-made'), nowhere);
    made.push(nowhere);

    expect(check({ workFolder: nowhere })).toThrow(/a link that leads to no real folder/);
  });

  it.each([
    ['the work folder', folders.workFolder],
    ['a folder above it', root],
  ])(
    'refuses a work folder in a git worktree, whose .git in %s is a file: the agent would read the settings of a repository elsewhere',
    (_where, folder) => {
      writeFile(
        join(folder, '.git'),
        `gitdir: ${join(elsewhere, 'repository', '.git', 'worktrees', 'work')}\n`,
      );

      expect(check()).toThrow(/the work folder .* is in a git worktree/);
      expect(check()).toThrow(join(folder, '.git'));
    },
  );

  it('refuses a work folder whose .git is a link: where it leads is not what was checked', () => {
    const marker = join(folders.workFolder, '.git');
    symlinkSync(elsewhere, marker);
    made.push(marker);

    expect(check()).toThrow(/is in a git worktree/);
  });

  it('lets a work folder start that is a git repository of its own: its .git is a folder', () => {
    makeFolder(join(folders.workFolder, '.git'));

    expect(check()).not.toThrow();
  });

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
    expect(withVariables({ constructor: 'x' })).toThrow(/constructor/);
  });

  it.each(TERMINAL_VARIABLES)(
    'refuses %s from a launch: the terminal gives it, whatever a launch says',
    (name) => {
      expect(withVariables({ [name]: 'x' })).toThrow(new RegExp(`${name} is the terminal's`));
    },
  );

  it('lets a launch set how often a failed request is tried again, as a number only', () => {
    expect(withVariables({ CLAUDE_CODE_MAX_RETRIES: '0' })).not.toThrow();
    expect(withVariables({ CLAUDE_CODE_MAX_RETRIES: '1; curl' })).toThrow(
      /CLAUDE_CODE_MAX_RETRIES/,
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
  const withSettings = (given: unknown) => check({ args: argsWith(given) });

  it('refuses settings that give the agent a variable its rule refuses, or one with no rule', () => {
    expect(
      withSettings({ ...settings, env: { ANTHROPIC_BASE_URL: 'https://example.com' } }),
    ).toThrow(/settings.*"env", the variable ANTHROPIC_BASE_URL, not the origin/);
    expect(withSettings({ ...settings, env: { HTTPS_PROXY: 'http://127.0.0.1:1' } })).toThrow(
      /settings.*"env", the variable HTTPS_PROXY, which has no rule a launch may give/,
    );
    expect(withSettings({ ...settings, env: { TERM: 'xterm' } })).toThrow(
      /the variable TERM, which has no rule a launch may give/,
    );
    expect(withSettings({ ...settings, env: { CLAUDE_CODE_MAX_RETRIES: 3 } })).toThrow(
      /the variable CLAUDE_CODE_MAX_RETRIES, which is no text/,
    );
    expect(withSettings({ ...settings, env: [] })).toThrow(/variables that are no object/);
  });

  it.each([
    ['HOME', folders.home],
    ['CLAUDE_CONFIG_DIR', folders.configFolder],
    ['TMPDIR', folders.temporaryFolder],
  ])(
    'refuses settings that set %s, even to the launch’s own folder: the guard checked the files under the launch’s',
    (name, folder) => {
      const another = join(root, `another-${name}`);
      mkdirSync(another);
      made.push(another);

      for (const value of [another, folder]) {
        expect(withSettings({ ...settings, env: { [name]: value } })).toThrow(
          new RegExp(`settings.*"env", the variable ${name}, .*the folders whose files`),
        );
      }
    },
  );

  it('lets settings give the agent variables that pass the rules a launch passes', () => {
    expect(
      withSettings({
        ...settings,
        env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4011', CLAUDE_CODE_MAX_RETRIES: '3' },
      }),
    ).not.toThrow();
    expect(withSettings({ ...settings, env: {} })).not.toThrow();
  });

  it('lets settings turn every hook off, and nothing else of that setting', () => {
    expect(withSettings({ ...settings, disableAllHooks: true })).not.toThrow();
    expect(withSettings({ ...settings, disableAllHooks: false })).toThrow(
      /"disableAllHooks", not true/,
    );
  });

  it('refuses settings that name a program to get a key from', () => {
    expect(withSettings({ ...settings, apiKeyHelper: '/usr/bin/print-my-key' })).toThrow(
      /settings.*"apiKeyHelper"/,
    );
  });

  it("lets the sandbox's lines pass, which only narrow what a sandboxed command reaches", () => {
    const sandbox = {
      network: {
        deniedDomains: ['localhost:8765', '[::1]:8765', '172.28.119.214:8765'],
        allowedDomains: ['127.0.0.1:4100'],
      },
      allowUnsandboxedCommands: false,
    };

    expect(withSettings({ ...settings, sandbox })).not.toThrow();
  });

  it('lets the sandbox be turned on, failing where it cannot run: both only narrow', () => {
    const sandbox = { enabled: true, failIfUnavailable: true };

    expect(withSettings({ ...settings, sandbox })).not.toThrow();
  });

  it.each([
    ['no object', true, /"sandbox", no object/],
    ['commands let out of it', { allowUnsandboxedCommands: true }, /let out of the sandbox/],
    ['turned off', { enabled: false }, /"sandbox".*"enabled" other than true/],
    ['turned on by a text', { enabled: 'true' }, /"sandbox".*"enabled" other than true/],
    [
      'commands run unconfined where it cannot run',
      { enabled: true, failIfUnavailable: false },
      /"sandbox".*"failIfUnavailable" other than true/,
    ],
    [
      'commands run without an ask in it',
      { enabled: true, autoAllowBashIfSandboxed: true },
      /"sandbox".*"autoAllowBashIfSandboxed" has no rule/,
    ],
    [
      'a domain allowed off 127.0.0.1',
      { network: { allowedDomains: ['example.com'] } },
      /"example\.com", off 127\.0\.0\.1/,
    ],
    ['localhost allowed', { network: { allowedDomains: ['localhost:4100'] } }, /"localhost:4100"/],
    ['another network line', { network: { httpProxyPort: 8080 } }, /"httpProxyPort"/],
    ['denied domains that are no list', { network: { deniedDomains: 'x' } }, /denied domains/],
  ])('refuses a sandbox with %s', (_what, sandbox, problem) => {
    expect(withSettings({ ...settings, sandbox })).toThrow(problem);
  });

  it("lets the person's acceptance of bypassPermissions' warning pass: the launch's mode is checked apart", () => {
    expect(withSettings({ ...settings, skipDangerousModePermissionPrompt: true })).not.toThrow();
    expect(withSettings({ ...settings, skipDangerousModePermissionPrompt: 'yes' })).toThrow(
      /"skipDangerousModePermissionPrompt", not true/,
    );
  });

  it("lets WebFetch's domain lookup be turned off, never on: it would call Anthropic itself", () => {
    expect(withSettings({ ...settings, skipWebFetchPreflight: true })).not.toThrow();
    expect(withSettings({ ...settings, skipWebFetchPreflight: false })).toThrow(
      /"skipWebFetchPreflight", not true/,
    );
  });

  it('refuses a setting that has no rule, and says where a rule is added', () => {
    expect(withSettings({ ...settings, forceLoginMethod: 'claudeai' })).toThrow(
      /settings.*"forceLoginMethod".*SETTINGS_RULES.*launch-rules\.ts/,
    );
    for (const name of ['toString', 'valueOf', 'constructor', '__proto__']) {
      const given = JSON.parse(`{ "${name}": {} }`);
      expect(withSettings(given), name).toThrow(/has no rule in SETTINGS_RULES/);
    }
  });

  it.each([[null], ['{}'], [[]]])('refuses settings that are no object: %j', (given) => {
    expect(withSettings(given)).toThrow(/settings/);
  });

  it('lets hooks pass that run a command or post to the loopback interface', () => {
    const hooks = {
      Stop: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'http',
              url: 'http://127.0.0.1:4011/http/Stop',
              headers: { Authorization: 'x' },
            },
            { type: 'command', command: 'report Stop' },
          ],
        },
      ],
    };

    expect(withSettings({ hooks })).not.toThrow();
  });

  it.each([
    [
      'an http hook to another host',
      { type: 'http', url: 'https://example.com/hook' },
      /off the loopback/,
    ],
    [
      'an http hook to a name',
      { type: 'http', url: 'http://localhost:4011/hook' },
      /off the loopback/,
    ],
    ['an http hook with no address', { type: 'http' }, /off the loopback/],
    [
      'a hook that asks a model',
      { type: 'prompt', prompt: 'Is it done?' },
      /a hook of type "prompt"/,
    ],
  ])('refuses %s', (_what, hook, problem) => {
    expect(withSettings({ hooks: { Stop: [{ hooks: [hook] }] } })).toThrow(/settings.*"hooks"/);
    expect(withSettings({ hooks: { Stop: [{ hooks: [hook] }] } })).toThrow(problem);
  });

  it.each([[[]], ['x'], [{ Stop: 'x' }], [{ Stop: [{ hooks: 'x' }] }], [{ Stop: [null] }]])(
    'refuses hooks that are not groups of hooks by event: %j',
    (hooks) => {
      expect(withSettings({ hooks })).toThrow(/settings.*"hooks"/);
    },
  );

  it.each([[null], ['x'], [7], [[]]])('refuses a hook that is no object: %j', (hook) => {
    expect(withSettings({ hooks: { Stop: [{ hooks: [hook] }] } })).toThrow(
      /The real agent is not started: .*settings.*"hooks", a hook that is no object/,
    );
  });
});

describe("the guard of the real agent's arguments", () => {
  it('lets a launch pass with a new or a resumed session, a mode, a model and a prompt', () => {
    const options = [...argsWith(settings), '--model', 'haiku'];

    expect(check({ args: [...options, '--', 'the prompt'] })).not.toThrow();
    expect(check({ args: ['--resume', SESSION[1] as string, '--', '--mcp-config'] })).not.toThrow();
  });

  it.each(['--session-id', '--resume'])(
    'refuses %s with anything but a UUID: the agent would read another value as an option',
    (option) => {
      for (const value of ['--mcp-config=/x.json', '-p', 'latest', `${SESSION[1]} `, '']) {
        expect(check({ args: [option, value] }), value).toThrow(
          new RegExp(`${option} is not a UUID`),
        );
      }
      expect(check({ args: [option, (SESSION[1] as string).toUpperCase()] })).not.toThrow();
    },
  );

  it('refuses settings given as a file that can be written: it could change after its check', () => {
    const file = writeFile(join(root, 'settings.json'), JSON.stringify(settings));

    expect(check({ args: [...SESSION, '--settings', file] })).toThrow(
      /settings of --settings.*can be written: it could change after its check/,
    );
  });

  it('lets settings pass that are a file nobody can write inside the root, under the rules of its settings', () => {
    const file = writeFile(join(root, 'state', 'settings.json'), JSON.stringify(settings));
    chmodSync(file, 0o400);
    const sendingElsewhere = writeFile(
      join(root, 'state', 'elsewhere.json'),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } }),
    );
    chmodSync(sendingElsewhere, 0o400);

    expect(check({ args: [...SESSION, '--settings', file] })).not.toThrow();
    expect(check({ args: [...SESSION, '--settings', sendingElsewhere] })).toThrow(
      /settings of --settings: they carry "env"/,
    );
  });

  it('refuses a settings file outside the root, or a link to one inside it: what it holds was not checked', () => {
    const outside = writeFile(join(elsewhere, 'settings.json'), JSON.stringify(settings));
    chmodSync(outside, 0o400);
    const link = join(root, 'linked-settings.json');
    symlinkSync(outside, link);
    made.push(link);

    for (const file of [outside, link]) {
      expect(check({ args: [...SESSION, '--settings', file] }), file).toThrow(
        /settings of --settings.*no real file inside/,
      );
    }
  });

  it('refuses settings that are neither JSON nor a path, and a file that is no JSON', () => {
    const notJson = writeFile(join(root, 'not-json.json'), 'not json');
    chmodSync(notJson, 0o400);

    expect(check({ args: [...SESSION, '--settings', 'settings.json'] })).toThrow(
      /settings of --settings.*neither written out as JSON nor a file nobody can write/,
    );
    expect(check({ args: [...SESSION, '--settings', notJson] })).toThrow(
      /settings of --settings: they cannot be read as JSON/,
    );
  });

  it('refuses --mcp-config, which no launch needs yet, and says where a rule is added', () => {
    expect(check({ args: [...SESSION, '--mcp-config', 'x'] })).toThrow(
      /--mcp-config is refused.*OPTION_RULES.*launch-rules\.ts/,
    );
  });

  it('lets --setting-sources name the sources of settings, or none', () => {
    for (const sources of ['', 'user', 'user,project,local']) {
      expect(check({ args: [...SESSION, '--setting-sources', sources] }), sources).not.toThrow();
    }
    expect(check({ args: [...SESSION, '--setting-sources', 'user,policy'] })).toThrow(
      /--setting-sources is naming policy, no source of settings/,
    );
  });

  it('lets --strict-mcp-config pass as a flag, the option after it read as one', () => {
    expect(
      check({ args: [...SESSION, '--strict-mcp-config', '--permission-mode', 'default'] }),
    ).not.toThrow();
    expect(check({ args: [...SESSION, '--strict-mcp-config', '--mcp-config', 'x'] })).toThrow(
      /--mcp-config is refused/,
    );
  });

  describe('--plugin-dir', () => {
    const plugin = join(root, 'plugin');
    const withPlugin = (folder = plugin) => check({ args: [...SESSION, '--plugin-dir', folder] });
    const manifest = (content: object) =>
      writeFile(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify(content));

    it('lets a plugin of commands pass, its manifest naming it', () => {
      manifest({ name: 'probe', description: 'Commands.', version: '1.0.0' });
      writeFile(join(plugin, 'commands', 'greet.md'), 'Say hello.');

      expect(withPlugin()).not.toThrow();
    });

    it('refuses a plugin with anything but commands: hooks, servers, agents', () => {
      manifest({ name: 'probe' });
      for (const stray of ['hooks/hooks.json', '.mcp.json', 'agents/helper.md']) {
        const path = writeFile(join(plugin, stray), '{}');
        expect(withPlugin(), stray).toThrow(/a plugin holding .*only commands have a rule/);
        unlinkSync(path);
      }
    });

    it('refuses a manifest that says more than who the plugin is, or no JSON', () => {
      manifest({ name: 'probe', mcpServers: {} });
      expect(withPlugin()).toThrow(/a plugin whose manifest says "mcpServers"/);
      writeFile(join(plugin, '.claude-plugin', 'plugin.json'), '{');
      expect(withPlugin()).toThrow(/a plugin whose manifest cannot be read as JSON/);
    });

    it('refuses a plugin outside the root', () => {
      expect(withPlugin(elsewhere)).toThrow(/--plugin-dir is not a real folder inside/);
    });
  });

  it('refuses an argument that has no rule, and says where a rule is added', () => {
    for (const argument of [
      '--dangerously-skip-permissions',
      '--settings={}',
      '-p',
      'a word',
      'constructor',
      '__proto__',
    ]) {
      expect(check({ args: [...SESSION, argument] }), argument).toThrow(
        /has no rule in OPTION_RULES.*launch-rules\.ts/,
      );
    }
  });

  it('refuses an option without its value, and more than one prompt', () => {
    expect(check({ args: [...SESSION, '--model'] })).toThrow(/--model has no value/);
    expect(check({ args: [...SESSION, '--', 'one', 'two'] })).toThrow(/more than one prompt/);
  });
});

describe('the guard of the settings files the real agent reads', () => {
  const elsewhereSettings = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://example.com' } });
  const places: [string, string][] = [
    ["the user's settings", join(folders.configFolder, 'settings.json')],
    [
      "an organization's settings the agent kept",
      join(folders.configFolder, 'remote-settings.json'),
    ],
    ["the project's settings", join(folders.workFolder, '.claude', 'settings.json')],
    ["the project's local settings", join(folders.workFolder, '.claude', 'settings.local.json')],
    ['the settings of a folder above the work folder', join(root, '.claude', 'settings.json')],
    ['the local settings of a folder above it', join(root, '.claude', 'settings.local.json')],
    ["the machine's managed settings", join(managedSettingsFolder, 'managed-settings.json')],
    ['a drop-in of them', join(managedSettingsFolder, 'managed-settings.d', '10-more.json')],
  ];

  it.each(places)('refuses %s when they would send the agent elsewhere', (_what, path) => {
    writeFile(path, elsewhereSettings);

    expect(check()).toThrow(/settings.*"env"/);
    expect(check()).toThrow(path);
  });

  it.each(places)(
    'lets %s pass when every one of them has a rule that allows it',
    (_what, path) => {
      writeFile(path, JSON.stringify(settings));

      expect(check()).not.toThrow();
    },
  );

  it.each(places)('refuses %s when they cannot be read as JSON', (_what, path) => {
    writeFile(path, '{ "env": ');

    expect(check()).toThrow(/cannot be read as JSON/);
  });

  it("refuses MCP servers configured in the machine's managed settings folder, whatever they are: an organization's", () => {
    const path = writeFile(join(managedSettingsFolder, 'managed-mcp.json'), '{"mcpServers":{}}');

    expect(check()).toThrow(/MCP servers.*an organization's/);
    expect(check()).toThrow(path);
  });

  /** A server the agent starts as a program of the test's, as it runs a command hook. */
  const LOCAL_SERVER = { command: '/bin/sh', args: ['-c', 'touch a-mark'] };
  const mcpServerPlaces: [string, string, (servers: object) => object][] = [
    [
      "the work folder's .mcp.json",
      join(folders.workFolder, '.mcp.json'),
      (servers) => ({ mcpServers: servers }),
    ],
    ["a folder above's .mcp.json", join(root, '.mcp.json'), (servers) => ({ mcpServers: servers })],
    [
      "the configuration folder's .claude.json",
      join(folders.configFolder, '.claude.json'),
      (servers) => ({ hasCompletedOnboarding: true, mcpServers: servers }),
    ],
    [
      "a project's in the configuration folder's .claude.json",
      join(folders.configFolder, '.claude.json'),
      (servers) => ({ projects: { [folders.workFolder]: { mcpServers: servers } } }),
    ],
    [
      "the home's .claude.json",
      join(folders.home, '.claude.json'),
      (servers) => ({ mcpServers: servers }),
    ],
  ];

  it.each(mcpServerPlaces)(
    'lets MCP servers of %s pass when each is a program the agent starts, as a command hook',
    (_where, path, holding) => {
      writeFile(
        path,
        JSON.stringify(holding({ probe: LOCAL_SERVER, typed: { type: 'stdio', ...LOCAL_SERVER } })),
      );

      expect(check()).not.toThrow();
    },
  );

  it.each(mcpServerPlaces)(
    'refuses MCP servers of %s reached by an address, or saying more than their program',
    (_where, path, holding) => {
      for (const server of [
        { type: 'http', url: 'https://example.com/mcp' },
        { type: 'sse', url: 'http://127.0.0.1:1/sse' },
        { ...LOCAL_SERVER, env: { HTTPS_PROXY: 'http://example.com' } },
        { args: ['no', 'command'] },
      ]) {
        writeFile(path, JSON.stringify(holding({ remote: server })));
        expect(check(), JSON.stringify(server)).toThrow(/the MCP server "remote"/);
        expect(check()).toThrow(path);
      }
    },
  );

  it.each([join(folders.workFolder, '.mcp.json'), join(folders.configFolder, '.claude.json')])(
    'refuses %s when it cannot be read as JSON',
    (path) => {
      writeFile(path, '{ "mcpServers": ');

      expect(check()).toThrow(/cannot be read as JSON/);
    },
  );

  describe("the person's plugins", () => {
    const plugins = join(folders.configFolder, 'plugins');
    const market = join(plugins, 'marketplaces', 'local');
    const installed = join(plugins, 'cache', 'local', 'probe', '1.0.0');
    const hooks = (command: unknown) => ({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command }] }] },
    });

    function install(): void {
      writeFile(
        join(plugins, 'known_marketplaces.json'),
        JSON.stringify({
          local: { source: { source: 'directory', path: market }, installLocation: market },
        }),
      );
      writeFile(
        join(market, '.claude-plugin', 'marketplace.json'),
        JSON.stringify({ name: 'local', plugins: [{ name: 'probe', source: './probe' }] }),
      );
      for (const folder of [join(market, 'probe'), installed]) {
        writeFile(join(folder, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'probe' }));
        writeFile(join(folder, 'commands', 'greet.md'), 'Say hello.');
        writeFile(join(folder, 'hooks', 'hooks.json'), JSON.stringify(hooks('touch a-mark')));
      }
      writeFile(
        join(plugins, 'installed_plugins.json'),
        JSON.stringify({
          version: 2,
          plugins: { 'probe@local': [{ scope: 'user', installPath: installed }] },
        }),
      );
    }

    it('let a plugin installed from a folder of the run pass, with commands and hooks that stay local, enabled in settings', () => {
      install();

      expect(
        check({ args: argsWith({ ...settings, enabledPlugins: { 'probe@local': true } }) }),
      ).not.toThrow();
    });

    it('refuse a plugin whose hooks leave the loopback, or that holds anything but commands and hooks', () => {
      install();
      writeFile(
        join(installed, 'hooks', 'hooks.json'),
        JSON.stringify({
          hooks: { Stop: [{ hooks: [{ type: 'http', url: 'https://example.com/hook' }] }] },
        }),
      );
      expect(check()).toThrow(/plugin.*an http hook to "https:\/\/example.com\/hook"/);

      writeFile(join(installed, 'hooks', 'hooks.json'), JSON.stringify(hooks('touch a-mark')));
      writeFile(join(installed, '.mcp.json'), '{}');
      expect(check()).toThrow(/a plugin holding .mcp.json/);
    });

    it('refuse a marketplace that is not a folder of the run: the agent would fetch it', () => {
      install();
      writeFile(
        join(plugins, 'known_marketplaces.json'),
        JSON.stringify({ remote: { source: { source: 'github', repo: 'someone/plugins' } } }),
      );

      expect(check()).toThrow(/the marketplace "remote"/);
    });

    it('refuse settings that enable plugins with anything but true or false', () => {
      expect(
        check({ args: argsWith({ ...settings, enabledPlugins: { 'probe@local': 'yes' } }) }),
      ).toThrow(/"enabledPlugins"/);
    });
  });

  it('refuses a settings file that is a link to nowhere: what it will hold is not known', () => {
    const path = join(folders.workFolder, '.claude', 'settings.json');
    makeFolder(dirname(path));
    symlinkSync(join(elsewhere, 'not-there-yet.json'), path);
    made.push(path);

    expect(check()).toThrow(/cannot be read as JSON/);
  });
});

describe("the guard of the real agent's root", () => {
  const checkRoot =
    (given: string, on: { temporaryFolder: string; home: string } = machine) =>
    () => {
      const inGiven = (folder: string) => folder.replace(root, given);
      const moved = {
        ...environment,
        HOME: inGiven(folders.home),
        CLAUDE_CONFIG_DIR: inGiven(folders.configFolder),
        TMPDIR: inGiven(folders.temporaryFolder),
      };
      assertStaysLocal(
        {
          environment: moved,
          args: argsWith(settings),
          workFolder: inGiven(folders.workFolder),
          root: given,
        },
        { ...on, managedSettingsFolders: [] },
      );
    };

  it('lets a folder start that the runner made in the temporary folder', () => {
    expect(checkRoot(root)).not.toThrow();
  });

  it('refuses the file system root and the temporary folder itself', () => {
    expect(checkRoot('/')).toThrow(/root/);
    expect(checkRoot(temporaryFolder)).toThrow(/root/);
  });

  it('refuses a folder outside the temporary folder', () => {
    expect(checkRoot(root, { temporaryFolder: elsewhere, home: '/home/someone' })).toThrow(/root/);
  });

  it("refuses the person's home and every folder above it", () => {
    const home = join(root, 'people', 'someone');
    for (const given of [root, dirname(home)]) {
      expect(checkRoot(given, { temporaryFolder: '/', home })).toThrow(/home/);
    }
    expect(checkRoot(root, { temporaryFolder, home: root })).toThrow(/home/);
  });

  it('refuses a folder of the temporary folder that the runner did not make', () => {
    expect(checkRoot(elsewhere)).toThrow(/root/);
    expect(checkRoot(join(root, 'work'))).toThrow(/root/);
    expect(checkRoot(`${root}-never-made`)).toThrow(/root/);
  });

  it('refuses what is no real folder: a file, a link to a folder, a path not resolved', () => {
    const file = join(temporaryFolder, `${ROOT_NAME_PREFIX}file-${process.pid}`);
    const link = join(temporaryFolder, `${ROOT_NAME_PREFIX}link-${process.pid}`);
    writeFileSync(file, '');
    symlinkSync(root, link);
    try {
      expect(checkRoot(file)).toThrow(/root/);
      expect(checkRoot(link)).toThrow(/root/);
      expect(checkRoot(`${root}/../${root.split('/').at(-1)}`)).toThrow(/root/);
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
