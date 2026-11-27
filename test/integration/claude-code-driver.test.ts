import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeCode } from '../../src/claude-code/index.ts';
import type { Driver, DriverEvent, Launch } from '../../src/server/driver.ts';
import type { SessionHost } from '../../src/server/session-host/session-host.ts';
import { createTmuxSessionHost } from '../../src/server/session-host/tmux-session-host.ts';
import { writeAgentShim } from '../support/agent-shim.ts';
import { eventually } from '../support/eventually.ts';
import { fakeAgentCommand } from '../support/fake-agent/launching.ts';
import { type Turn, writeScript } from '../support/fake-agent/script.ts';
import { onlyTheseVariables } from '../support/real-agent/environment.ts';

/**
 * Stands in for the cockpit's agent-facing listener: it takes a request only
 * with the session's token, and gives it to the driver as the listener does.
 */
interface Listener {
  readonly base: string;
  readonly events: DriverEvent[];
  readonly refused: number;
  close(): Promise<void>;
}

const HOOK_BASE_PATH = '/agent';

async function startListener(driver: Driver, token: string): Promise<Listener> {
  const events: DriverEvent[] = [];
  let refused = 0;
  const server: Server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8').on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      if (request.headers.authorization !== `Bearer ${token}`) {
        refused += 1;
        response.writeHead(401).end();
        return;
      }
      const path = (request.url ?? '').slice(HOOK_BASE_PATH.length);
      events.push(...driver.readHook({ key: 'chapter-1', path, body: JSON.parse(body) }).events);
      response.setHeader('content-type', 'application/json').end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}${HOOK_BASE_PATH}`,
    events,
    get refused() {
      return refused;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const host: SessionHost = createTmuxSessionHost({
  appName: `claude-code-driver-test-${process.pid}-${Date.now()}`,
});
let root: string;
let configFolder: string;
let shimFolder: string;
let listener: Listener | undefined;
let sessions = 0;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-claude-code-driver-')));
  configFolder = join(root, 'config');
  shimFolder = join(root, 'bin');
  mkdirSync(shimFolder);
  writeAgentShim(shimFolder, fakeAgentCommand());
});

beforeEach(() => {
  // The server's own, which the app hid from its sessions: the driver looks
  // conversations up where the agents it launches keep them, never here.
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'the-servers-own'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const name of await host.list()) await host.kill(name);
  await listener?.close();
  listener = undefined;
});

afterAll(async () => {
  await host.shutDown();
  rmSync(root, { recursive: true, force: true });
});

/** Launches the fake agent through the driver, as the core will: its folders, its token, the host. */
async function launchThroughDriver(driver: Driver, script: readonly Turn[], prompt: string) {
  sessions += 1;
  const name = `session-${sessions}`;
  const directory = join(root, name);
  const files = join(root, `${name}-files`);
  mkdirSync(directory);
  mkdirSync(files, { mode: 0o700 });
  writeScript(directory, script);
  const token = randomBytes(32).toString('base64url');
  listener = await startListener(driver, token);
  const launch: Launch = {
    key: name,
    conversationId: randomUUID(),
    directory,
    files,
    hooks: { url: listener.base, token },
    prompt,
    environment: {
      ...(process.env as Record<string, string>),
      PATH: `${shimFolder}:${process.env.PATH}`,
      CLAUDE_CONFIG_DIR: configFolder,
    },
    confinement: {
      stateRoots: [files],
      appAddresses: [],
      listener: { host: '127.0.0.1', port: Number(new URL(listener.base).port) },
    },
  };
  const command = await driver.launch(launch);
  await host.start({
    name,
    folder: directory,
    command: command.command,
    args: command.args,
    environment: onlyTheseVariables(command.environment, process.env),
    size: { columns: 100, rows: 30 },
  });
  return { name, launch, listener };
}

describe('the Claude Code driver, with the fake agent in tmux', () => {
  it('reports the start, the prompt, the work and the end of the turn with its message', async () => {
    const driver = claudeCode({ permissions: { allow: ['Bash'] } });
    const touch = { do: 'tool', name: 'Bash', input: { command: 'touch a.txt' } } as const;
    const { launch, listener } = await launchThroughDriver(
      driver,
      [[touch, { do: 'reply', text: 'Done.' }]],
      'Touch a.txt',
    );

    await eventually(() =>
      expect(listener.events).toEqual([
        { type: 'ready' },
        { type: 'conversation', conversationId: launch.conversationId },
        { type: 'prompt-taken', prompt: 'Touch a.txt' },
        { type: 'working' },
        { type: 'working' },
        { type: 'turn-ended', lastMessage: 'Done.' },
        { type: 'tasks', running: [] },
      ]),
    );
    expect(listener.refused).toBe(0);
  });

  it('reports an agent that exits by itself, and that its conversation can resume', async () => {
    const driver = claudeCode();
    const { name, launch, listener } = await launchThroughDriver(
      driver,
      [[{ do: 'exit' }]],
      'Leave',
    );

    await eventually(() =>
      expect(listener.events).toEqual([
        { type: 'ready' },
        { type: 'conversation', conversationId: launch.conversationId },
        { type: 'prompt-taken', prompt: 'Leave' },
        { type: 'ending', reason: 'agent-exit' },
      ]),
    );
    await eventually(async () => expect(await host.isLive(name)).toBe(false));
    expect(await driver.canResume(launch)).toBe(true);
    expect(await driver.canResume({ ...launch, conversationId: randomUUID() })).toBe(false);
  });

  it('reports a turn the person interrupts in the terminal, which the transcript alone records', async () => {
    const driver = claudeCode({ permissions: { allow: ['Bash'] } });
    const touch = { do: 'tool', name: 'Bash', input: { command: 'touch a.txt' } } as const;
    const { name, launch, listener } = await launchThroughDriver(
      driver,
      [[touch, { do: 'stay-busy' }]],
      'Touch a.txt, then think',
    );
    const told: DriverEvent[] = [];
    const stop = driver.follow({ ...launch, isNew: true }, (events) => told.push(...events));
    try {
      await eventually(() => expect(listener.events).toHaveLength(5));

      await host.sendKeys(name, ['Escape']);

      await eventually(() =>
        expect(told).toEqual([{ type: 'interrupted', at: expect.any(String) }]),
      );
      expect(listener.events.at(-1)).toEqual({ type: 'working' });
    } finally {
      stop();
    }
  });
});
