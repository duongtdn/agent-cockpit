import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { confinementReader } from '../../src/server/confinement.ts';

const folder = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-confinement-')));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const LISTENER = { host: '127.0.0.1', port: 4100 };

describe("a launch's confinement", () => {
  it('names each state root by its given path and, when it differs, its real path', async () => {
    const real = join(folder, 'real-root');
    mkdirSync(real);
    const linked = join(folder, 'linked-root');
    symlinkSync(real, linked);
    const missing = join(folder, 'not-yet');

    const read = confinementReader({
      stateRoots: [linked, real, missing],
      appPorts: () => [8765],
      listener: LISTENER,
    });

    expect((await read()).stateRoots).toEqual([linked, real, missing]);
  });

  it("gives each of the app's ports on the loopback names and every local address, read at each launch", async () => {
    const ports = [8765];
    const read = confinementReader({ stateRoots: [], appPorts: () => ports, listener: LISTENER });
    ports.push(8443);

    const { appAddresses } = await read();

    const local = Object.values(networkInterfaces()).flatMap((addresses) =>
      (addresses ?? []).map(({ address }) => address),
    );
    for (const host of ['localhost', '0.0.0.0', '127.0.0.1', ...local]) {
      expect(appAddresses).toContainEqual({ host, port: 8765 });
      expect(appAddresses).toContainEqual({ host, port: 8443 });
    }
    expect(new Set(appAddresses.map(({ host, port }) => `${host} ${port}`)).size).toBe(
      appAddresses.length,
    );
  });

  it('gives the listener as it is', async () => {
    const read = confinementReader({ stateRoots: [], appPorts: () => [8765], listener: LISTENER });

    expect((await read()).listener).toEqual(LISTENER);
  });
});
