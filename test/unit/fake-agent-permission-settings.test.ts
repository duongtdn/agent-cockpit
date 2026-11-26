import { describe, expect, it } from 'vitest';
import {
  allowsEveryCallOf,
  deniedPathNamedBy,
  parsePermissions,
} from '../support/fake-agent/permission-settings.ts';

function settings(permissions: unknown): string {
  return JSON.stringify({ hooks: {}, permissions });
}

describe("the permissions of the fake agent's settings file", () => {
  it('give the rules they allow calls by, as written', () => {
    expect(parsePermissions(settings({ allow: ['Bash', 'Read(./docs/**)'] }))).toEqual({
      allowRules: ['Bash', 'Read(./docs/**)'],
      deniedPaths: [],
    });
  });

  it('give the folders they deny to Read and Edit, each once', () => {
    const deny = ['Read(//state/root/**)', 'Edit(//state/root/**)', 'Read(//linked/root/**)'];

    expect(parsePermissions(settings({ deny })).deniedPaths).toEqual([
      '/state/root',
      '/linked/root',
    ]);
  });

  it('give the settings files they deny to Edit, by absolute path or wherever they lie, after the folders', () => {
    const deny = [
      'Edit(//**/.claude/settings.json)',
      'Read(//state/root/**)',
      'Edit(//**/.claude/settings.local.json)',
      'Edit(//config/settings.json)',
    ];

    expect(parsePermissions(settings({ deny })).deniedPaths).toEqual([
      '.claude/settings.json',
      '/state/root',
      '.claude/settings.local.json',
      '/config/settings.json',
    ]);
  });

  it('give no rule when the file has no permissions, or permissions that allow nothing', () => {
    const none = { allowRules: [], deniedPaths: [] };

    expect(parsePermissions('{}')).toEqual(none);
    expect(parsePermissions(settings({}))).toEqual(none);
  });

  it.each([
    ['settings that are no JSON', '{ "permissions": ', /settings that are no JSON/],
    ['permissions that are no object', settings(['Bash']), /permissions that are no object/],
    ['a denial of a tool', settings({ deny: ['Bash'] }), /the deny rule "Bash"/],
    [
      'a denial of a file to Read',
      settings({ deny: ['Read(//config/settings.json)'] }),
      /the deny rule "Read\(\/\/config\/settings\.json\)"/,
    ],
    [
      'a denial to Edit by a pattern other than a path under every folder',
      settings({ deny: ['Edit(//config/*.json)'] }),
      /the deny rule "Edit\(\/\/config\/\*\.json\)"/,
    ],
    [
      'a denial of a folder by a relative path',
      settings({ deny: ['Read(./secrets/**)'] }),
      /the deny rule "Read\(\.\/secrets\/\*\*\)"/,
    ],
    ['a deny that is no list', settings({ deny: 'Bash' }), /a "deny" that is no list of rules/],
    ['a list of asks', settings({ allow: [], ask: ['Bash'] }), /the "ask" of the permissions/],
    ['a mode', settings({ defaultMode: 'plan' }), /the "defaultMode" of the permissions/],
    [
      'an allow that is no list',
      settings({ allow: 'Bash' }),
      /an "allow" that is no list of rules/,
    ],
    ['a rule that is no text', settings({ allow: [7] }), /an "allow" that is no list of rules/],
  ])('refuse %s', (_what, text, problem) => {
    expect(() => parsePermissions(text)).toThrow(problem);
    expect(() => parsePermissions(text)).toThrow(/^the fake agent cannot play/);
  });
});

describe('the denied path a call names', () => {
  it('is a settings file named anywhere, by the end of its path', () => {
    expect(
      deniedPathNamedBy({ file_path: '/work/pkg/.claude/settings.json' }, [
        '.claude/settings.json',
      ]),
    ).toBe('.claude/settings.json');
  });

  it('is found in any text of its input, nested ones too', () => {
    const folders = ['/state/root'];

    expect(deniedPathNamedBy({ file_path: '/state/root/token' }, folders)).toBe('/state/root');
    expect(deniedPathNamedBy({ command: 'rm -f /state/root/token' }, folders)).toBe('/state/root');
    expect(deniedPathNamedBy({ edits: [{ path: '/state/root/a' }] }, folders)).toBe('/state/root');
  });

  it('is none for a call on other folders', () => {
    expect(deniedPathNamedBy({ file_path: '/work/a.ts', limit: 3 }, ['/state/root'])).toBe(
      undefined,
    );
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
