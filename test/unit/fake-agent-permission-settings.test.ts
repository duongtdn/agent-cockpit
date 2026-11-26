import { describe, expect, it } from 'vitest';
import { allowsEveryCallOf, parseAllowRules } from '../support/fake-agent/permission-settings.ts';

function settings(permissions: unknown): string {
  return JSON.stringify({ hooks: {}, permissions });
}

describe("the permissions of the fake agent's settings file", () => {
  it('give the rules they allow calls by, as written', () => {
    expect(parseAllowRules(settings({ allow: ['Bash', 'Read(./docs/**)'] }))).toEqual([
      'Bash',
      'Read(./docs/**)',
    ]);
  });

  it('give no rule when the file has no permissions, or permissions that allow nothing', () => {
    expect(parseAllowRules('{}')).toEqual([]);
    expect(parseAllowRules(settings({}))).toEqual([]);
  });

  it.each([
    ['settings that are no JSON', '{ "permissions": ', /settings that are no JSON/],
    ['permissions that are no object', settings(['Bash']), /permissions that are no object/],
    ['a list of denials', settings({ deny: ['Bash'] }), /the "deny" of the permissions/],
    ['a list of asks', settings({ allow: [], ask: ['Bash'] }), /the "ask" of the permissions/],
    ['a mode', settings({ defaultMode: 'plan' }), /the "defaultMode" of the permissions/],
    [
      'an allow that is no list',
      settings({ allow: 'Bash' }),
      /an "allow" that is no list of rules/,
    ],
    ['a rule that is no text', settings({ allow: [7] }), /an "allow" that is no list of rules/],
  ])('refuse %s', (_what, text, problem) => {
    expect(() => parseAllowRules(text)).toThrow(problem);
    expect(() => parseAllowRules(text)).toThrow(/^the fake agent cannot play/);
  });
});

describe('the rules a call is allowed by', () => {
  it('allow every call of a tool they name, and no call of another', () => {
    expect(allowsEveryCallOf(['Read', 'Bash'], 'Bash')).toBe(true);
    expect(allowsEveryCallOf(['Read'], 'Bash')).toBe(false);
    expect(allowsEveryCallOf(['BashOutput', 'Read(./a)'], 'Bash')).toBe(false);
  });

  it('do not tell of a tool with a rule for some of its calls only', () => {
    expect(() => allowsEveryCallOf(['Bash(sleep:*)'], 'Bash')).toThrow(
      'nothing tells whether the rule "Bash(sleep:*)" of the settings allows this call of Bash',
    );
  });
});
