import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openAppToken } from '../../src/server/state/app-token.ts';
import { UntrustedStateError } from '../../src/server/state/own-files.ts';
import { isWireToken } from '../../src/shared/wire.ts';

let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'cockpit-app-token-'));
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe('openAppToken', () => {
  it('mints a token at the first start, kept in the state folder for the app’s user alone', async () => {
    const token = await openAppToken(folder);
    expect(isWireToken(token.value)).toBe(true);
    expect(Buffer.from(token.value, 'base64url')).toHaveLength(32);
    const files = statSync(join(folder, 'app-token'));
    expect(files.mode & 0o777).toBe(0o600);
    expect(readFileSync(join(folder, 'app-token'), 'utf8')).toBe(token.value);
  });

  it('keeps the same token across restarts', async () => {
    const first = await openAppToken(folder);
    const second = await openAppToken(folder);
    expect(second.value).toBe(first.value);
  });

  it.each([
    ['empty', ''],
    ['too short', 'abc'],
    ['not base64url', `${'a'.repeat(42)}=`],
  ])('replaces a file that holds no token (%s)', async (_, content) => {
    writeFileSync(join(folder, 'app-token'), content, { mode: 0o600 });
    const token = await openAppToken(folder);
    expect(token.value).not.toBe(content);
    expect(isWireToken(token.value)).toBe(true);
    expect(readFileSync(join(folder, 'app-token'), 'utf8')).toBe(token.value);
  });

  it('accepts its own token, and nothing else', async () => {
    const token = await openAppToken(folder);
    expect(token.matches(token.value)).toBe(true);
    expect(token.matches(undefined)).toBe(false);
    expect(token.matches('')).toBe(false);
    expect(token.matches(token.value.slice(1))).toBe(false);
  });

  it.each([0o644, 0o620, 0o604])(
    'mints a new token when others could read or write the kept one (%o): it may be known',
    async (mode) => {
      const first = await openAppToken(folder);
      const file = join(folder, 'app-token');
      chmodSync(file, mode);
      const second = await openAppToken(folder);
      expect(second.value).not.toBe(first.value);
      expect(second.matches(first.value)).toBe(false);
      expect(readFileSync(file, 'utf8')).toBe(second.value);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    },
  );

  it('refuses a token’s file that is no regular file', async () => {
    mkdirSync(join(folder, 'app-token'));
    await expect(openAppToken(folder)).rejects.toThrow(UntrustedStateError);
  });

  it('refuses a token’s file that is a symbolic link, even to a token of the user’s', async () => {
    const elsewhere = join(folder, 'elsewhere');
    writeFileSync(elsewhere, 'kq3J_x-9Zt0aPbXw2eYc8vRm4nLs6uHd1oQiGfAjK7E', { mode: 0o600 });
    symlinkSync(elsewhere, join(folder, 'app-token'));
    await expect(openAppToken(folder)).rejects.toThrow(UntrustedStateError);
  });

  it('refuses a token’s file of another user: who planted it knows the token', async () => {
    writeFileSync(join(folder, 'app-token'), 'kq3J_x-9Zt0aPbXw2eYc8vRm4nLs6uHd1oQiGfAjK7E', {
      mode: 0o600,
    });
    vi.spyOn(process, 'getuid').mockReturnValue(statSync(folder).uid + 1);
    try {
      await expect(openAppToken(folder)).rejects.toThrow(UntrustedStateError);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
