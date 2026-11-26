import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { setTimeout as pause } from 'node:timers/promises';
import { it, onTestFinished, type RunnerTestCase, type TaskMeta, TestRunner } from 'vitest';
import type { HookRequest } from '../../src/server/driver.ts';
import { type FakeApi, toolUse, turn } from '../support/fake-api/index.ts';
import { sandboxStatus } from '../support/real-agent/sandbox.ts';
import { type ContractCockpit, SAID_KEY } from './cockpit-harness.ts';
import type { Reach, ReachOutcome } from './results.ts';

/**
 * What the contract tests of the confinement lines share: doors that log
 * who reached them, the machine's own addresses, the commands that try an
 * address through the sandbox's proxy, and the person at the terminal who
 * answers the agent's dialogs.
 */

/** A server that answers every request with a word of its own, and keeps the paths it was asked for. */
export interface Door {
  readonly port: number;
  /** What it answers with: a command's output that holds it reached the door. */
  readonly answer: string;
  /** The paths asked for, in order. */
  hits(): readonly string[];
}

/**
 * Opens a door on an address for the running test, closed when it finishes.
 *
 * @param host - The address it listens on.
 */
export async function openDoor(host: string): Promise<Door> {
  const hits: string[] = [];
  const answer = `REACHED-${Math.random().toString(36).slice(2)}`;
  const server = createServer((request, response) => {
    hits.push(request.url ?? '');
    response.end(answer);
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { port: (server.address() as AddressInfo).port, answer, hits: () => [...hits] };
}

/**
 * The machine's own addresses beyond the loopback, as a URL writes a host:
 * every IPv4 address and every IPv6 address but a link-local one (whose
 * zone a URL cannot carry).
 *
 * @throws Error when the machine has none: the rows that need one would prove nothing.
 */
export function machineAddresses(): string[] {
  const addresses = Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((address) => !address.internal)
    .filter((address) => address.family === 'IPv4' || !address.address.startsWith('fe80:'))
    .map((address) => (address.family === 'IPv6' ? `[${address.address}]` : address.address));
  if (addresses.length === 0) throw new Error('The machine has no address beyond the loopback.');
  return addresses;
}

/**
 * A shell command that asks for a URL and prints what came back, on one
 * line after a label: through the sandbox's proxy, the only way out of
 * its network, or directly.
 */
export function fetchLine(label: string, url: string, way: 'proxy' | 'direct' = 'proxy'): string {
  const route = way === 'proxy' ? `-x "$HTTP_PROXY" --noproxy ''` : `--noproxy '*'`;
  return `echo "${label} => $(curl -s -m 5 ${route} '${url}' 2>&1 | head -c 120 | tr '\\n' ' ')"`;
}

/** What the sandbox's proxy answers for an address it refuses. */
export const BLOCKED = 'Connection blocked by network allowlist';

/**
 * Gives every tool result the agent sent the API, in order, as text: the
 * last conversation request carries the whole conversation.
 */
export function toolResults(api: FakeApi): { text: string; isError: boolean }[] {
  const last = api
    .requests()
    .filter((request) => request.kind === 'conversation')
    .at(-1);
  return (last?.body?.messages ?? []).flatMap((message) =>
    typeof message.content === 'string'
      ? []
      : message.content
          .filter((block) => block.type === 'tool_result')
          .map((block) => ({
            text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
            isError: block.is_error === true,
          })),
  );
}

/** The lines of a tool result's text that hold a label, by label. */
export function linesByLabel(text: string): Map<string, string> {
  return new Map(
    text
      .split('\n')
      .map((line) => line.split(' => '))
      .filter((parts) => parts.length >= 2)
      .map(([label, ...rest]) => [label as string, rest.join(' => ')]),
  );
}

function eventOf(request: HookRequest): unknown {
  return (request.body as { hook_event_name?: unknown }).hook_event_name;
}

/**
 * Gives the body of the first hook of an event the driver read.
 *
 * @throws Error when it read none.
 */
export function hookRead(cockpit: ContractCockpit, event: string): Record<string, unknown> {
  const request = cockpit.hooksRead.find((read) => eventOf(read) === event);
  if (request === undefined) throw new Error(`The driver read no ${event} hook.`);
  return request.body as Record<string, unknown>;
}

/** The events of every hook the driver read, in order. */
export function eventsRead(cockpit: ContractCockpit): unknown[] {
  return cockpit.hooksRead.map(eventOf);
}

function runningTestMeta(): TaskMeta {
  const test = TestRunner.getCurrentTest<RunnerTestCase | undefined>();
  if (test === undefined) throw new Error('No test runs.');
  return test.meta;
}

/** A test that turns the agent's sandbox on, as a person's settings do. */
type SandboxedBody = () => Promise<void>;

/**
 * Declares a test that turns the agent's sandbox on. Where the sandbox
 * cannot run, the test fails, saying why — unless CI declared its platform
 * lacks it: then the test does not run, and the run's results say so. It is
 * never left out unseen.
 *
 * @param title - The behavior's number and the behavior.
 * @param body - The test.
 * @param timeoutMs - How long it may take.
 */
export function itInTheSandbox(title: string, body: SandboxedBody, timeoutMs?: number): void {
  const status = sandboxStatus();
  const marked: SandboxedBody = async () => {
    runningTestMeta().needsSandbox = true;
    if (status.kind === 'missing') throw new Error(status.problem);
    await body();
  };
  if (status.kind === 'declared-lacking') {
    it.skip(title, marked);
    return;
  }
  it(title, marked, timeoutMs);
}

/** One address a sandboxed command tries, in a mode's measure. */
export interface Probe {
  /** What the address is, for the results. */
  readonly target: string;
  /** The door behind it. */
  readonly door: Door;
  /** The host the command asks for: an IPv4 address or a name, as the agent's network ask names it too. */
  readonly host: string;
  /** Whether the command names the address in its `allowed_domains`. */
  readonly namedOnTheCommand: boolean;
}

/** The dialogs a person answers while a mode is measured, and how. */
const AUTO_MODE_CHECK_GONE = 'Enter to stay in auto mode';
const COMMAND_APPROVAL = 'Do you want to proceed?';
const NETWORK_ASK = 'Network request outside of sandbox';
/** How long a dialog is given to go once answered, before it counts as still there. */
const ANSWER_PATIENCE_MS = 3000;
const POLL_MS = 200;
/** How long a probe's request may wait, in seconds: far longer than a measure waits to answer. */
const PROBE_TIMEOUT_S = 30;

/**
 * Measures what a sandboxed command reaches, one probe a turn, in a session
 * of the cockpit's: the script runs each probe as a `Bash` call, then ends
 * the turn. A person sits at the terminal: they stay in `auto` mode when it
 * says its server-side check cannot run, and approve each command that
 * check would have judged (the scripted API cannot stand in for it), so
 * that what is measured is the network and not the command; they answer
 * every network ask "No". A probe's outcome: `reached` when its door was
 * hit, `asked` when a network ask named its host while it ran, else
 * `refused`. The measure is noted in the test's results.
 *
 * @param cockpit - A cockpit whose sessions run with the sandbox on.
 * @param mode - The mode its driver launches sessions in.
 * @param probes - The addresses to try.
 * @returns Each probe's outcome, in order.
 */
export async function measureReach(
  cockpit: ContractCockpit,
  mode: string,
  probes: readonly Probe[],
): Promise<Reach[]> {
  cockpit.api.script(
    ...probes.map((probe, index) =>
      turn(
        toolUse('Bash', {
          // Long enough that a network ask stays until it is answered: one that closes as the
          // request times out could take its Esc as the interruption of the turn.
          command: `curl -s -m ${PROBE_TIMEOUT_S} -x "$HTTP_PROXY" --noproxy '' http://${probe.host}:${probe.door.port}/probe-${index}`,
          description: `probe ${index}`,
          ...(probe.namedOnTheCommand
            ? { allowed_domains: [probe.host.replace(/^\[|\]$/g, '')] }
            : {}),
        }),
      ),
    ),
    turn('Measured.'),
  );
  await cockpit.say('try each address');
  const asked = await answerUntilTheTurnEnds(cockpit, probes);
  const said = toolResults(cockpit.api).map((result) => result.text);
  const reaches = probes.map((probe, index) => ({
    target: probe.target,
    namedOnTheCommand: probe.namedOnTheCommand,
    outcome: outcomeOf(probe, index, asked),
    sandboxSaid: violationIn(said[index] ?? ''),
  }));
  runningTestMeta().networkReach = { mode, reaches };
  return reaches;
}

function outcomeOf(probe: Probe, index: number, asked: ReadonlySet<number>): ReachOutcome {
  if (probe.door.hits().includes(`/probe-${index}`)) return 'reached';
  return asked.has(index) ? 'asked' : 'refused';
}

/** The sandbox's word on a refused connection, from a command's output: none when it said nothing. */
function violationIn(output: string): string {
  return /deny network-outbound \S+ \(([^)]*)\)/.exec(output)?.[1] ?? '';
}

/**
 * Answers the session's dialogs as {@link measureReach} says, until the turn
 * has ended and no dialog is left.
 *
 * @returns The probes, by index, a network ask named while they ran.
 */
async function answerUntilTheTurnEnds(
  cockpit: ContractCockpit,
  probes: readonly Probe[],
): Promise<Set<number>> {
  const start = await waitForHook(cockpit, 'SessionStart');
  const terminal = cockpit.terminal(SAID_KEY, String(start.session_id));
  const asked = new Set<number>();
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const screen = await terminal.screen();
    const dialog = dialogOn(screen);
    if (dialog === undefined) {
      if (eventsRead(cockpit).includes('Stop')) return asked;
      await pause(POLL_MS);
      continue;
    }
    if (dialog === 'network') {
      const running = eventsRead(cockpit).filter((event) => event === 'PreToolUse').length - 1;
      const host = /Host: (\S+)/.exec(screen)?.[1];
      if (host !== probes[running]?.host) {
        throw new Error(`A network ask named ${host} while probe ${running} ran:\n${screen}`);
      }
      asked.add(running);
      // Its third option, "No", by its number: an Esc would answer it too, but one that comes
      // once the ask is gone (another ask of the same host answered with it) interrupts the turn.
      await terminal.type('3');
    } else if (dialog === 'auto-mode-check') {
      await terminal.press('Enter');
    } else {
      await approveTheCommand(terminal);
    }
    await untilChanged(terminal, screen);
  }
  throw new Error(`The turn did not end: the terminal shows\n${await terminal.screen()}`);
}

/** The approval's options, "No" first and selected: Enter is pressed only once "Yes" is. */
const YES_SELECTED = /❯ Yes/u;

/**
 * Approves a command: down to "Yes", then Enter once "Yes" shows selected. An
 * Enter on "No" would refuse the command and interrupt the turn.
 */
async function approveTheCommand(terminal: {
  screen(): Promise<string>;
  press(...keys: string[]): Promise<void>;
}): Promise<void> {
  const deadline = Date.now() + ANSWER_PATIENCE_MS;
  while (!YES_SELECTED.test(await terminal.screen())) {
    if (Date.now() > deadline) throw new Error('"Yes" never showed selected in the approval.');
    await terminal.press('Down');
    await pause(POLL_MS);
  }
  await terminal.press('Enter');
}

type Dialog = 'network' | 'auto-mode-check' | 'command-approval';

function dialogOn(screen: string): Dialog | undefined {
  if (screen.includes(NETWORK_ASK)) return 'network';
  if (screen.includes(AUTO_MODE_CHECK_GONE)) return 'auto-mode-check';
  if (screen.includes(COMMAND_APPROVAL)) return 'command-approval';
  return undefined;
}

async function untilChanged(
  terminal: { screen(): Promise<string> },
  answered: string,
): Promise<void> {
  const deadline = Date.now() + ANSWER_PATIENCE_MS;
  while (Date.now() < deadline && (await terminal.screen()) === answered) await pause(POLL_MS);
}

async function waitForHook(
  cockpit: ContractCockpit,
  event: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (eventsRead(cockpit).includes(event)) return hookRead(cockpit, event);
    await pause(POLL_MS);
  }
  throw new Error(`The driver read no ${event} hook in 15 s.`);
}
