import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeCode } from '../../src/claude-code/index.ts';
import { checkJobPart, checkOptions, laidOver } from '../../src/claude-code/options.ts';
import { CockpitError, isCockpitError } from '../../src/shared/cockpit-error.ts';

/** The issues `checkOptions` refuses the options with; none when it takes them. */
function issuesOf(options: unknown): unknown[] {
  try {
    checkOptions(options);
    return [];
  } catch (error) {
    if (!isCockpitError(error, 'invalid-options')) throw error;
    return [...error.issues];
  }
}

let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'cockpit-claude-code-options-'));
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe("the Claude Code driver's options", () => {
  it('launch in the default mode with no rules, model, plugin, tightening or sandbox of their own when none are given', () => {
    const none = {
      permissionMode: 'default',
      permissions: {},
      acceptOpenNetwork: false,
      model: undefined,
      pluginDir: undefined,
      settingSources: undefined,
      otherMcpServers: true,
      sandbox: undefined,
    };

    expect(checkOptions(undefined)).toStrictEqual(none);
    expect(checkOptions({})).toStrictEqual(none);
  });

  it.each(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'])(
    'take the permission mode %s',
    (mode) => {
      expect(checkOptions({ permissionMode: mode }).permissionMode).toBe(mode);
    },
  );

  it('take rules to allow, to ask and to deny, as given', () => {
    const permissions = { allow: ['Read'], ask: ['Bash(git push:*)'], deny: ['WebFetch'] };

    expect(checkOptions({ permissions }).permissions).toEqual(permissions);
  });

  it('take the acceptance of an open network, whatever the mode', () => {
    expect(checkOptions({ acceptOpenNetwork: true }).acceptOpenNetwork).toBe(true);
    expect(
      checkOptions({ permissionMode: 'bypassPermissions', acceptOpenNetwork: false })
        .acceptOpenNetwork,
    ).toBe(false);
  });

  it('refuse an acceptance of an open network that is no boolean', () => {
    expect(issuesOf({ acceptOpenNetwork: 'yes' })).toEqual([
      { path: ['acceptOpenNetwork'], message: expect.any(String) },
    ]);
  });

  it('are refused as invalid-options when they are no object', () => {
    expect(() => checkOptions('default')).toThrow(CockpitError);
    expect(issuesOf('default')).toEqual([{ path: [], message: expect.stringContaining('object') }]);
    expect(issuesOf(null)).toHaveLength(1);
    expect(issuesOf([])).toHaveLength(1);
  });

  it('refuse a mode Claude Code does not have', () => {
    expect(issuesOf({ permissionMode: 'yolo' })).toEqual([
      { path: ['permissionMode'], message: expect.stringContaining('acceptEdits') },
    ]);
  });

  it('refuse rules that are no list of rules, saying where', () => {
    expect(
      issuesOf({ permissions: { allow: 'Read', deny: ['WebFetch', 3, ''], ask: ['Edit'] } }),
    ).toEqual([
      { path: ['permissions', 'allow'], message: expect.any(String) },
      { path: ['permissions', 'deny', 1], message: expect.any(String) },
      { path: ['permissions', 'deny', 2], message: expect.any(String) },
    ]);
  });

  it('refuse permissions that are no object, or hold a list of their own', () => {
    expect(issuesOf({ permissions: ['Read'] })).toEqual([
      { path: ['permissions'], message: expect.any(String) },
    ]);
    expect(issuesOf({ permissions: { defaultMode: 'plan' } })).toEqual([
      { path: ['permissions', 'defaultMode'], message: expect.any(String) },
    ]);
  });

  it('refuse every other option rather than ignore it: an environment, a channel, a setting', () => {
    expect(issuesOf({ env: {}, mcpConfig: './mcp.json', permissionMode: 'plan' })).toEqual([
      { path: ['env'], message: expect.stringContaining('settingSources') },
      { path: ['mcpConfig'], message: expect.any(String) },
    ]);
  });

  it('take a model, as given', () => {
    expect(checkOptions({ model: 'claude-sonnet-4-5' }).model).toBe('claude-sonnet-4-5');
  });

  it.each([
    ['empty', ''],
    ['no text', 4],
  ])('refuse a model that is %s', (_, model) => {
    expect(issuesOf({ model })).toEqual([{ path: ['model'], message: expect.any(String) }]);
  });

  it('take a plugin folder, made absolute from the folder the server runs in', () => {
    const given = relative(process.cwd(), folder);

    expect(checkOptions({ pluginDir: given }).pluginDir).toBe(folder);
    expect(checkOptions({ pluginDir: folder }).pluginDir).toBe(folder);
  });

  it('refuse a plugin folder that does not exist, or is a file, naming it', () => {
    const file = join(folder, 'plugin.json');
    writeFileSync(file, '{}');
    const absent = join(folder, 'absent');

    expect(issuesOf({ pluginDir: absent })).toEqual([
      { path: ['pluginDir'], message: expect.stringContaining(absent) },
    ]);
    expect(issuesOf({ pluginDir: file })).toEqual([
      { path: ['pluginDir'], message: expect.stringContaining(file) },
    ]);
  });

  it.each([
    ['empty', ''],
    ['no text', ['./plugin']],
  ])('refuse a plugin folder whose path is %s', (_, pluginDir) => {
    expect(issuesOf({ pluginDir })).toEqual([{ path: ['pluginDir'], message: expect.any(String) }]);
  });

  it.each([[['user', 'project', 'local']], [['project']], [[]]])(
    'take the sources of settings %j, an empty list among them',
    (settingSources) => {
      expect(checkOptions({ settingSources }).settingSources).toEqual(settingSources);
    },
  );

  it('refuse sources of settings that are no list, or name a source Claude Code does not read', () => {
    expect(issuesOf({ settingSources: 'user' })).toEqual([
      { path: ['settingSources'], message: expect.any(String) },
    ]);
    expect(issuesOf({ settingSources: ['user', 'managed', 3] })).toEqual([
      { path: ['settingSources', 1], message: expect.stringContaining('project') },
      { path: ['settingSources', 2], message: expect.any(String) },
    ]);
  });

  it("take whether MCP servers other than the cockpit's load, true when left out", () => {
    expect(checkOptions({ otherMcpServers: false }).otherMcpServers).toBe(false);
    expect(checkOptions({ otherMcpServers: true }).otherMcpServers).toBe(true);
    expect(issuesOf({ otherMcpServers: 'no' })).toEqual([
      { path: ['otherMcpServers'], message: expect.any(String) },
    ]);
  });

  it('take the sandbox turned on, with no exceptions or with them', () => {
    expect(checkOptions({ sandbox: true }).sandbox).toEqual({});
    expect(
      checkOptions({
        sandbox: { excludedCommands: ['docker'], allowUnsandboxedCommands: true },
      }).sandbox,
    ).toEqual({ excludedCommands: ['docker'], allowUnsandboxedCommands: true });
    expect(checkOptions({ sandbox: {} }).sandbox).toEqual({});
  });

  it("refuse the sandbox turned off: the app may not undo the person's", () => {
    expect(issuesOf({ sandbox: false })).toEqual([
      { path: ['sandbox'], message: expect.stringContaining('only turn') },
    ]);
  });

  it('refuse a sandbox that is no object, and exceptions that do not fit, saying where', () => {
    expect(issuesOf({ sandbox: 'on' })).toEqual([
      { path: ['sandbox'], message: expect.any(String) },
    ]);
    expect(
      issuesOf({
        sandbox: {
          enabled: false,
          excludedCommands: ['docker', ''],
          allowUnsandboxedCommands: 'yes',
          network: {},
        },
      }),
    ).toEqual([
      { path: ['sandbox', 'enabled'], message: expect.stringContaining('excludedCommands') },
      { path: ['sandbox', 'network'], message: expect.any(String) },
      { path: ['sandbox', 'excludedCommands', 1], message: expect.any(String) },
      { path: ['sandbox', 'allowUnsandboxedCommands'], message: expect.any(String) },
    ]);
    expect(issuesOf({ sandbox: { excludedCommands: 'docker' } })).toEqual([
      { path: ['sandbox', 'excludedCommands'], message: expect.any(String) },
    ]);
  });
});

describe("a job's driver part laid over the app's options", () => {
  const app = checkOptions({
    permissionMode: 'acceptEdits',
    permissions: { allow: ['Read'], deny: ['WebFetch'] },
    model: 'claude-sonnet-4-5',
  });

  it("is the app's own when the job has no part", () => {
    expect(laidOver(app)).toEqual({
      permissionMode: 'acceptEdits',
      permissions: { allow: ['Read'], deny: ['WebFetch'] },
      model: 'claude-sonnet-4-5',
    });
    expect(laidOver(app, {})).toEqual(laidOver(app));
  });

  it("replaces the app's mode and model with the job's", () => {
    expect(laidOver(app, { permissionMode: 'dontAsk', model: 'claude-haiku-4-5' })).toMatchObject({
      permissionMode: 'dontAsk',
      model: 'claude-haiku-4-5',
    });
  });

  it("adds the job's rules after the app's, list by list: the app's deny and ask rules hold", () => {
    expect(
      laidOver(app, { permissions: { ask: ['Bash(git push:*)'], deny: ['Edit'] } }).permissions,
    ).toEqual({ allow: ['Read'], ask: ['Bash(git push:*)'], deny: ['WebFetch', 'Edit'] });
  });

  it("names no model when neither the job nor the app does: the person's default applies", () => {
    expect(laidOver(checkOptions({}), { permissionMode: 'plan' }).model).toBeUndefined();
  });
});

describe("a job's driver part for Claude Code", () => {
  it('takes a permission mode, rules and a model, each left out or given', () => {
    const part = {
      permissionMode: 'acceptEdits',
      permissions: { deny: ['Bash(git push:*)'] },
      model: 'sonnet',
    };

    expect(checkJobPart(part)).toEqual([]);
    expect(checkJobPart({})).toEqual([]);
  });

  it('refuses what a job may not set, saying where: the app keeps the plugin, the environment, the acceptance', () => {
    expect(
      checkJobPart({
        permissionMode: 'yolo',
        permissions: { allow: 'Read' },
        model: '',
        pluginDir: './plugin',
        acceptOpenNetwork: true,
      }),
    ).toEqual([
      { path: ['pluginDir'], message: expect.stringContaining('model') },
      { path: ['acceptOpenNetwork'], message: expect.any(String) },
      { path: ['permissionMode'], message: expect.any(String) },
      { path: ['permissions', 'allow'], message: expect.any(String) },
      { path: ['model'], message: expect.any(String) },
    ]);
  });

  it.each([
    ['a text', 'acceptEdits'],
    ['null', null],
    ['a list', []],
    ['nothing', undefined],
  ])('refuses %s, which is no part', (_, part) => {
    expect(checkJobPart(part)).toEqual([{ path: [], message: expect.stringContaining('object') }]);
  });

  it('refuses a model that is no text', () => {
    expect(checkJobPart({ model: 3 })).toEqual([{ path: ['model'], message: expect.any(String) }]);
  });

  it('is checked by the driver as by its factory', () => {
    expect(claudeCode().checkPart({ model: 3 })).toEqual(checkJobPart({ model: 3 }));
  });

  it('is built by claudeCode.job, as given, once it fits', () => {
    const part = { permissionMode: 'plan', permissions: { ask: ['Edit'] }, model: 'opus' } as const;

    expect(claudeCode.job(part)).toEqual(part);
  });

  it('is refused by claudeCode.job as invalid-options, with every issue, when it does not fit', () => {
    let thrown: unknown;
    try {
      claudeCode.job({ permissionMode: 'yolo' } as never);
    } catch (error) {
      thrown = error;
    }

    expect(isCockpitError(thrown, 'invalid-options')).toBe(true);
    expect(thrown).toMatchObject({ issues: [{ path: ['permissionMode'] }] });
  });
});
