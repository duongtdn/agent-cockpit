import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Driver } from '../../src/server/driver.ts';
import { type ScriptedAgent, startScriptedAgent } from '../support/scripted-agent.ts';

const SOME_SESSION = '0c9a3d4e-0000-4000-8000-000000000000';

let agent: ScriptedAgent | undefined;

afterEach(async () => {
  await agent?.close();
  agent = undefined;
});

/** A driver that launches the `claude` of the server's `PATH`, with no argument, as an app's would. */
const plainDriver: Driver = {
  terminalKeys: [],
  silentStartCause: '',
  launch: async () => ({
    command: 'claude',
    args: [],
    environment: { PATH: process.env.PATH ?? '' },
  }),
  readHook: () => ({ events: [] }),
  canResume: async () => false,
};

function launchIn(scripted: ScriptedAgent, driver: Driver = plainDriver) {
  return scripted.driver(driver).launch({
    key: 'k',
    conversationId: SOME_SESSION,
    directory: scripted.workFolder,
    files: scripted.stateFolder,
    hooks: { url: 'http://127.0.0.1:9', token: 't' },
    environment: {},
  });
}

describe("an example's scripted agent", () => {
  it('lets a launch of its pinned agent pass the guard', async () => {
    agent = await startScriptedAgent('scripted-agent-test');

    await expect(launchIn(agent)).resolves.toMatchObject({ command: 'claude' });
  });

  it('refuses a launch the contract runner would refuse: a file of MCP servers the agent would read', async () => {
    agent = await startScriptedAgent('scripted-agent-test');
    writeFileSync(join(agent.workFolder, '.mcp.json'), JSON.stringify({ mcpServers: {} }));

    await expect(launchIn(agent)).rejects.toThrow(/The real agent is not started/);
  });

  it('refuses a launch of any other program than its pinned agent', async () => {
    agent = await startScriptedAgent('scripted-agent-test');
    const elsewhere: Driver = {
      ...plainDriver,
      launch: async () => ({ command: 'claude', args: [], environment: { PATH: '/usr/bin:/bin' } }),
    };

    await expect(launchIn(agent, elsewhere)).rejects.toThrow(/not the shim/);
  });

  it('removes its root and gives the process back its variables when it closes', async () => {
    const before = ['PATH', 'HOME', 'CLAUDE_CONFIG_DIR', 'TMUX_TMPDIR'].map(
      (name) => process.env[name],
    );
    const scripted = await startScriptedAgent('scripted-agent-test');

    await scripted.close();

    expect(existsSync(scripted.root)).toBe(false);
    expect(
      ['PATH', 'HOME', 'CLAUDE_CONFIG_DIR', 'TMUX_TMPDIR'].map((name) => process.env[name]),
    ).toEqual(before);
  });
});
