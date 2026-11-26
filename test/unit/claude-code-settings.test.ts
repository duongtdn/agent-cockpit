import { describe, expect, it } from 'vitest';
import { type SettingsParts, settingsDocument } from '../../src/claude-code/settings-document.ts';

const PARTS: SettingsParts = {
  hookUrl: 'http://127.0.0.1:4100/hooks',
  token: 'token-of-the-launch',
  sessionStartCommand: "'/usr/bin/node' '/hook.js' '/files/hook-address.json'",
  permissions: { allow: ['Read'], deny: ['WebFetch'] },
  confinement: {
    stateRoots: ['/state'],
    appAddresses: [{ host: '127.0.0.1', port: 8765 }],
    listener: { host: '127.0.0.1', port: 4100 },
  },
  personsFiles: ['/config/settings.json', '/config/.config.json', '/dotfiles/claude.json'],
  configurationFileFolders: ['/config', '/home/a'],
  personsFolders: ['/config/plugins', '/config/agents', '/config/skills'],
};

interface Document {
  permissions: { allow?: string[]; ask?: string[]; deny: string[] };
  sandbox: Record<string, unknown>;
}

function documentOf(parts: Partial<SettingsParts> = {}): Document {
  return settingsDocument({ ...PARTS, ...parts }) as Document;
}

describe("the channel's allow rule", () => {
  it('is written after the rules allowed, when the session has a channel', () => {
    expect(documentOf({ channelServer: 'curator' }).permissions.allow).toEqual([
      'Read',
      'mcp__curator',
    ]);
  });

  it('makes the allow list of its own when no rule is allowed', () => {
    expect(documentOf({ permissions: {}, channelServer: 'curator' }).permissions.allow).toEqual([
      'mcp__curator',
    ]);
  });

  it('is not written without a channel', () => {
    expect(documentOf().permissions.allow).toEqual(['Read']);
    expect(documentOf({ permissions: {} }).permissions).not.toHaveProperty('allow');
    expect(JSON.stringify(documentOf())).not.toContain('mcp__');
  });
});

describe('the sandbox section', () => {
  const lines = {
    network: { deniedDomains: ['127.0.0.1:8765'], allowedDomains: ['127.0.0.1:4100'] },
    allowUnsandboxedCommands: false,
  };

  it("is the cockpit's lines alone when the app does not ask for the sandbox: the person decides", () => {
    expect(documentOf().sandbox).toEqual(lines);
  });

  it('turns the sandbox on and fails where it cannot run, beside the lines, when the app asks for it', () => {
    expect(documentOf({ sandbox: {} }).sandbox).toEqual({
      enabled: true,
      failIfUnavailable: true,
      ...lines,
    });
  });

  it("carries the app's exceptions: the commands it excludes, and letting a refused command out", () => {
    expect(
      documentOf({
        sandbox: { excludedCommands: ['docker', 'git push'], allowUnsandboxedCommands: true },
      }).sandbox,
    ).toEqual({
      enabled: true,
      failIfUnavailable: true,
      excludedCommands: ['docker', 'git push'],
      network: lines.network,
      allowUnsandboxedCommands: true,
    });
  });

  it('keeps every command in the sandbox when the app says nothing of it', () => {
    expect(
      documentOf({ sandbox: { excludedCommands: ['docker'] } }).sandbox.allowUnsandboxedCommands,
    ).toBe(false);
    expect(documentOf({ sandbox: { allowUnsandboxedCommands: false } }).sandbox).not.toHaveProperty(
      'excludedCommands',
    );
  });
});

describe('the deny rules', () => {
  it("are the app's, the state roots', every project's start-up files', and the person's files', configuration files' and folders', in that order", () => {
    expect(documentOf().permissions.deny).toEqual([
      'WebFetch',
      'Read(//state/**)',
      'Edit(//state/**)',
      'Edit(//**/.claude/settings.json)',
      'Edit(//**/.claude/settings.local.json)',
      'Edit(//**/.mcp.json)',
      'Edit(//**/.claude/hooks/**)',
      'Edit(//**/.claude/agents/**)',
      'Edit(//**/.claude/skills/**)',
      'Edit(//config/settings.json)',
      'Edit(//config/.config.json)',
      'Edit(//dotfiles/claude.json)',
      'Edit(//config/.claude*.json)',
      'Edit(//home/a/.claude*.json)',
      'Edit(//config/plugins/**)',
      'Edit(//config/agents/**)',
      'Edit(//config/skills/**)',
    ]);
  });

  it("deny the person's files and folders by every path given", () => {
    expect(
      documentOf({
        personsFiles: ['/home/a/.claude/settings.json', '/dotfiles/c.json'],
        configurationFileFolders: ['/home/a/', '/dotfiles/home'],
        personsFolders: ['/home/a/.claude/plugins/', '/dotfiles/plugins'],
      }).permissions.deny,
    ).toEqual(
      expect.arrayContaining([
        'Edit(//home/a/.claude/settings.json)',
        'Edit(//dotfiles/c.json)',
        'Edit(//home/a/.claude*.json)',
        'Edit(//dotfiles/home/.claude*.json)',
        'Edit(//home/a/.claude/plugins/**)',
        'Edit(//dotfiles/plugins/**)',
      ]),
    );
  });
});

describe('what the settings never hold', () => {
  it.each([
    ['without the sandbox', {}],
    ['with it', { sandbox: { excludedCommands: ['docker'] } }],
    ['with a channel', { channelServer: 'curator' }],
  ])('%s: only hooks, permissions and the sandbox, no env', (_, parts) => {
    const document = documentOf(parts);

    expect(Object.keys(document).sort()).toEqual(['hooks', 'permissions', 'sandbox']);
  });
});
