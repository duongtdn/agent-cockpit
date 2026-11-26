import { expect } from 'vitest';
import type { PermissionMode } from '../../src/claude-code/index.ts';
import { BYPASS_ACCEPTED, PERSONS_SANDBOX, startContractCockpit } from './cockpit-harness.ts';
import {
  itInTheSandbox,
  machineAddresses,
  measureReach,
  openDoor,
  type Probe,
} from './confinement-probes.ts';
import type { ReachOutcome } from './results.ts';

/**
 * What a sandboxed command reaches beyond the cockpit's allow-list, in each
 * permission mode, with the sandbox on in the person's settings and the
 * driver's lines in the session's: an unlisted loopback port, standing for
 * a local proxy that forwards to the app, and another address of the
 * machine's, standing for any host off the loopback (the suite reaches no
 * network). Each is tried once plainly and once named in the command's
 * `allowed_domains`, a field of the `Bash` call that the server-side check
 * of `auto` judges. The driver counts a mode's network as confined only
 * where every reach is asked about or refused.
 */

/** Every probe of a measure, in order; the outcomes below follow it. */
async function probes(): Promise<Probe[]> {
  const [address] = machineAddresses().filter((host) => !host.startsWith('['));
  if (address === undefined)
    throw new Error('The machine has no IPv4 address beyond the loopback.');
  const loopback = await openDoor('127.0.0.1');
  const elsewhere = await openDoor(address);
  const onLoopback = { target: 'an unlisted loopback port', door: loopback, host: '127.0.0.1' };
  const offLoopback = {
    target: "another address of the machine's",
    door: elsewhere,
    host: address,
  };
  return [false, true].flatMap((namedOnTheCommand) =>
    [onLoopback, offLoopback].map((probe) => ({ ...probe, namedOnTheCommand })),
  );
}

async function measured(mode: PermissionMode): Promise<ReachOutcome[]> {
  const cockpit = await startContractCockpit({
    driver: { permissionMode: mode, permissions: { allow: ['Bash'] } },
    personsSettings: { ...PERSONS_SANDBOX, ...BYPASS_ACCEPTED },
  });
  const reaches = await measureReach(cockpit, mode, await probes());
  return reaches.map((reach) => reach.outcome);
}

const MEASURE_TIMEOUT_MS = 90_000;

/**
 * A reach not made: asked about or refused with no ask. What counts a mode
 * as confined is that none is made; which of the two each was is recorded
 * in the run's results (one run saw asks recorded as refusals, never again).
 */
const NOT_MADE = expect.toBeOneOf(['asked', 'refused']);

for (const mode of ['default', 'acceptEdits'] as const) {
  itInTheSandbox(
    `80 — In ${mode}, with the sandbox on, no reach of a sandboxed command beyond the allow-list (an unlisted loopback port, another address of the machine's) is made: each is asked about or refused, whatever the command names in allowed_domains`,
    async () => {
      expect(await measured(mode)).toEqual([NOT_MADE, NOT_MADE, NOT_MADE, NOT_MADE]);
    },
    MEASURE_TIMEOUT_MS,
  );
}

itInTheSandbox(
  "81 — In dontAsk, with the sandbox on, each reach of a sandboxed command beyond the allow-list (an unlisted loopback port, another address of the machine's) is refused with no ask, whatever the command names in allowed_domains",
  async () => {
    expect(await measured('dontAsk')).toEqual(['refused', 'refused', 'refused', 'refused']);
  },
  MEASURE_TIMEOUT_MS,
);

for (const [mode, plain] of [
  ['plan', 'asked'],
  ['auto', 'refused'],
] as const) {
  itInTheSandbox(
    `82 — In ${mode}, with the sandbox on, a sandboxed command reaches an unlisted loopback port and another address of the machine's with no ask of the network once the command that names them in allowed_domains is approved; named by none, each is ${plain === 'asked' ? 'asked about' : 'refused'}`,
    async () => {
      expect(await measured(mode)).toEqual([plain, plain, 'reached', 'reached']);
    },
    MEASURE_TIMEOUT_MS,
  );
}

itInTheSandbox(
  "83 — In bypassPermissions, with the sandbox on, a sandboxed command reaches an unlisted loopback port and another address of the machine's with no ask",
  async () => {
    expect(await measured('bypassPermissions')).toEqual([
      'reached',
      'reached',
      'reached',
      'reached',
    ]);
  },
  MEASURE_TIMEOUT_MS,
);
