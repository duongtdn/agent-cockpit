import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UntrustedStateError } from '../../src/server/state/own-files.ts';
import {
  openStateFolder,
  type StateFolder,
  stateFolderPath,
} from '../../src/server/state/state-folder.ts';

const modeOf = (path: string) => statSync(path).mode & 0o777;

/** Paths the file system says another user owns: who runs the tests may own every folder, root included. */
const foreign = vi.hoisted(() => new Set<string>());

/** Paths the file system says are missing when first looked at, as if another process created them just after. */
const appearing = vi.hoisted(() => new Set<string>());

/** The uid the faked owner has: neither root nor, surely, the user who runs the tests. */
const STRANGER = 4242;

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  const owned = <T extends object>(path: unknown, found: T): T =>
    foreign.has(String(path))
      ? Object.assign(Object.create(Object.getPrototypeOf(found)), found, { uid: STRANGER })
      : found;
  return {
    ...fs,
    lstat: async (path: string) => {
      if (appearing.delete(String(path))) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      }
      return owned(path, await fs.lstat(path));
    },
    stat: async (path: string) => owned(path, await fs.stat(path)),
  };
});

describe('stateFolderPath', () => {
  it('puts the app’s folder under $XDG_STATE_HOME/agent-cockpit', () => {
    expect(stateFolderPath('my-app', undefined, { XDG_STATE_HOME: '/srv/state' })).toBe(
      '/srv/state/agent-cockpit/my-app',
    );
  });

  it('falls back to ~/.local/state without $XDG_STATE_HOME', () => {
    expect(stateFolderPath('my-app', undefined, {})).toBe(
      join(homedir(), '.local/state/agent-cockpit/my-app'),
    );
  });

  it('ignores an empty or relative $XDG_STATE_HOME, as the XDG specification says', () => {
    const fallback = join(homedir(), '.local/state/agent-cockpit/my-app');
    expect(stateFolderPath('my-app', undefined, { XDG_STATE_HOME: '' })).toBe(fallback);
    expect(stateFolderPath('my-app', undefined, { XDG_STATE_HOME: 'state' })).toBe(fallback);
  });

  it('names the folder as the app’s tmux socket is named, never leaving the root', () => {
    const env = { XDG_STATE_HOME: '/srv/state' };
    expect(stateFolderPath('../etc', undefined, env)).toBe(
      '/srv/state/agent-cockpit/_2e__2e__2f_etc',
    );
    expect(stateFolderPath('My App', undefined, env)).toBe(
      '/srv/state/agent-cockpit/_4d_y_20__41_pp',
    );
  });

  it('takes the folder the app gives as it is, made absolute', () => {
    expect(stateDirectoryOf('/data/cockpit')).toBe('/data/cockpit');
    expect(stateDirectoryOf('cockpit-state')).toBe(resolve('cockpit-state'));
  });
});

function stateDirectoryOf(stateDirectory: string): string {
  return stateFolderPath('my-app', stateDirectory, { XDG_STATE_HOME: '/srv/state' });
}

describe('openStateFolder', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cockpit-state-folder-'));
  });

  afterEach(() => {
    foreign.clear();
    appearing.clear();
    rmSync(root, { recursive: true, force: true });
  });

  it('creates the folder readable by the app’s user alone, its missing parents readable by all', async () => {
    const path = join(root, 'a/b/my-app');
    const folder = await openStateFolder(path);
    expect(folder.path).toBe(path);
    expect(modeOf(path)).toBe(0o700);
    expect(modeOf(join(root, 'a'))).toBe(0o755);
    expect(modeOf(join(root, 'a/b'))).toBe(0o755);
  });

  it.each([0o002, 0o077])('creates the same folders under the umask %o', async (mask) => {
    const before = process.umask(mask);
    try {
      const path = join(root, 'a/b/my-app');
      await openStateFolder(path);
      expect(modeOf(join(root, 'a'))).toBe(0o755);
      expect(modeOf(join(root, 'a/b'))).toBe(0o755);
      expect(modeOf(path)).toBe(0o700);
    } finally {
      process.umask(before);
    }
  });

  it('narrows a folder of the user’s that others could reach: it is the cockpit’s own', async () => {
    const path = join(root, 'my-app');
    mkdirSync(path);
    chmodSync(path, 0o775);
    await openStateFolder(path);
    expect(modeOf(path)).toBe(0o700);
  });

  it('refuses a path that is a file', async () => {
    const path = join(root, 'my-app');
    writeFileSync(path, '');
    await expect(openStateFolder(path)).rejects.toThrow(UntrustedStateError);
  });

  it('refuses a symbolic link, even to a folder of the user’s, and leaves its target as it is', async () => {
    const target = join(root, 'elsewhere');
    mkdirSync(target);
    chmodSync(target, 0o755);
    const path = join(root, 'my-app');
    symlinkSync(target, path);
    await expect(openStateFolder(path)).rejects.toThrow(UntrustedStateError);
    expect(modeOf(target)).toBe(0o755);
  });

  it('refuses a folder of another user, and says whose', async () => {
    const path = join(root, 'my-app');
    mkdirSync(path, { mode: 0o700 });
    foreign.add(path);
    await expect(openStateFolder(path)).rejects.toThrow(
      expect.objectContaining({
        name: 'UntrustedStateError',
        path,
        message: expect.stringContaining(`another user (uid ${STRANGER})`),
      }),
    );
  });

  describe('the folders above it', () => {
    /** An `/etc/group` of the test's own. */
    function groupFile(...lines: string[]): string {
      return systemFile('group', lines);
    }

    /** An `/etc/passwd` of the test's own. */
    function passwdFile(...lines: string[]): string {
      return systemFile('passwd', lines);
    }

    function systemFile(name: string, lines: readonly string[]): string {
      const file = join(root, name);
      writeFileSync(file, lines.map((line) => `${line}\n`).join(''));
      return file;
    }

    /** The system's files where the user's group is private: its only member, nobody else's primary group. */
    function privateGroup(groupLine = `${me}:x:${myGroup}:`) {
      return {
        groupFile: groupFile('other:x:1:', groupLine),
        passwdFile: passwdFile(myAccount()),
      };
    }

    /** The user's own line of the passwd file. */
    function myAccount(): string {
      return `${me}:x:${process.getuid?.()}:${myGroup}::/home/${me}:/bin/sh`;
    }

    const me = userInfo().username;
    const myGroup = process.getgid?.() ?? -1;

    function groupWritable(name: string): string {
      const parent = join(root, name);
      mkdirSync(parent);
      chmodSync(parent, 0o775);
      return parent;
    }

    it('refuses a parent others can write: they could swap the folder for theirs', async () => {
      const parent = join(root, 'shared');
      mkdirSync(parent);
      chmodSync(parent, 0o757);
      await expect(openStateFolder(join(parent, 'my-app'))).rejects.toThrow(
        expect.objectContaining({ name: 'UntrustedStateError', path: parent }),
      );
    });

    it('creates nothing before it refuses: the missing folders stay missing', async () => {
      const parent = join(root, 'shared');
      mkdirSync(parent);
      chmodSync(parent, 0o757);
      await expect(openStateFolder(join(parent, 'x/my-app'))).rejects.toThrow(UntrustedStateError);
      expect(existsSync(join(parent, 'x'))).toBe(false);
    });

    it('refuses a parent others can write found through a symbolic link', async () => {
      const shared = join(root, 'shared');
      mkdirSync(shared);
      chmodSync(shared, 0o757);
      symlinkSync(shared, join(root, 'link'));
      await expect(openStateFolder(join(root, 'link/my-app'))).rejects.toThrow(UntrustedStateError);
    });

    it('refuses a symbolic link above it that another user owns, wherever it leads', async () => {
      const target = join(root, 'target');
      mkdirSync(target, { mode: 0o755 });
      const link = join(root, 'link');
      symlinkSync(target, link);
      foreign.add(link);
      await expect(openStateFolder(join(link, 'my-app'))).rejects.toThrow(
        expect.objectContaining({ name: 'UntrustedStateError', path: link }),
      );
    });

    it('takes a parent anyone can write that has the sticky bit, as /tmp', async () => {
      const parent = join(root, 'sticky');
      mkdirSync(parent);
      chmodSync(parent, 0o1777);
      await openStateFolder(join(parent, 'my-app'));
      expect(modeOf(join(parent, 'my-app'))).toBe(0o700);
    });

    it.each([
      ['as listed', `${me}:x:${myGroup}:`],
      ['the user its only member, with CRLF and a trailing comma', `${me}:x:${myGroup}:${me},\r`],
    ])(
      'takes a parent its group can write when the group is the user’s private one (%s)',
      async (_, line) => {
        const parent = groupWritable('mine');
        await openStateFolder(join(parent, 'my-app'), privateGroup(line));
        expect(modeOf(join(parent, 'my-app'))).toBe(0o700);
      },
    );

    it.each([
      ['lists another member', () => `${me}:x:${myGroup}:${me},someone-else`],
      ['is named otherwise', () => `staff:x:${myGroup}:`],
    ])('refuses a parent its group can write when the group %s', async (_, line) => {
      const parent = groupWritable('shared');
      await expect(openStateFolder(join(parent, 'my-app'), privateGroup(line()))).rejects.toThrow(
        expect.objectContaining({ name: 'UntrustedStateError', path: parent }),
      );
    });

    it('refuses a parent its group can write when the group is another user’s primary group', async () => {
      const parent = groupWritable('shared');
      const files = {
        ...privateGroup(),
        passwdFile: passwdFile(
          `${me}:x:${process.getuid?.()}:${myGroup}::/home/${me}:/bin/sh`,
          `bob:x:4243:${myGroup}::/home/bob:/bin/sh`,
        ),
      };
      await expect(openStateFolder(join(parent, 'my-app'), files)).rejects.toThrow(
        expect.objectContaining({ path: parent, message: expect.stringContaining('bob') }),
      );
    });

    it('refuses a parent its group can write when the group file lists its gid twice', async () => {
      const parent = groupWritable('shared');
      const files = {
        ...privateGroup(),
        groupFile: groupFile(`staff:x:${myGroup}:bob`, `${me}:x:${myGroup}:`),
      };
      await expect(openStateFolder(join(parent, 'my-app'), files)).rejects.toThrow(
        expect.objectContaining({
          path: parent,
          message: expect.stringContaining('more than once'),
        }),
      );
    });

    it('refuses a parent its group can write when the group is not the user’s primary one, saying so', async () => {
      const parent = groupWritable('shared');
      vi.spyOn(process, 'getgid').mockReturnValue(myGroup + 1);
      try {
        await expect(openStateFolder(join(parent, 'my-app'), privateGroup())).rejects.toThrow(
          expect.objectContaining({
            path: parent,
            message: expect.stringContaining("not the user's primary group"),
          }),
        );
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('refuses a parent its group can write when the group is not in the group file, saying why', async () => {
      const parent = groupWritable('shared');
      const files = { ...privateGroup(), groupFile: groupFile('other:x:1:') };
      await expect(openStateFolder(join(parent, 'my-app'), files)).rejects.toThrow(
        expect.objectContaining({
          path: parent,
          message: expect.stringContaining(files.groupFile),
        }),
      );
    });

    it.each([
      ['a NIS line in the passwd file', () => ({ passwdFile: passwdFile(myAccount(), '+::::::') })],
      [
        'a NIS line in the group file',
        () => ({ groupFile: groupFile(`${me}:x:${myGroup}:`, '-bob') }),
      ],
      [
        'a gid that is no number',
        () => ({ passwdFile: passwdFile(myAccount(), 'bob:x:4243:staff::/:/bin/sh') }),
      ],
      ['a passwd file it cannot read', () => ({ passwdFile: join(root, 'no-passwd') })],
      ['a group file it cannot read', () => ({ groupFile: join(root, 'no-group') })],
    ])(
      'refuses a parent its group can write when the system’s files are not read whole: %s',
      async (_, files) => {
        const parent = groupWritable('shared');
        const given = { ...privateGroup(), ...files() };
        const named = 'passwdFile' in files() ? given.passwdFile : given.groupFile;
        await expect(openStateFolder(join(parent, 'my-app'), given)).rejects.toThrow(
          expect.objectContaining({
            name: 'UntrustedStateError',
            path: parent,
            message: expect.stringContaining(named),
          }),
        );
      },
    );

    it('skips the comments and blank lines of the system’s files', async () => {
      const parent = groupWritable('mine');
      const given = {
        groupFile: groupFile('# groups', '', `${me}:x:${myGroup}:`),
        passwdFile: passwdFile('# users', '', myAccount()),
      };
      await openStateFolder(join(parent, 'my-app'), given);
      expect(modeOf(join(parent, 'my-app'))).toBe(0o700);
    });

    it.each([
      ['leads nowhere', () => symlinkSync(join(root, 'missing'), join(root, 'link'))],
      [
        'leads through a file',
        () => {
          writeFileSync(join(root, 'file'), '');
          symlinkSync(join(root, 'file/below'), join(root, 'link'));
        },
      ],
      [
        'loops',
        () => {
          symlinkSync(join(root, 'loop'), join(root, 'link'));
          symlinkSync(join(root, 'link'), join(root, 'loop'));
        },
      ],
    ])('refuses a symbolic link above it that %s, naming it', async (_, make) => {
      make();
      const link = join(root, 'link');
      await expect(openStateFolder(join(link, 'my-app'))).rejects.toThrow(
        expect.objectContaining({ name: 'UntrustedStateError', path: link }),
      );
    });

    it('judges a parent that appears between its check and its creation', async () => {
      const parent = join(root, 'appeared');
      mkdirSync(parent);
      chmodSync(parent, 0o757);
      appearing.add(parent);
      await expect(openStateFolder(join(parent, 'my-app'))).rejects.toThrow(
        expect.objectContaining({ name: 'UntrustedStateError', path: parent }),
      );
    });

    it('takes a parent that appears between its check and its creation, when it is safe', async () => {
      const parent = join(root, 'appeared');
      mkdirSync(parent, { mode: 0o755 });
      appearing.add(parent);
      await openStateFolder(join(parent, 'my-app'));
      expect(modeOf(join(parent, 'my-app'))).toBe(0o700);
    });

    it('refuses a parent of another user, though no one else can write it', async () => {
      const parent = join(root, 'theirs');
      mkdirSync(parent, { mode: 0o755 });
      const path = join(parent, 'my-app');
      mkdirSync(path, { mode: 0o700 });
      foreign.add(parent);
      await expect(openStateFolder(path)).rejects.toThrow(
        expect.objectContaining({
          name: 'UntrustedStateError',
          path: parent,
          message: expect.stringContaining(`another user (uid ${STRANGER})`),
        }),
      );
    });
  });

  describe('the sessions’ folders', () => {
    it('prepares a session’s folder, private, under the state folder', async () => {
      const folder = await openStateFolder(join(root, 'my-app'));
      const path = await folder.sessions.prepare('explain-a-file');
      expect(path).toBe(join(root, 'my-app/sessions/explain-a-file'));
      expect(modeOf(path)).toBe(0o700);
      expect(modeOf(join(root, 'my-app/sessions'))).toBe(0o700);
    });

    it('prepares the same folder again, keeping what it holds', async () => {
      const folder = await openStateFolder(join(root, 'my-app'));
      const path = await folder.sessions.prepare('k');
      writeFileSync(join(path, 'kept'), '');
      chmodSync(path, 0o755);
      expect(await folder.sessions.prepare('k')).toBe(path);
      expect(statSync(join(path, 'kept')).isFile()).toBe(true);
      expect(modeOf(path)).toBe(0o700);
    });

    it('refuses a sessions’ folder that is a symbolic link', async () => {
      const path = join(root, 'my-app');
      mkdirSync(path, { mode: 0o700 });
      mkdirSync(join(root, 'elsewhere'));
      symlinkSync(join(root, 'elsewhere'), join(path, 'sessions'));
      await expect(openStateFolder(path)).rejects.toThrow(UntrustedStateError);
    });

    it.each(['', '..', 'a/b', 'A', 'a_b', '.hidden'])(
      'refuses %j, which is no session key',
      async (key) => {
        const folder = await openStateFolder(join(root, 'my-app'));
        await expect(folder.sessions.prepare(key)).rejects.toThrow(TypeError);
      },
    );
  });

  describe('removing a session’s folder', () => {
    /** A session's folder holding what the driver writes in it, both files carrying its hook token. */
    async function preparedWithSettings(folder: StateFolder, key: string): Promise<string> {
      const path = await folder.sessions.prepare(key);
      writeFileSync(join(path, 'settings.json'), '{"token":"secret"}', { mode: 0o600 });
      writeFileSync(join(path, 'hook-address.json'), '{"token":"secret"}', { mode: 0o600 });
      return path;
    }

    it('deletes the key’s folder and all it holds, and nothing of another key or beside it', async () => {
      const folder = await openStateFolder(join(root, 'my-app'));
      const removed = await preparedWithSettings(folder, 'a');
      mkdirSync(join(removed, 'nested'));
      writeFileSync(join(removed, 'nested/file'), '');
      const kept = await preparedWithSettings(folder, 'b');
      const transcripts = join(root, 'claude-config/projects/p');
      mkdirSync(transcripts, { recursive: true });
      writeFileSync(join(transcripts, 'conversation.jsonl'), 'the agent’s');

      await folder.sessions.remove('a');

      expect(existsSync(removed)).toBe(false);
      expect(readdirSync(kept).sort()).toEqual(['hook-address.json', 'settings.json']);
      expect(readFileSync(join(transcripts, 'conversation.jsonl'), 'utf8')).toBe('the agent’s');
      expect(statSync(join(root, 'my-app/sessions')).isDirectory()).toBe(true);
    });

    it('does nothing for a key that has no folder', async () => {
      const folder = await openStateFolder(join(root, 'my-app'));
      await folder.sessions.remove('never-prepared');
      expect(readdirSync(join(root, 'my-app/sessions'))).toEqual([]);
    });

    it('removes a symbolic link planted in the folder, never what it leads to', async () => {
      const folder = await openStateFolder(join(root, 'my-app'));
      const path = await preparedWithSettings(folder, 'a');
      const outside = outsideFolder();
      symlinkSync(outside, join(path, 'to-a-folder'));
      symlinkSync(join(outside, 'file'), join(path, 'to-a-file'));

      await folder.sessions.remove('a');

      expect(existsSync(path)).toBe(false);
      expect(readFileSync(join(outside, 'file'), 'utf8')).toBe('not the cockpit’s');
    });

    it('removes a symbolic link put in place of the folder, never what it leads to', async () => {
      const folder = await openStateFolder(join(root, 'my-app'));
      const outside = outsideFolder();
      const path = join(root, 'my-app/sessions/a');
      symlinkSync(outside, path);

      await folder.sessions.remove('a');

      expect(existsSync(path)).toBe(false);
      expect(readFileSync(join(outside, 'file'), 'utf8')).toBe('not the cockpit’s');
    });

    it.each(['', '.', '..', '../..', 'a/b', 'A', '.hidden'])(
      'refuses %j, which is no session key, and deletes nothing',
      async (key) => {
        const folder = await openStateFolder(join(root, 'my-app'));
        await preparedWithSettings(folder, 'a');
        await expect(folder.sessions.remove(key)).rejects.toThrow(TypeError);
        expect(readdirSync(join(root, 'my-app/sessions/a')).sort()).toEqual([
          'hook-address.json',
          'settings.json',
        ]);
      },
    );

    /** A folder outside the state folder holding a file of someone else's. */
    function outsideFolder(): string {
      const outside = join(root, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'file'), 'not the cockpit’s');
      return outside;
    }
  });
});
