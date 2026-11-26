import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentConfigFolder } from '../../src/claude-code/conversations.ts';
import { claudeCode } from '../../src/claude-code/index.ts';
import { shellWord } from '../../src/claude-code/launching.ts';
import type { Launch } from '../../src/server/driver.ts';
import { isCockpitError } from '../../src/shared/cockpit-error.ts';

const TOKEN = 'k3Xq9-token-of-the-launch_0123456789abcdefABCDEF';
const CONVERSATION = '6f1c2f0e-3b1a-4c66-9d57-0a4b8a3e5c11';

let files: string;

beforeEach(() => {
  files = mkdtempSync(join(tmpdir(), 'cockpit-claude-code-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(files, { recursive: true, force: true });
});

function launchOf(overrides: Partial<Launch> = {}): Launch {
  return {
    key: 'chapter-1',
    conversationId: CONVERSATION,
    directory: '/work/app',
    files,
    hooks: { url: 'http://127.0.0.1:4100', token: TOKEN },
    prompt: 'Explain a.ts',
    environment: { PATH: '/usr/bin:/bin', HOME: '/home/someone', LANG: 'C.UTF-8' },
    confinement: {
      stateRoots: ['/home/someone/.local/state/agent-cockpit'],
      appAddresses: [{ host: '127.0.0.1', port: 8765 }],
      listener: { host: '127.0.0.1', port: 4100 },
    },
    ...overrides,
  };
}

interface Settings {
  hooks: Record<string, { matcher?: string; hooks: Record<string, unknown>[] }[]>;
  permissions?: object;
}

function settingsOf(args: readonly string[]): Settings {
  const file = args[args.indexOf('--settings') + 1] as string;
  return JSON.parse(readFileSync(file, 'utf8'));
}

describe('a launch of Claude Code', () => {
  it('runs claude with the conversation, the settings and the mode, then the prompt after --', async () => {
    const command = await claudeCode({ permissionMode: 'acceptEdits' }).launch(launchOf());

    expect(command.command).toBe('claude');
    expect(command.args).toEqual([
      '--session-id',
      CONVERSATION,
      '--settings',
      join(files, 'settings.json'),
      '--permission-mode',
      'acceptEdits',
      '--',
      'Explain a.ts',
    ]);
  });

  it('resumes the conversation by its id, rather than start one, when the launch resumes', async () => {
    const { args } = await claudeCode().launch(launchOf({ resume: true }));

    expect(args.slice(0, 2)).toEqual(['--resume', CONVERSATION]);
    expect(args).not.toContain('--session-id');
  });

  it('passes the default mode when the app names none', async () => {
    const { args } = await claudeCode().launch(launchOf());

    expect(args.slice(4, 6)).toEqual(['--permission-mode', 'default']);
  });

  it('keeps a prompt that looks like options as the one word after --', async () => {
    const prompt = '--model opus -- /exit\nand more';
    const { args } = await claudeCode().launch(launchOf({ prompt }));

    expect(args.slice(-2)).toEqual(['--', prompt]);
  });

  it('gives no -- and no prompt to a session that waits for one', async () => {
    const { prompt: _, ...withoutPrompt } = launchOf();
    const { args } = await claudeCode().launch(withoutPrompt);

    expect(args).not.toContain('--');
    expect(args).toHaveLength(6);
  });

  it("removes Claude Code's own variables from the environment, and keeps the rest", async () => {
    const environment = {
      PATH: '/usr/bin',
      CLAUDE_CONFIG_DIR: '/config',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SSE_PORT: '4242',
      ANTHROPIC_MODEL: 'sonnet',
      MY_CLAUDECODE_NOTE: 'kept',
    };

    const command = await claudeCode().launch(launchOf({ environment }));

    expect(command.environment).toEqual({
      PATH: '/usr/bin',
      CLAUDE_CONFIG_DIR: '/config',
      ANTHROPIC_MODEL: 'sonnet',
      MY_CLAUDECODE_NOTE: 'kept',
    });
  });

  it('puts the token on no command line and in no variable', async () => {
    const command = await claudeCode().launch(launchOf());

    expect(JSON.stringify([command.command, command.args, command.environment])).not.toContain(
      TOKEN,
    );
    expect(settingsOf(command.args).hooks.SessionStart?.[0]?.hooks[0]?.command).not.toContain(
      TOKEN,
    );
  });

  it('writes its files in the session folder, readable by the app user alone', async () => {
    await claudeCode().launch(launchOf());

    expect(readdirSync(files).sort()).toEqual(['hook-address.json', 'settings.json']);
    for (const file of readdirSync(files)) {
      expect(statSync(join(files, file)).mode & 0o777).toBe(0o600);
    }
  });

  it('writes the files anew at every launch, with the new token', async () => {
    const driver = claudeCode();
    await driver.launch(launchOf());
    const { args } = await driver.launch(
      launchOf({ hooks: { url: 'http://127.0.0.1:4100', token: 'second' } }),
    );

    expect(readdirSync(files).sort()).toEqual(['hook-address.json', 'settings.json']);
    expect(JSON.stringify(settingsOf(args))).toContain('Bearer second');
    expect(JSON.stringify(settingsOf(args))).not.toContain(TOKEN);
  });
});

describe('the settings of a launch', () => {
  it('post UserPromptSubmit, PreToolUse, PostToolUse, Stop and SessionEnd to the hooks path, with the token', async () => {
    const { args } = await claudeCode().launch(launchOf());
    const { hooks } = settingsOf(args);
    const httpHook = {
      type: 'http',
      url: 'http://127.0.0.1:4100/hooks',
      headers: { Authorization: `Bearer ${TOKEN}` },
    };

    expect(Object.keys(hooks).sort()).toEqual(
      [
        'PostToolUse',
        'PreToolUse',
        'SessionEnd',
        'SessionStart',
        'Stop',
        'UserPromptSubmit',
      ].sort(),
    );
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']) {
      expect(hooks[event]).toEqual([{ hooks: [httpHook] }]);
    }
  });

  it('post under a hook address given with a trailing slash too', async () => {
    const { args } = await claudeCode().launch(
      launchOf({ hooks: { url: 'http://127.0.0.1:4100/agent/', token: TOKEN } }),
    );

    expect(settingsOf(args).hooks.Stop?.[0]?.hooks[0]?.url).toBe(
      'http://127.0.0.1:4100/agent/hooks',
    );
  });

  it('run SessionStart as a command: this Node, the hook program, the address file', async () => {
    const { args } = await claudeCode().launch(launchOf());
    const [group] = settingsOf(args).hooks.SessionStart ?? [];
    const command = group?.hooks[0]?.command as string;
    const words = execFileSync('/bin/sh', ['-c', `printf '%s\\n' ${command}`], { encoding: 'utf8' })
      .trimEnd()
      .split('\n');

    expect(group?.hooks).toEqual([{ type: 'command', command }]);
    expect(words).toEqual([
      process.execPath,
      expect.stringMatching(/claude-code\/session-start-hook\.ts$/),
      join(files, 'hook-address.json'),
    ]);
    expect(JSON.parse(readFileSync(words[2] as string, 'utf8'))).toEqual({
      url: 'http://127.0.0.1:4100/hooks',
      token: TOKEN,
    });
  });

  it("carry the app's permission rules, the confinement's denies after them", async () => {
    const permissions = { allow: ['Read'], deny: ['WebFetch'] };

    expect(
      settingsOf((await claudeCode({ permissions }).launch(launchOf())).args).permissions,
    ).toEqual({
      allow: ['Read'],
      deny: [
        'WebFetch',
        'Read(//home/someone/.local/state/agent-cockpit/**)',
        'Edit(//home/someone/.local/state/agent-cockpit/**)',
      ],
    });
  });
});

describe('shell words', () => {
  it.each(['/plain/path', "/it's here/a b", "''", '$HOME `x` "y" \\z'])(
    'keep %j as it is',
    (word) => {
      const printed = execFileSync('/bin/sh', ['-c', `printf '%s' ${shellWord(word)}`], {
        encoding: 'utf8',
      });

      expect(printed).toBe(word);
    },
  );
});

describe("the driver's other parts", () => {
  it('refuses options that do not fit, as invalid-options', () => {
    let refusal: unknown;
    try {
      claudeCode({ model: 'sonnet' } as never);
    } catch (error) {
      refusal = error;
    }

    expect(isCockpitError(refusal, 'invalid-options')).toBe(true);
  });

  it('sends ESC CR for Shift+Enter, its one terminal key', () => {
    expect(claudeCode().terminalKeys).toEqual([
      { key: 'Enter', modifiers: ['shift'], send: '\x1b\r' },
    ]);
  });

  it('says why a silent start cannot be observed in terms of its hooks', () => {
    expect(claudeCode().silentStartCause).toMatch(/SessionStart hook/);
  });

  it.each(['default', 'acceptEdits', 'dontAsk'] as const)(
    'keeps the network of a session in %s to the allow-list: it asks or refuses beyond it (contract 80, 81)',
    (permissionMode) => {
      expect(claudeCode({ permissionMode }).networkOf()).toEqual({ reach: 'confined' });
      expect(claudeCode({ permissionMode, acceptOpenNetwork: true }).networkOf()).toEqual({
        reach: 'confined',
      });
    },
  );

  it('keeps the network of a session in the default mode to the allow-list', () => {
    expect(claudeCode().networkOf()).toEqual({ reach: 'confined' });
  });

  it.each(['plan', 'auto', 'bypassPermissions'] as const)(
    'counts the network of a session in %s as open, naming the mode, accepted only when the app says so',
    (permissionMode) => {
      const refused = claudeCode({ permissionMode }).networkOf();
      const accepted = claudeCode({ permissionMode, acceptOpenNetwork: true }).networkOf();

      expect(refused).toEqual({
        reach: 'open',
        accepted: false,
        reason: expect.stringContaining(permissionMode),
      });
      expect(refused).toMatchObject({ reason: expect.stringContaining('acceptOpenNetwork') });
      expect(accepted).toEqual({ ...refused, accepted: true });
    },
  );

  it.each(['plan', 'auto'] as const)(
    'says what was measured of a session in %s: a command that names a host in allowed_domains reaches it once approved, with no ask of the network (contract 82)',
    (permissionMode) => {
      const { reason } = claudeCode({ permissionMode }).networkOf() as { reason: string };

      expect(reason).toMatch(/allowed_domains/);
      expect(reason).toMatch(/measured|seen/);
      expect(reason).not.toMatch(/not known/);
    },
  );
});

describe("the network of a session that runs a job's driver part", () => {
  it("is the part's mode's, which replaces the app's", () => {
    const confined = claudeCode({ permissionMode: 'bypassPermissions' });
    const open = claudeCode();

    expect(confined.networkOf({ permissionMode: 'default' })).toEqual({ reach: 'confined' });
    expect(open.networkOf({ permissionMode: 'bypassPermissions' })).toEqual(
      claudeCode({ permissionMode: 'bypassPermissions' }).networkOf(),
    );
  });

  it("is the app's mode's when the part sets none, the app's acceptance holding", () => {
    const accepted = claudeCode({ permissionMode: 'auto', acceptOpenNetwork: true });

    expect(accepted.networkOf({ model: 'sonnet' })).toEqual(accepted.networkOf());
    expect(accepted.networkOf({ permissionMode: 'plan' })).toMatchObject({
      reach: 'open',
      accepted: true,
    });
  });
});

describe('whether a conversation can resume', () => {
  it('is whether its transcript exists, in any project folder of the configuration folder', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', files);
    const project = join(files, 'projects', '-elsewhere-app');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'not-a-folder.jsonl'), '');
    const driver = claudeCode();

    expect(await driver.canResume({ conversationId: CONVERSATION, directory: '/work/app' })).toBe(
      false,
    );
    writeFileSync(join(project, `${CONVERSATION}.jsonl`), '{}\n');
    expect(await driver.canResume({ conversationId: CONVERSATION, directory: '/work/app' })).toBe(
      true,
    );
  });

  it('is false when the agent keeps no conversation at all', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(files, 'never-ran'));

    expect(await claudeCode().canResume({ conversationId: CONVERSATION, directory: '/w' })).toBe(
      false,
    );
  });

  it('fails when the configuration folder cannot be read', async () => {
    writeFileSync(join(files, 'projects'), '');
    vi.stubEnv('CLAUDE_CONFIG_DIR', files);

    await expect(
      claudeCode().canResume({ conversationId: CONVERSATION, directory: '/w' }),
    ).rejects.toThrow(/ENOTDIR/);
  });

  it("is looked up in CLAUDE_CONFIG_DIR, else in .claude of the user's home", () => {
    expect(agentConfigFolder({ CLAUDE_CONFIG_DIR: '/config' })).toBe('/config');
    expect(agentConfigFolder({ CLAUDE_CONFIG_DIR: '' })).toBe(join(homedir(), '.claude'));
    expect(agentConfigFolder({})).toBe(join(homedir(), '.claude'));
  });
});
