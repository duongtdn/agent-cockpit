import { describe, expect, it } from 'vitest';
import { claudeCode } from '../../src/claude-code/index.ts';
import { checkJobPart, checkOptions } from '../../src/claude-code/options.ts';
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

describe("the Claude Code driver's options", () => {
  it('launch in the default mode with no rules of their own when none are given', () => {
    const none = { permissionMode: 'default', permissions: {}, acceptOpenNetwork: false };

    expect(checkOptions(undefined)).toEqual(none);
    expect(checkOptions({})).toEqual(none);
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

  it('refuse every other option rather than ignore it: a model, a plugin, a tightening', () => {
    expect(issuesOf({ model: 'sonnet', pluginDir: './plugin', permissionMode: 'plan' })).toEqual([
      { path: ['model'], message: expect.any(String) },
      { path: ['pluginDir'], message: expect.any(String) },
    ]);
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
