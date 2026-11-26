import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AppLock, takeAppLock } from '../../src/server/state/lock.ts';
import { CockpitError } from '../../src/shared/cockpit-error.ts';
import { killLockHolders, type LockHolder, startLockHolder } from '../support/lock-holders.ts';

let root: string;
let folder: string;
const locks: AppLock[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cockpit-lock-'));
  folder = join(root, 'my-app');
  mkdirSync(folder, { mode: 0o700 });
});

afterEach(async () => {
  await killLockHolders();
  await Promise.all(locks.splice(0).map((lock) => lock.release()));
  rmSync(root, { recursive: true, force: true });
});

async function take(where = folder, options: Parameters<typeof takeAppLock>[1] = { waitMs: 0 }) {
  const lock = await takeAppLock(where, options);
  locks.push(lock);
  return lock;
}

async function holding(where = folder): Promise<LockHolder> {
  const holder = startLockHolder(where);
  expect(await holder.nextLine()).toBe(`HELD ${holder.pid}`);
  return holder;
}

function locked(holder: number | 'another-user') {
  return expect.objectContaining({ code: 'cockpit-locked', holder });
}

describe('the app’s lock', () => {
  it('is taken once: a second take in the same process names it as the holder', async () => {
    await take();
    const second = takeAppLock(folder, { waitMs: 0 });
    await expect(second).rejects.toBeInstanceOf(CockpitError);
    await expect(second).rejects.toEqual(locked(process.pid));
  });

  it('is free again once released', async () => {
    const lock = await take();
    await lock.release();
    await take();
  });

  it('names another process of the app that holds it, after waiting for it', async () => {
    const holder = await holding();
    const before = Date.now();
    await expect(takeAppLock(folder, { waitMs: 300 })).rejects.toEqual(locked(holder.pid));
    expect(Date.now() - before).toBeGreaterThanOrEqual(300);
  });

  it('says so in its message', async () => {
    const holder = await holding();
    await expect(takeAppLock(folder, { waitMs: 0 })).rejects.toThrow(
      `Another process of the app (${holder.pid}) runs a cockpit with sessions`,
    );
  });

  it('is released by the system when its holder is killed with SIGKILL', async () => {
    const holder = await holding();
    holder.process.kill('SIGKILL');
    await holder.exited;
    await take();
  });

  it('lets a newcomer pass when its holder exits within the wait', async () => {
    const holder = await holding();
    const newcomer = take(folder, { waitMs: 5000 });
    holder.send('exit');
    await newcomer;
    expect(await holder.exited).toBe(0);
  });

  it('is released when its holder releases it, the process still running', async () => {
    const holder = await holding();
    holder.send('release');
    expect(await holder.nextLine()).toBe('RELEASED');
    await take();
  });

  it('never keeps the app’s process alive', async () => {
    const holder = startLockHolder(folder, { mode: 'return' });
    expect(await holder.nextLine()).toBe(`HELD ${holder.pid}`);
    expect(await holder.exited).toBe(0);
  });

  it('goes to exactly one of five processes that race for it in a new state folder', async () => {
    for (let round = 0; round < 5; round++) {
      const where = join(root, `race-${round}`);
      mkdirSync(where, { mode: 0o700 });
      const racers = Array.from({ length: 5 }, () => startLockHolder(where, { mode: 'on-go' }));
      for (const racer of racers) expect(await racer.nextLine()).toBe('READY');
      for (const racer of racers) racer.send('go');
      const results = await Promise.all(racers.map((racer) => racer.nextLine()));
      const winners = racers.filter((racer, i) => results[i] === `HELD ${racer.pid}`);
      expect(winners).toHaveLength(1);
      expect(results.filter((line) => line === `LOCKED ${winners[0]?.pid}`)).toHaveLength(4);
      await killLockHolders();
    }
  });

  it('belongs to its state folder: two folders, two locks', async () => {
    const other = join(root, 'other-app');
    mkdirSync(other, { mode: 0o700 });
    await take();
    await take(other);
  });

  it('keeps its id in the state folder, for the app’s user alone, the same at every take', async () => {
    const lock = await take();
    const file = join(folder, 'lock-id');
    const id = readFileSync(file, 'utf8');
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await lock.release();
    await take();
    expect(readFileSync(file, 'utf8')).toBe(id);
  });

  it('refuses a damaged id rather than take a lock no other process would see', async () => {
    writeFileSync(join(folder, 'lock-id'), 'not an id', { mode: 0o600 });
    await expect(takeAppLock(folder, { waitMs: 0 })).rejects.toThrow(/lock-id/);
  });

  it('says another user holds it when the listener is none of the user’s processes', async () => {
    await holding();
    // A view of the system where the holder's process cannot be read, as
    // another user's process cannot: the kernel's sockets, and no process.
    const proc = join(root, 'proc');
    mkdirSync(join(proc, 'net'), { recursive: true });
    writeFileSync(join(proc, 'net/unix'), readFileSync('/proc/net/unix'));
    const attempt = takeAppLock(folder, { waitMs: 0, procRoot: proc });
    await expect(attempt).rejects.toEqual(locked('another-user'));
    await expect(attempt).rejects.toThrow(/another user/);
  });

  it('names the process that holds its name bound without listening, after the wait', async () => {
    const id = '0123456789abcdef0123456789abcdef';
    writeFileSync(join(folder, 'lock-id'), id, { mode: 0o600 });
    const squatter = await bindWithoutListening(`agent-cockpit-${process.getuid?.()}-${id}`);
    try {
      await expect(takeAppLock(folder, { waitMs: 100 })).rejects.toEqual(locked(squatter.pid ?? 0));
    } finally {
      squatter.kill();
    }
  });
});

/**
 * A process that binds an abstract socket's name and never listens on it:
 * the name is taken, though no listener holds it.
 */
async function bindWithoutListening(name: string): Promise<ChildProcess> {
  const program = [
    'import socket, sys',
    's = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)',
    `s.bind(b"\\0${name}")`,
    'print("BOUND", flush=True)',
    'sys.stdin.read()',
  ].join('\n');
  const child = spawn('python3', ['-c', program], { stdio: ['pipe', 'pipe', 'inherit'] });
  await once(child.stdout, 'data');
  return child;
}
