import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UntrustedStateError } from '../../src/server/state/own-files.ts';
import { openStateFolder, stateFolderPath } from '../../src/server/state/state-folder.ts';

const modeOf = (path: string) => statSync(path).mode & 0o777;

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
    rmSync(root, { recursive: true, force: true });
  });

  it('creates the folder readable by the app’s user alone, its missing parents as any folder', async () => {
    const path = join(root, 'a/b/my-app');
    const folder = await openStateFolder(path);
    expect(folder.path).toBe(path);
    expect(modeOf(path)).toBe(0o700);
    const plain = join(root, 'plain');
    mkdirSync(plain);
    expect(modeOf(join(root, 'a/b'))).toBe(modeOf(plain));
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
    const owner = statSync(path).uid;
    vi.spyOn(process, 'getuid').mockReturnValue(owner + 1);
    try {
      await expect(openStateFolder(path)).rejects.toThrow(
        expect.objectContaining({
          name: 'UntrustedStateError',
          path,
          message: expect.stringContaining(`another user (uid ${owner})`),
        }),
      );
    } finally {
      vi.restoreAllMocks();
    }
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
});
