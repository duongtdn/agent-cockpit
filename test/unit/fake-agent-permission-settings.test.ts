import { describe, expect, it } from 'vitest';
import {
  allowsEveryCallOf,
  deniedFolderNamedBy,
  parsePermissions,
} from '../support/fake-agent/permission-settings.ts';

function settings(permissions: unknown): string {
  return JSON.stringify({ hooks: {}, permissions });
}

describe("the permissions of the fake agent's settings file", () => {
  it('give the rules they allow calls by, as written', () => {
    expect(parsePermissions(settings({ allow: ['Bash', 'Read(./docs/**)'] }))).toEqual({
      allowRules: ['Bash', 'Read(./docs/**)'],
      deniedFolders: [],
    });
  });

  it('give the folders they deny to Read and Edit, each once', () => {
    const deny = ['Read(//state/root/**)', 'Edit(//state/root/**)', 'Read(//linked/root/**)'];

    expect(parsePermissions(settings({ deny })).deniedFolders).toEqual([
      '/state/root',
      '/linked/root',
    ]);
  });

  it('give no rule when the file has no permissions, or permissions that allow nothing', () => {
    const none = { allowRules: [], deniedFolders: [] };

    expect(parsePermissions('{}')).toEqual(none);
    expect(parsePermissions(settings({}))).toEqual(none);
  });

  it.each([
    ['settings that are no JSON', '{ "permissions": ', /settings that are no JSON/],
    ['permissions that are no object', settings(['Bash']), /permissions that are no object/],
    ['a denial of a tool', settings({ deny: ['Bash'] }), /the deny rule "Bash"/],
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

describe('the denied folder a call names', () => {
  it('is found in any text of its input, nested ones too', () => {
    const folders = ['/state/root'];

    expect(deniedFolderNamedBy({ file_path: '/state/root/token' }, folders)).toBe('/state/root');
    expect(deniedFolderNamedBy({ command: 'rm -f /state/root/token' }, folders)).toBe(
      '/state/root',
    );
    expect(deniedFolderNamedBy({ edits: [{ path: '/state/root/a' }] }, folders)).toBe(
      '/state/root',
    );
  });

  it('is none for a call on other folders', () => {
    expect(deniedFolderNamedBy({ file_path: '/work/a.ts', limit: 3 }, ['/state/root'])).toBe(
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
