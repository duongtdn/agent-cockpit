import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import type { ClaudeCodeOptions } from '../../src/claude-code/index.ts';
import type { LaunchCommand } from '../../src/server/driver.ts';
import { type FakeApi, startFakeApi, toolUse, turn } from '../support/fake-api/index.ts';
import {
  type ContractCockpit,
  type HookPayload,
  SAID_KEY,
  startContractCockpit,
} from './cockpit-harness.ts';
import { toolResults } from './confinement-probes.ts';
import { assertNoUnexpectedPath, conversationTexts } from './harness.ts';

/**
 * The driver's options, each through the driver's own command line and
 * settings, on the real agent.
 */

function eventsOf(cockpit: ContractCockpit): unknown[] {
  return cockpit.hooksRead.map((request) => (request.body as HookPayload).hook_event_name);
}

function conversationRequests(api: FakeApi) {
  return api.requests().filter((request) => request.kind === 'conversation');
}

function settingsOf(launch: LaunchCommand | undefined): Record<string, unknown> {
  const args = launch?.args ?? [];
  return JSON.parse(readFileSync(args[args.indexOf('--settings') + 1] as string, 'utf8'));
}

/** A shell command, run with no ask. */
function bash(command: string) {
  return toolUse('Bash', { command, description: 'a command of the test' });
}

const PROJECT_MEMORY = 'The project memory says: tangerine-7731.';

/**
 * Starts a cockpit whose person denies the shell, whose project has its
 * memory, and whose session runs a shell command with the driver's options.
 *
 * @returns The cockpit once its session is idle, and what the command gave.
 */
async function sessionWithSources(driver: ClaudeCodeOptions) {
  const cockpit = await startContractCockpit({
    driver: { ...driver, permissions: { allow: ['Bash'] } },
    personsSettings: { permissions: { deny: ['Bash'] } },
    directory: ({ workFolder }) => {
      writeFileSync(join(workFolder, 'CLAUDE.md'), PROJECT_MEMORY);
      return workFolder;
    },
  });
  cockpit.api.script(turn(bash('touch made-by-the-shell')), turn('Done.'));
  await cockpit.say('run the command');
  await cockpit.sessionIn(SAID_KEY, 'idle');
  const [result] = toolResults(cockpit.api);
  const first = await cockpit.api.conversationRequest(1);
  return {
    cockpit,
    result,
    remembered: JSON.stringify(first.body).includes('tangerine-7731'),
    ran: existsSync(join(cockpit.workFolder, 'made-by-the-shell')),
  };
}

it("72 — --setting-sources leaves out each omitted source's settings and, without project, the project's CLAUDE.md; --settings hooks survive it and --strict-mcp-config; the login works with ''", async () => {
  const none = await sessionWithSources({ settingSources: [], otherMcpServers: false });
  // Started once the first is done: the server's PATH is the latest cockpit's.
  const both = await sessionWithSources({ settingSources: ['user', 'project'] });

  expect(none.cockpit.launches[0]?.args).toEqual(
    expect.arrayContaining(['--setting-sources', '', '--strict-mcp-config']),
  );
  // The person's deny left out: the shell ran; the project's memory left out.
  expect(none.result).toMatchObject({ isError: false });
  expect(none.ran).toBe(true);
  expect(none.remembered).toBe(false);
  // The cockpit's hooks, of --settings, all came.
  expect(eventsOf(none.cockpit)).toEqual([
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'PostToolBatch',
    'Stop',
  ]);
  expect(both.cockpit.launches[0]?.args).toEqual(
    expect.arrayContaining(['--setting-sources', 'user,project']),
  );
  expect(both.cockpit.launches[0]?.args).not.toContain('--strict-mcp-config');
  expect(both.result).toMatchObject({ isError: true });
  expect(both.ran).toBe(false);
  expect(both.remembered).toBe(true);
});

it("87 — --model reaches the API request's model; --plugin-dir loads the plugin: its command is the agent's", async () => {
  const model = 'claude-sonnet-4-5';
  const cockpit = await startContractCockpit({
    driver: ({ root }) => {
      const plugin = join(root, 'plugin');
      mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
      mkdirSync(join(plugin, 'commands'));
      writeFileSync(
        join(plugin, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'probe', description: 'A command of the test.', version: '1.0.0' }),
      );
      writeFileSync(join(plugin, 'commands', 'greet.md'), 'Say the word: plugged-in-5512.');
      return { model, pluginDir: plugin };
    },
  });
  cockpit.api.script(turn('Plugged in.'));

  await cockpit.say('/probe:greet');
  const idle = await cockpit.sessionIn(SAID_KEY, 'idle');
  const request = await cockpit.api.conversationRequest(1);

  expect(cockpit.launches[0]?.args).toEqual(
    expect.arrayContaining(['--model', model, '--plugin-dir', join(cockpit.root, 'plugin')]),
  );
  expect(request.body?.model).toBe(model);
  expect(conversationTexts(request).join('\n')).toContain('Say the word: plugged-in-5512.');
  expect(idle).toMatchObject({ lastMessage: 'Plugged in.' });
});

it('74 — A Claude Code session passes its CLAUDE_CODE_* variables to the processes it starts; the driver gives the agent none of those the server inherited', async () => {
  const cockpit = await startContractCockpit({
    driver: { permissions: { allow: ['Bash'] } },
    // Whatever the launch carries of it reaches the agent: the driver is what keeps it out.
    shim: { passedOn: ['CLAUDE_CODE_MAX_RETRIES'] },
  });
  // As a server started from a Claude Code session inherits that session's.
  vi.stubEnv('CLAUDE_CODE_MAX_RETRIES', '7');
  cockpit.api.script(
    turn(
      bash(
        'echo "inherited=$(printenv CLAUDE_CODE_MAX_RETRIES || echo none) own=$(printenv CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC || echo none)"',
      ),
    ),
    turn('Echoed.'),
  );

  await cockpit.say('echo the variables');
  await cockpit.sessionIn(SAID_KEY, 'idle');
  const [result] = toolResults(cockpit.api);

  expect(cockpit.launches[0]?.environment).not.toHaveProperty('CLAUDE_CODE_MAX_RETRIES');
  expect(result?.text).toContain('inherited=none own=1');
});

it("91 — The person's settings' env reaches the agent past the driver's stripping and wins over its environment: their ANTHROPIC_BASE_URL takes the turns, their CLAUDE_CODE_* reaches the processes it starts", async () => {
  const theirs = await startFakeApi();
  onTestFinished(async () => {
    await theirs.close();
    theirs.assertNothingUnexpected();
    assertNoUnexpectedPath(theirs);
  });
  const cockpit = await startContractCockpit({
    driver: { permissions: { allow: ['Bash'] } },
    personsSettings: {
      env: { ANTHROPIC_BASE_URL: theirs.baseUrl, CLAUDE_CODE_MAX_RETRIES: '3' },
    },
  });
  theirs.script(
    turn(bash('echo "retries=$(printenv CLAUDE_CODE_MAX_RETRIES || echo none)"')),
    turn('Theirs.'),
  );

  await cockpit.say('echo the retries');
  const idle = await cockpit.sessionIn(SAID_KEY, 'idle');
  const [result] = toolResults(theirs);

  expect(settingsOf(cockpit.launches[0])).not.toHaveProperty('env');
  expect(conversationRequests(theirs)).toHaveLength(2);
  expect(conversationRequests(cockpit.api)).toEqual([]);
  expect(result?.text).toContain('retries=3');
  expect(idle).toMatchObject({ lastMessage: 'Theirs.' });
});
