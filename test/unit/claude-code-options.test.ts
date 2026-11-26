import { describe, expect, it } from 'vitest';
import { checkOptions } from '../../src/claude-code/options.ts';
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
    expect(checkOptions(undefined)).toEqual({ permissionMode: 'default', permissions: {} });
    expect(checkOptions({})).toEqual({ permissionMode: 'default', permissions: {} });
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
