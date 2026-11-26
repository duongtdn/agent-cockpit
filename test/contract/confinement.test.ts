import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { PermissionMode } from '../../src/claude-code/index.ts';
import type { LaunchCommand } from '../../src/server/driver.ts';
import { toolUse, turn } from '../support/fake-api/index.ts';
import {
  BYPASS_ACCEPTED,
  type ContractCockpit,
  type ContractCockpitOptions,
  PERSONS_SANDBOX,
  SAID_KEY,
  startContractCockpit,
} from './cockpit-harness.ts';
import {
  BLOCKED,
  eventsRead,
  fetchLine,
  hookRead,
  itInTheSandbox,
  linesByLabel,
  machineAddresses,
  openDoor,
  openRawDoor,
  toolResults,
} from './confinement-probes.ts';

/**
 * The confinement lines the driver writes into every session's settings
 * (`claudeCode()`'s own, never written by hand), on the real agent: the
 * `Read` and `Edit` denies on the cockpit's state root, and the sandbox's
 * lines, which act once the person's own settings turn the sandbox on.
 */

/** Claude's own file tools and the shell, allowed with no ask: the denies are what is tested. */
const TOOLS = ['Bash', 'Read', 'Write', 'Edit'];

/**
 * The HTTP hooks a session fires that runs one turn with a tool and exits:
 * the driver's others (a failed turn, a compaction, a task) fire only when
 * that happens.
 */
const HOOKS_OF_A_TOOL_TURN_THEN_EXIT = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionEnd',
];

type ToolCall = readonly [name: string, input: Readonly<Record<string, unknown>>];

/** Where the cockpit is, and what a session of it is launched with. */
interface Setting {
  readonly mode: PermissionMode;
  readonly sandbox: boolean;
  readonly appAddress?: string;
}

function cockpitOptions({ mode, sandbox, appAddress }: Setting): ContractCockpitOptions {
  return {
    driver: { permissionMode: mode, permissions: { allow: TOOLS } },
    personsSettings: { ...(sandbox ? PERSONS_SANDBOX : {}), ...BYPASS_ACCEPTED },
    ...(appAddress === undefined ? {} : { appAddress }),
  };
}

/**
 * Starts a cockpit, has its session make the calls built from it, one a
 * turn, and waits for the session to be idle.
 *
 * @returns The cockpit, and each call's result, in order.
 */
async function sessionMaking(
  setting: Setting,
  calls: (cockpit: ContractCockpit) => readonly ToolCall[] | Promise<readonly ToolCall[]>,
): Promise<{ cockpit: ContractCockpit; results: ReturnType<typeof toolResults> }> {
  const cockpit = await startContractCockpit(cockpitOptions(setting));
  const made = await calls(cockpit);
  cockpit.api.script(...made.map(([name, input]) => turn(toolUse(name, input))), turn('Done.'));
  await cockpit.say('make the calls');
  await cockpit.sessionIn(SAID_KEY, 'idle');
  const results = toolResults(cockpit.api);
  expect(results).toHaveLength(made.length);
  return { cockpit, results };
}

function bash(command: string, more: Readonly<Record<string, unknown>> = {}): ToolCall {
  return ['Bash', { command, description: 'a command of the test', ...more }];
}

function appToken(cockpit: ContractCockpit): string {
  return readFileSync(join(cockpit.stateFolder, 'app-token'), 'utf8').trim();
}

/** The settings file the driver wrote for a launch, and what it holds. */
function settingsOf(launch: LaunchCommand | undefined): {
  file: string;
  settings: {
    permissions: { deny: string[] };
    sandbox: { network: { allowedDomains: string[] } };
    hooks: Record<string, { hooks: { type: string; command?: string }[] }[]>;
  };
} {
  const args = launch?.args ?? [];
  const file = args[args.indexOf('--settings') + 1] as string;
  return { file, settings: JSON.parse(readFileSync(file, 'utf8')) };
}

/** The deny rule the driver writes for a folder, as Claude Code reads an absolute path. */
function readDenyOf(folder: string): string {
  return `Read(/${folder}/**)`;
}

const MODES_OF_THE_SPIKE: readonly PermissionMode[] = ['default', 'bypassPermissions'];

itInTheSandbox(
  "50 — A Read deny rule refuses the Read tool and cat on the folder; in the sandbox it hides the folder's files from any process, in default and bypassPermissions",
  async () => {
    const reads = (cockpit: ContractCockpit): ToolCall[] => [
      ['Read', { file_path: join(cockpit.stateFolder, 'app-token') }],
      bash(`cat ${join(cockpit.stateFolder, 'app-token')}`),
    ];
    const byCode = (cockpit: ContractCockpit): ToolCall[] => [
      ...reads(cockpit),
      bash(`python3 -c "print(open('${join(cockpit.stateFolder, 'app-token')}').read())"`),
    ];
    const settings: [Setting, typeof reads][] = [
      [{ mode: 'default', sandbox: false }, reads],
      ...MODES_OF_THE_SPIKE.map((mode): [Setting, typeof reads] => [
        { mode, sandbox: true },
        byCode,
      ]),
    ];

    for (const [setting, calls] of settings) {
      const { cockpit, results } = await sessionMaking(setting, calls);
      const token = appToken(cockpit);
      for (const result of results) {
        expect(result.isError, `${JSON.stringify(setting)}: ${result.text}`).toBe(true);
        expect(result.text, JSON.stringify(setting)).not.toContain(token);
      }
    }
  },
  120_000,
);

itInTheSandbox(
  "51 — deniedDomains with the app's port refuses it by localhost, 127.0.0.1, 0.0.0.0, [::1], [::] and their other spellings (127.1, LOCALHOST, 2130706433, 0x7f000001, [::ffff:127.0.0.1]), in bypassPermissions too, and leaves other ports alone",
  async () => {
    const other = await openDoor('127.0.0.1');
    const spellings = [
      'localhost',
      '127.0.0.1',
      '0.0.0.0',
      '[::1]',
      '[::]',
      '127.1',
      'LOCALHOST',
      '2130706433',
      '0x7f000001',
      '[::ffff:127.0.0.1]',
    ];
    const { results } = await sessionMaking(
      { mode: 'bypassPermissions', sandbox: true, appAddress: '::' },
      (cockpit) => [
        bash(
          [
            ...spellings.map((host) =>
              fetchLine(`app ${host}`, `http://${host}:${cockpit.appPort}/`),
            ),
            ...['127.0.0.1', 'localhost'].map((host) =>
              fetchLine(`other ${host}`, `http://${host}:${other.port}/`),
            ),
          ].join('; '),
        ),
      ],
    );

    const lines = linesByLabel(results[0]?.text ?? '');
    for (const host of spellings) expect(lines.get(`app ${host}`), host).toContain(BLOCKED);
    expect(lines.get('other 127.0.0.1')).toContain(other.answer);
    expect(lines.get('other localhost')).toContain(other.answer);
  },
);

itInTheSandbox(
  '52 — allowUnsandboxedCommands: false in --settings makes dangerouslyDisableSandbox ignored, in bypassPermissions too',
  async () => {
    const { cockpit, results } = await sessionMaking(
      { mode: 'bypassPermissions', sandbox: true },
      (cockpit) => [
        bash(`cat ${join(cockpit.stateFolder, 'app-token')}`, { dangerouslyDisableSandbox: true }),
        bash(
          `curl -s -m 3 --noproxy '*' -o /dev/null -w 'status %{http_code}' http://127.0.0.1:${cockpit.appPort}/`,
          { dangerouslyDisableSandbox: true },
        ),
      ],
    );

    expect(results[0]?.isError).toBe(true);
    expect(results[0]?.text).not.toContain(appToken(cockpit));
    // Outside the sandbox the app answers; inside, the command has no network of its own.
    expect(results[1]?.text).toContain('status 000');
  },
);

itInTheSandbox(
  "53 — In a sandboxed session, an HTTP hook reaches the listener's 127.0.0.1:<port>, which the driver puts in allowedDomains",
  async () => {
    const { cockpit } = await sessionMaking({ mode: 'default', sandbox: true }, () => [
      bash('true'),
    ]);
    const start = hookRead(cockpit, 'SessionStart');
    await cockpit.exitByItself(SAID_KEY, String(start.session_id));

    const { settings } = settingsOf(cockpit.launches[0]);
    expect(settings.sandbox.network.allowedDomains).toEqual([
      expect.stringMatching(/^127\.0\.0\.1:\d+$/),
    ]);
    for (const event of HOOKS_OF_A_TOOL_TURN_THEN_EXIT) {
      expect(eventsRead(cockpit), event).toContain(event);
    }
  },
);

itInTheSandbox(
  '55 — A command hook runs outside the sandbox and the permission rules: it reads a folder the agent may not read, and reaches loopback',
  async () => {
    const { cockpit } = await sessionMaking({ mode: 'default', sandbox: true }, () => []);

    const { settings } = settingsOf(cockpit.launches[0]);
    const [command] = settings.hooks.SessionStart?.flatMap((group) => group.hooks) ?? [];
    // The SessionStart command reads its address file in the state folder, then posts to the listener.
    expect(command?.type).toBe('command');
    expect(command?.command).toContain(`${cockpit.stateFolder}/`);
    expect(settings.permissions.deny).toContain(readDenyOf(cockpit.stateFolder));
    expect(hookRead(cockpit, 'SessionStart')).toMatchObject({ source: 'startup' });
  },
);

it.each(MODES_OF_THE_SPIKE)(
  "75 — An Edit deny rule beside the Read deny keeps the Write and Edit tools and the shell's plain writes (echo >, cp, rm, mv) out of the folder without the sandbox, in %s",
  async (mode) => {
    let tokenBefore = '';
    const { cockpit, results } = await sessionMaking({ mode, sandbox: false }, (cockpit) => {
      const state = cockpit.stateFolder;
      const token = join(state, 'app-token');
      tokenBefore = appToken(cockpit);
      writeFileSync(join(cockpit.workFolder, 'seed.txt'), 'seed\n');
      return [
        ['Write', { file_path: join(state, 'by-write.txt'), content: 'w\n' }],
        ['Write', { file_path: token, content: 'overwritten\n' }],
        ['Edit', { file_path: token, old_string: tokenBefore, new_string: 'edited' }],
        bash(`echo x > ${join(state, 'by-echo.txt')}`),
        bash(`cp ${join(cockpit.workFolder, 'seed.txt')} ${join(state, 'by-cp.txt')}`),
        bash(`mv ${token} ${join(state, 'moved')}`),
        bash(`rm -f ${token}`),
      ];
    });

    for (const result of results) {
      expect(result.isError, result.text).toBe(true);
      expect(result.text).toMatch(/denied/i);
    }
    const stateFiles = readdirSync(cockpit.stateFolder);
    for (const written of ['by-write.txt', 'by-echo.txt', 'by-cp.txt', 'moved']) {
      expect(stateFiles).not.toContain(written);
    }
    expect(appToken(cockpit)).toBe(tokenBefore);
  },
);

itInTheSandbox(
  "76 — deniedDomains with an address of the machine's own and the app's port refuses that port by that address, in bypassPermissions too",
  async () => {
    const everywhere = await openDoor('::');
    const addresses = machineAddresses();
    const { results } = await sessionMaking(
      { mode: 'bypassPermissions', sandbox: true, appAddress: '::' },
      (cockpit) => [
        bash(
          addresses
            .flatMap((host) => [
              fetchLine(`app ${host}`, `http://${host}:${cockpit.appPort}/`),
              fetchLine(`other ${host}`, `http://${host}:${everywhere.port}/`),
            ])
            .join('; '),
        ),
      ],
    );

    const lines = linesByLabel(results[0]?.text ?? '');
    for (const host of addresses) {
      expect(lines.get(`app ${host}`), host).toContain(BLOCKED);
      // The same address, another port: the line refuses the app's port, not the address.
      expect(lines.get(`other ${host}`), host).toContain(everywhere.answer);
    }
  },
);

/** The first bytes of a TLS connection: a handshake record (22), version 3.x. */
const TLS_HANDSHAKE = Buffer.from([0x16, 0x03]);

it("54 — WebFetch forces HTTPS and sends no header of the caller's", async () => {
  // WebFetch would ask api.anthropic.com about the host first: the person turns that off.
  const cockpit = await startContractCockpit({
    driver: { permissionMode: 'default', permissions: { allow: ['WebFetch'] } },
    personsSettings: { skipWebFetchPreflight: true },
  });
  const door = await openRawDoor('127.0.0.1');
  const token = appToken(cockpit);
  const url = `http://127.0.0.1:${door.port}/page`;
  const prompt = 'Say what the page holds.';
  cockpit.api.script(
    turn(toolUse('WebFetch', { url, prompt })),
    // A header of the caller's, by a parameter of its own, then by the URL's credentials.
    turn(toolUse('WebFetch', { url, prompt, headers: { 'X-Cockpit-Token': token } })),
    turn(toolUse('WebFetch', { url: `http://cockpit:${token}@127.0.0.1:${door.port}/`, prompt })),
    turn('Done.'),
  );
  await cockpit.say('fetch the page');
  await cockpit.sessionIn(SAID_KEY, 'idle');

  const [plain, withHeaders, withCredentials] = toolResults(cockpit.api);
  expect(plain?.isError).toBe(true);
  expect(withHeaders).toEqual({
    text: expect.stringContaining('An unexpected parameter `headers` was provided'),
    isError: true,
  });
  expect(withCredentials).toEqual({ text: expect.stringContaining('Invalid URL'), isError: true });
  // The plain http address is fetched over TLS: a hello reaches the door, never a request
  // line; and nothing of the caller's token reaches it, by any of the three.
  const received = door.received();
  expect(received.length).toBeGreaterThan(0);
  for (const bytes of received) {
    expect(bytes.subarray(0, 2).equals(TLS_HANDSHAKE), bytes.toString('latin1')).toBe(true);
    expect(bytes.includes(token)).toBe(false);
  }
});

it('77 — A Read deny rule on the folder of the --settings file does not keep Claude Code from loading it', async () => {
  const { cockpit } = await sessionMaking({ mode: 'default', sandbox: false }, () => [
    bash('true'),
  ]);

  const { file, settings } = settingsOf(cockpit.launches[0]);
  expect(file.startsWith(`${cockpit.stateFolder}/`)).toBe(true);
  expect(settings.permissions.deny).toContain(readDenyOf(cockpit.stateFolder));
  // Every HTTP hook comes from that file.
  for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) {
    expect(eventsRead(cockpit), event).toContain(event);
  }
});

itInTheSandbox(
  '78 — An HTTP hook sends Host 127.0.0.1:<port> and no Origin, through the sandbox and without it',
  async () => {
    for (const sandbox of [false, true]) {
      const { cockpit } = await sessionMaking({ mode: 'default', sandbox }, () => [bash('true')]);

      // The listener passes a hook on only with exactly that Host and no Origin; any other, 403.
      for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) {
        expect(eventsRead(cockpit), `${event}, sandbox ${sandbox}`).toContain(event);
      }
    }
  },
);

it("79 — The sandbox's lines change nothing in a session the sandbox is off for: it starts with no dialog, every hook arrives, the shell and the file tools work, the app's port is reached", async () => {
  const { cockpit, results } = await sessionMaking({ mode: 'default', sandbox: false }, (c) => {
    const file = join(c.workFolder, 'a.txt');
    return [
      bash('echo hello'),
      ['Write', { file_path: file, content: 'alpha\n' }],
      ['Read', { file_path: file }],
      ['Edit', { file_path: file, old_string: 'alpha', new_string: 'beta' }],
      bash(
        `curl -s -m 3 -o /dev/null -w 'status %{http_code}' http://127.0.0.1:${c.appPort}/elsewhere`,
      ),
    ];
  });

  expect(results.map((result) => result.isError)).toEqual([false, false, false, false, false]);
  expect(results[0]?.text).toContain('hello');
  expect(readFileSync(join(cockpit.workFolder, 'a.txt'), 'utf8')).toBe('beta\n');
  // The app answers for itself outside its mount.
  expect(results[4]?.text).toContain('status 404');
  expect(cockpit.states(SAID_KEY)).toEqual(['starting', 'busy', 'idle']);
  expect(eventsRead(cockpit).filter((event) => event === 'PreToolUse')).toHaveLength(5);
  expect(eventsRead(cockpit).filter((event) => event === 'PostToolUse')).toHaveLength(5);
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
    expect(eventsRead(cockpit), event).toContain(event);
  }
});
