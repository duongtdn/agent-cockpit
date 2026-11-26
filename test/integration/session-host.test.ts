import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type {
  Attachment,
  SessionHost,
  StartOptions,
  TerminalSize,
} from '../../src/server/session-host/session-host.ts';
import { SessionHostError } from '../../src/server/session-host/session-host-error.ts';
import { connectionArguments, socketNameFor } from '../../src/server/session-host/tmux-commands.ts';
import { createTmuxSessionHost } from '../../src/server/session-host/tmux-session-host.ts';
import { eventually } from '../support/eventually.ts';

/** A variable the tmux server inherits from this process, for a session to have removed. */
const INHERITED = 'COCKPIT_HOST_TEST_INHERITED';

const appName = `host-test-${process.pid}-${Date.now()}`;
const size: TerminalSize = { columns: 100, rows: 30 };
const pacing = { chunkLength: 200, pauseMs: 1 };

/** What the panes' programs take their terminal for on this machine. */
const paneTerminalType =
  spawnSync('infocmp', ['tmux-256color']).status === 0 ? 'tmux-256color' : 'screen-256color';

let host: SessionHost;
let folder: string;
const attachments: Attachment[] = [];
const restorations: (() => void)[] = [];

beforeAll(() => {
  process.env[INHERITED] = 'inherited';
  host = createTmuxSessionHost({ appName });
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-session-host-')));
});

afterEach(async () => {
  for (const restore of restorations.splice(0)) restore();
  await Promise.all(attachments.splice(0).map((attachment) => attachment.detach()));
  for (const name of await host.list()) await host.kill(name);
});

afterAll(async () => {
  await host.shutDown();
  rmSync(folder, { recursive: true, force: true });
  delete process.env[INHERITED];
});

function start(name: string, command: string, args: string[], changes: Partial<StartOptions> = {}) {
  return host.start({
    name,
    folder,
    command,
    args,
    environment: { set: {}, remove: [] },
    size,
    ...changes,
  });
}

/** Starts a session that runs a shell script, the words after it its `$1`, `$2`, …. */
function startScript(name: string, script: string, ...words: string[]) {
  return start(name, 'sh', ['-c', script, 'sh', ...words]);
}

async function attach(name: string, terminal: TerminalSize = size): Promise<Attachment> {
  const attachment = await host.attach(name, terminal);
  attachments.push(attachment);
  return attachment;
}

/** Everything an attachment's terminal receives, from now on. */
function outputOf(attachment: Attachment): { text: string } {
  const output = { text: '' };
  attachment.onData((data) => {
    output.text += data;
  });
  return output;
}

async function screenOf(name: string): Promise<string> {
  return (await host.readScreen(name)).text;
}

function expectScreen(name: string, text: string): Promise<void> {
  return eventually(async () => expect(await screenOf(name)).toContain(text));
}

/**
 * Starts a session that records every byte it receives, as it is, in a
 * file: its terminal neither echoes nor edits.
 */
async function startRecorder(name: string): Promise<string> {
  const file = join(folder, `${name}.keys`);
  await startScript(name, 'stty raw -echo; printf ready; exec cat > "$1"', file);
  await expectScreen(name, 'ready');
  return file;
}

function expectRecorded(file: string, expected: string): Promise<void> {
  return eventually(() => expect(readFileSync(file, 'utf8')).toBe(expected));
}

function expectRecordedBytes(file: string, expected: Uint8Array): Promise<void> {
  return eventually(() =>
    expect(readFileSync(file).toString('hex')).toBe(Buffer.from(expected).toString('hex')),
  );
}

/** What a session's process finds: its working directory and its environment. */
interface Surroundings {
  readonly folder: string;
  readonly environment: Record<string, string>;
}

const REPORT_SURROUNDINGS = `
  const { writeFileSync, renameSync } = require('node:fs');
  const report = JSON.stringify({ folder: process.cwd(), environment: process.env });
  writeFileSync(process.argv[1] + '.part', report);
  renameSync(process.argv[1] + '.part', process.argv[1]);
  setInterval(() => {}, 1000);
`;

/** Starts a session whose process, with no shell before it, reports what it finds. */
async function surroundingsOf(
  name: string,
  changes: Partial<StartOptions> = {},
): Promise<Surroundings> {
  const file = join(folder, `${name}.surroundings.json`);
  rmSync(file, { force: true });
  await start(name, process.execPath, ['-e', REPORT_SURROUNDINGS, file], changes);
  return eventually(() => JSON.parse(readFileSync(file, 'utf8')) as Surroundings);
}

/** The variables tmux sets for a pane itself, whatever a session is started with. */
const PANE_VARIABLES = [
  'TERM',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'TMUX',
  'TMUX_PANE',
  'SHELL',
];

function without(variables: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(variables).filter(([name]) => !names.includes(name)));
}

/** Sets variables of this process for the time of a test. */
function withProcessVariables(variables: Record<string, string>): void {
  Object.assign(process.env, variables);
  restorations.push(() => {
    for (const name of Object.keys(variables)) delete process.env[name];
  });
}

/** Tells whether any process of the machine holds a text in its arguments. */
function someProcessArgumentHolds(text: string): boolean {
  return readdirSync('/proc')
    .filter((entry) => /^\d+$/.test(entry))
    .some((pid) => {
      try {
        return readFileSync(`/proc/${pid}/cmdline`).includes(text);
      } catch {
        // The process ended while the list was read.
        return false;
      }
    });
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function expectFailure(operation: Promise<unknown>, reason: string): Promise<void> {
  const error = await operation.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(SessionHostError);
  expect(error).toMatchObject({ reason });
}

/**
 * Scrolls a session back, as a person does in an attached terminal. The test
 * asks tmux itself: the host has no such operation, and none to offer.
 */
async function enterCopyMode(name: string): Promise<void> {
  execFileSync('tmux', [
    ...connectionArguments(socketNameFor(appName)),
    'copy-mode',
    '-t',
    `=${name}:0.0`,
  ]);
  expect((await host.readScreen(name)).inCopyMode).toBe(true);
}

/**
 * Reads an option of the host's tmux server. The test asks tmux itself: what
 * an option does cannot always be seen but on a clock.
 */
function serverOption(option: string): string {
  return execFileSync(
    'tmux',
    [...connectionArguments(socketNameFor(appName)), 'show-options', '-sv', option],
    { encoding: 'utf8' },
  ).trim();
}

describe('before any session', () => {
  it('lists no session and finds none live, with no server running', async () => {
    expect(await host.list()).toEqual([]);
    expect(await host.isLive('nothing')).toBe(false);
    expect(await host.processOf('nothing')).toBeUndefined();
    expect(await host.kill('nothing')).toBe('gone');
  });

  it('refuses to type into, read or attach to a session that does not live', async () => {
    await expectFailure(host.sendText('nothing', 'x', pacing), 'no-session');
    await expectFailure(host.sendKeys('nothing', ['Enter']), 'no-session');
    await expectFailure(host.sendBytes('nothing', Uint8Array.of(0x0d)), 'no-session');
    await expectFailure(host.readScreen('nothing'), 'no-session');
    await expectFailure(host.countAttached('nothing'), 'no-session');
    await expectFailure(host.attach('nothing', size), 'no-session');
  });
});

describe('a name that cannot be a session’s', () => {
  const operations: readonly (readonly [string, () => Promise<unknown>])[] = [
    ['isLive', () => host.isLive('a.b')],
    ['processOf', () => host.processOf('a.b')],
    ['sendText', () => host.sendText('a.b', 'x', pacing)],
    ['sendKeys', () => host.sendKeys('a.b', ['Enter'])],
    ['sendBytes', () => host.sendBytes('a.b', Uint8Array.of(0x0d))],
    ['readScreen', () => host.readScreen('a.b')],
    ['attach', () => host.attach('a.b', size)],
    ['countAttached', () => host.countAttached('a.b')],
    ['kill', () => host.kill('a.b')],
  ];

  it.each(operations)('is refused by %s with a rejection', async (_operation, call) => {
    let refusal: Promise<unknown> | undefined;

    expect(() => {
      refusal = call();
    }).not.toThrow();
    await expect(refusal).rejects.toThrow(TypeError);
  });
});

describe('with no server running', () => {
  const operations: readonly (readonly [string, (idle: SessionHost) => Promise<unknown>])[] = [
    ['listing', (idle) => idle.list()],
    ['asking whether a session lives', (idle) => idle.isLive('nothing')],
    ['asking for a process', (idle) => idle.processOf('nothing')],
    ['counting terminals', (idle) => idle.countAttached('nothing').catch(() => undefined)],
    ['killing a session', (idle) => idle.kill('nothing')],
    ['shutting down', (idle) => idle.shutDown()],
  ];

  /**
   * Gives tmux a folder of its own for its sockets, for the time of a test:
   * a server that starts there, even one that is gone again, shows in the
   * folder's time of change.
   */
  function useOwnSocketFolder(): string {
    const before = process.env.TMUX_TMPDIR;
    const base = mkdtempSync(join(tmpdir(), 'cockpit-sockets-'));
    process.env.TMUX_TMPDIR = base;
    restorations.push(() => {
      if (before === undefined) delete process.env.TMUX_TMPDIR;
      else process.env.TMUX_TMPDIR = before;
      rmSync(base, { recursive: true, force: true });
    });
    const sockets = join(base, `tmux-${process.getuid?.()}`);
    mkdirSync(sockets, { mode: 0o700 });
    return sockets;
  }

  it.each(operations)('%s starts none, and leaves no socket', async (_what, operation) => {
    const sockets = useOwnSocketFolder();
    const idle = createTmuxSessionHost({ appName: 'idle' });
    const created = statSync(sockets, { bigint: true }).mtimeNs;
    // Longer than the grain of the file system's clock.
    await pause(50);

    await operation(idle);

    expect(readdirSync(sockets)).toEqual([]);
    expect(statSync(sockets, { bigint: true }).mtimeNs).toBe(created);
  });
});

describe('starting a session', () => {
  it('runs the command in the folder, at the size given', async () => {
    await startScript('where', 'pwd; stty size; exec cat');

    await expectScreen('where', `${folder}\n30 100`);
  });

  it.each([
    'x#(touch pwned)',
    '#{pane_pid}#{session_name}',
    'a##b#',
    'two  spaces ',
    `it's "q" $HOME ; ~ \\ {x} %if`,
    'é漢😀',
  ])('runs the command in the folder named %j, read as no format', async (folderName) => {
    const hostile = join(folder, folderName);
    mkdirSync(hostile);

    expect((await surroundingsOf('hostile', { folder: hostile })).folder).toBe(hostile);
  });

  it('runs a command whose name begins with a hyphen, found on the PATH set', async () => {
    const tools = join(folder, 'tools');
    mkdirSync(tools);
    writeFileSync(join(tools, '-tool'), '#!/bin/sh\necho "ran $1"\nexec cat\n');
    chmodSync(join(tools, '-tool'), 0o755);

    await start('hyphen', '-tool', ['-u'], {
      environment: { set: { PATH: `${tools}:${process.env.PATH}` }, remove: [] },
    });

    await expectScreen('hyphen', 'ran -u');
  });

  it('passes every argument as it is, with no shell reading it', async () => {
    const args = [
      'a;',
      ';',
      '$HOME',
      `it's "q"`,
      'back\\;',
      '-d',
      '#{pane_pid}',
      '',
      'é漢😀',
      '~',
      '%if',
    ];

    await startScript('args', 'for word; do printf "[%s]\\n" "$word"; done; exec cat', ...args);

    await expectScreen('args', args.map((word) => `[${word}]`).join('\n'));
  });

  it('passes an argument of several lines, and a long one', async () => {
    const long = 'x'.repeat(100_000);

    await startScript(
      'long',
      'printf "%s|" "$1"; printf %s "$2" | wc -c; exec cat',
      'one\n%if\n#two',
      long,
    );

    await expectScreen('long', 'one\n%if\n#two|100000');
  });

  it('runs a command of one word without a shell', async () => {
    const tool = join(folder, 'my tool; echo shell');
    writeFileSync(tool, '#!/bin/sh\necho ran-it\nexec cat\n');
    chmodSync(tool, 0o755);

    await start('one-word', tool, []);

    await expectScreen('one-word', 'ran-it');
    expect(await screenOf('one-word')).not.toContain('shell');
  });

  it('makes the command the session’s process, with no process in between', async () => {
    await startScript('pid', 'echo "pid=$$"; exec cat');

    const sessionProcess = await host.processOf('pid');

    await expectScreen('pid', `pid=${sessionProcess?.pid}`);
    expect(isRunning(sessionProcess?.pid ?? 0)).toBe(true);
  });

  it('sets the variables given and removes the ones named', async () => {
    const print = `echo "set=$SET_ONE|$SET_TWO|"; echo "inherited=\${${INHERITED}-removed}"; exec cat`;

    await startScript('kept', print);
    await start('changed', 'sh', ['-c', print], {
      environment: {
        set: { SET_ONE: `a b;'c' $HOME`, SET_TWO: 'é=1' },
        remove: [INHERITED, 'NOT_SET'],
      },
    });

    await expectScreen('kept', 'set=||\ninherited=inherited');
    await expectScreen('changed', `set=a b;'c' $HOME|é=1|\ninherited=removed`);
  });

  it('gives the environment of this process as it is now, not the server’s', async () => {
    await host.shutDown();
    withProcessVariables({ COCKPIT_STALE: 'stale', COCKPIT_KEPT: 'kept' });
    await start('born', 'cat', []);
    delete process.env.COCKPIT_STALE;
    withProcessVariables({ COCKPIT_NEW: 'new', COCKPIT_KEPT: 'changed' });

    const { environment } = await surroundingsOf('later');

    expect(environment.COCKPIT_NEW).toBe('new');
    expect(environment.COCKPIT_KEPT).toBe('changed');
    expect(environment).not.toHaveProperty('COCKPIT_STALE');
  });

  it('gives exactly this process’s environment, the variables set, none removed', async () => {
    const hostile = {
      NEWLINES: 'a\nb\n#c\nFAKE=1\n',
      HASHES: '#{pid} #(id) ##',
      DOLLARS: '$HOME $X $(id)',
      QUOTES: `'"\`\\`,
      EQUALS: '=a=b=',
      EMPTY: '',
      OTHERS: '~ a;b; %if {x} é漢😀',
    };
    const large = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [`COCKPIT_LARGE_${index}`, 'v'.repeat(1000)]),
    );
    withProcessVariables({ ...large, 'cockpit.odd-name': 'odd', COCKPIT_REMOVED: 'x' });
    const set = { ...hostile, PATH: `/cockpit/first:${process.env.PATH}`, HOME: '/cockpit/home' };
    const remove = ['COCKPIT_REMOVED', 'LANG', 'NOT_SET'];

    const { environment } = await surroundingsOf('exact', { environment: { set, remove } });

    expect(without(environment, PANE_VARIABLES)).toEqual(
      without({ ...process.env, PWD: folder, ...set }, [...PANE_VARIABLES, ...remove, 'OLDPWD']),
    );
  });

  it('gives a session without a PATH none, and removes even what tmux sets', async () => {
    const { environment } = await surroundingsOf('bare', {
      environment: { set: {}, remove: ['PATH', 'TERM_PROGRAM'] },
    });

    expect(environment).not.toHaveProperty('PATH');
    expect(environment).not.toHaveProperty('TERM_PROGRAM');
  });

  it('sets the variables of the session’s terminal itself', async () => {
    const { environment } = await surroundingsOf('terminal', {
      environment: { set: { TERM: 'dumb', TMUX: 'other' }, remove: [] },
    });

    expect(environment.TERM).toBe(paneTerminalType);
    expect(environment.TMUX).toContain(socketNameFor(appName));
    expect(environment.TMUX_PANE).toMatch(/^%\d+$/);
    expect(environment.TERM_PROGRAM).toBe('tmux');
  });

  it('keeps the environments of sessions started together apart', async () => {
    const started = Array.from({ length: 8 }, (_, index) => {
      // A start takes this process's environment as it is when called.
      process.env.COCKPIT_WHO = `process-${index}`;
      return surroundingsOf(`together-${index}`, {
        environment: { set: { WHO: `set-${index}`, [`ONLY_${index}`]: '1' }, remove: [] },
      });
    });
    withProcessVariables({ COCKPIT_WHO: 'after' });

    const environments = (await Promise.all(started)).map(({ environment }) => environment);

    for (const [index, environment] of environments.entries()) {
      expect(environment.COCKPIT_WHO).toBe(`process-${index}`);
      expect(environment.WHO).toBe(`set-${index}`);
      expect(Object.keys(environment).filter((name) => name.startsWith('ONLY_'))).toEqual([
        `ONLY_${index}`,
      ]);
    }
  });

  it('shows no value of the environment in any process’s arguments', async () => {
    const secret = `cockpit-secret-${process.pid}-${Date.now()}`;
    withProcessVariables({ COCKPIT_SECRET: `process-${secret}` });
    let shown = false;
    let starting = true;

    const started = surroundingsOf('secret', {
      environment: { set: { TOKEN: `set-${secret}` }, remove: [] },
    }).finally(() => {
      starting = false;
    });
    while (starting) {
      shown ||= someProcessArgumentHolds(secret);
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect((await started).environment.TOKEN).toBe(`set-${secret}`);
    expect(shown || someProcessArgumentHolds(secret)).toBe(false);
  });

  it('fails as the host’s own failure when the server cannot be reached', async () => {
    const far = join(folder, 'd'.repeat(120));
    mkdirSync(far);
    withProcessVariables({ TMUX_TMPDIR: far });

    await expectFailure(start('unreachable', 'cat', []), 'host-failed');
    await expectFailure(host.list(), 'host-failed');
    await expectFailure(host.isLive('unreachable'), 'host-failed');
  });

  it('refuses a name that lives, and starts no second session', async () => {
    await startScript('twice', 'echo first; exec cat');

    await expectFailure(startScript('twice', 'echo second; exec cat'), 'session-exists');

    expect(await host.list()).toEqual(['twice']);
    await expectScreen('twice', 'first');
  });

  it('refuses a folder that is no directory, instead of running elsewhere', async () => {
    const file = join(folder, 'a-file');
    writeFileSync(file, '');

    await expectFailure(start('lost', 'cat', [], { folder: join(folder, 'missing') }), 'no-folder');
    await expectFailure(start('lost', 'cat', [], { folder: file }), 'no-folder');

    expect(await host.isLive('lost')).toBe(false);
  });

  it('takes the longest argument and variable the system executes a command with', async () => {
    const longest = 128 * 1024 - 1;
    const variable = 'v'.repeat(longest - 'LONGEST='.length);

    await start(
      'longest',
      'sh',
      ['-c', 'printf %s "$1$LONGEST" | wc -c; exec cat', 'sh', 'a'.repeat(longest)],
      { environment: { set: { LONGEST: variable }, remove: [] } },
    );

    await expectScreen('longest', String(longest + variable.length));
  });

  it.each([
    ['an argument', { args: ['-c', 'exec cat', 'sh', 'a'.repeat(128 * 1024)] }],
    ['a variable', { environment: { set: { LONG: 'v'.repeat(128 * 1024) }, remove: [] } }],
  ])(
    'fails for %s too long to execute a command with, and starts no session',
    async (_what, changes) => {
      await expectFailure(start('too-long', 'sh', ['-c', 'exec cat'], changes), 'host-failed');

      expect(await host.list()).toEqual([]);
    },
  );

  it('fails for a variable of this process too long to execute a command with', async () => {
    withProcessVariables({ COCKPIT_HOST_TEST_LONG: 'v'.repeat(128 * 1024) });

    await expectFailure(start('too-long', 'cat', []), 'host-failed');
  });

  it('refuses what cannot be a session, before running anything', async () => {
    await expect(start('a.b', 'cat', [])).rejects.toThrow(TypeError);
    await expect(start('relative', 'cat', [], { folder: 'somewhere' })).rejects.toThrow(TypeError);
    await expect(start('sized', 'cat', [], { size: { columns: 0, rows: 0 } })).rejects.toThrow(
      RangeError,
    );

    expect(await host.list()).toEqual([]);
  });
});

describe('the sessions of the host', () => {
  it('are listed by name, and each found live by its exact name', async () => {
    await start('chapter-1', 'cat', []);
    await start('chapter-10', 'cat', []);

    expect((await host.list()).sort()).toEqual(['chapter-1', 'chapter-10']);
    expect(await host.isLive('chapter-1')).toBe(true);
    expect(await host.isLive('chapter')).toBe(false);
    expect(await host.processOf('chapter')).toBeUndefined();
  });

  it('lose a session when its command exits', async () => {
    await start('stays', 'cat', []);
    await startScript('exits', 'read line; exit 3');
    const exiting = await host.processOf('exits');

    await host.sendKeys('exits', ['Enter']);

    await eventually(async () => expect(await host.isLive('exits')).toBe(false));
    expect(await host.processOf('exits')).toBeUndefined();
    expect(await host.list()).toEqual(['stays']);
    expect(isRunning(exiting?.pid ?? 0)).toBe(false);
  });

  it('lose at once a session whose command cannot be run, its start not failing', async () => {
    const notExecutable = join(folder, 'not-executable');
    writeFileSync(notExecutable, '#!/bin/sh\nexec cat\n');
    await start('stays', 'cat', []);

    await start('no-command', 'cockpit-no-such-command', []);
    await start('no-permission', notExecutable, []);

    await eventually(async () => expect(await host.list()).toEqual(['stays']));
  });

  it('kill a session with its process, and say so; a second kill finds it gone', async () => {
    await start('stays', 'cat', []);
    await start('victim', 'cat', []);
    const victim = await host.processOf('victim');

    expect(await host.kill('victim')).toBe('killed');

    expect(await host.kill('victim')).toBe('gone');
    expect(await host.isLive('victim')).toBe(false);
    expect(await host.isLive('stays')).toBe(true);
    await eventually(() => expect(isRunning(victim?.pid ?? 0)).toBe(false));
  });

  it('refuse to type into a session that is gone, others still living', async () => {
    await start('stays', 'cat', []);

    await expectFailure(host.sendText('gone', 'x', pacing), 'no-session');
    await expectFailure(host.readScreen('gone'), 'no-session');
    await expectFailure(host.countAttached('gone'), 'no-session');
    await expectFailure(host.attach('gone', size), 'no-session');
  });
});

describe('typing text', () => {
  it.each([
    ['separators and quotes', `a;b ; ;; "q" 'q' \`x\` $HOME \\ \\; #{pane_pid} ~ %if {x}`],
    ['a leading hyphen', '-l --flag -t =x'],
    ['a final semicolon', 'done;'],
    ['a final backslash and semicolon', 'done\\;'],
    ['only a semicolon', ';'],
    ['Unicode', 'tiếng Việt é漢字 😀👩‍👩‍👧 ⁣ end'],
    ['line breaks and a tab', 'one\ntwo\r\tthree'],
  ])('types %s exactly', async (_what, text) => {
    const file = await startRecorder('typed');

    await host.sendText('typed', text, pacing);

    await expectRecorded(file, text);
  });

  it('types a long text exactly, across many writes', async () => {
    const text = Array.from({ length: 400 }, (_, index) => `${index}:é;😀\\;`).join(' ');
    const file = await startRecorder('typed');

    await host.sendText('typed', text, pacing);

    await expectRecorded(file, text);
  });

  it('types exactly when every write ends with a semicolon', async () => {
    const text = 'ab;'.repeat(20);
    const file = await startRecorder('typed');

    await host.sendText('typed', text, { chunkLength: 3, pauseMs: 0 });

    await expectRecorded(file, text);
  });

  it('pauses between two writes, not before the first nor after the last', async () => {
    const file = await startRecorder('typed');
    const pauseMs = 300;

    const startedAt = performance.now();
    await host.sendText('typed', 'abc', { chunkLength: 1, pauseMs });
    const elapsed = performance.now() - startedAt;

    await expectRecorded(file, 'abc');
    expect(elapsed).toBeGreaterThanOrEqual(2 * pauseMs - 5);
  });

  it('types nothing for an empty text', async () => {
    const file = await startRecorder('typed');

    await host.sendText('typed', '', pacing);
    await host.sendText('typed', '.', pacing);

    await expectRecorded(file, '.');
  });

  it('refuses a write of no character', async () => {
    await start('typed', 'cat', []);

    await expect(host.sendText('typed', 'x', { chunkLength: 0, pauseMs: 0 })).rejects.toThrow(
      RangeError,
    );
  });
});

describe('pressing keys and sending bytes', () => {
  it('presses named keys, in order', async () => {
    const file = await startRecorder('keys');

    await host.sendKeys('keys', ['Enter', 'Escape', 'C-u', 'Up', 'BSpace', 'Tab', 'C-e', 'M-x']);

    await expectRecorded(file, '\r\x1b\x15\x1b[A\x7f\t\x05\x1bx');
  });

  it('refuses a key it does not know, typing nothing', async () => {
    const file = await startRecorder('keys');

    await expect(host.sendKeys('keys', ['Enter', 'Bogus'])).rejects.toThrow(TypeError);
    await expect(host.sendKeys('keys', ['Enter', 'C-;'])).rejects.toThrow(TypeError);
    await expect(host.sendKeys('keys', ['M-;', 'Enter'])).rejects.toThrow(TypeError);
    await host.sendKeys('keys', ['Space']);

    await expectRecorded(file, ' ');
  });

  it('sends bytes as they are', async () => {
    const bytes = Uint8Array.of(0x1b, 0x0d, 0x00, 0x41, 0x80, 0xff, 0xc3, 0xa9, 0x3b);
    const file = await startRecorder('bytes');

    await host.sendBytes('bytes', bytes);

    await expectRecordedBytes(file, bytes);
  });

  it('sends many bytes, in order', async () => {
    const bytes = Uint8Array.from({ length: 3000 }, (_, index) => index % 256);
    const file = await startRecorder('bytes');

    await host.sendBytes('bytes', bytes);

    await expectRecordedBytes(file, bytes);
  });
});

describe('reading the screen', () => {
  it('gives the visible rows, blank ones included, without trailing blanks', async () => {
    await startScript('screen', 'printf "one  \\n\\n  three\\n"; exec cat');

    await expectScreen('screen', 'three');

    const screen = await host.readScreen('screen');
    expect(screen.inCopyMode).toBe(false);
    expect(screen.text.split('\n')).toEqual(['one', '', '  three', ...Array(27).fill('')]);
  });
});

describe('a session scrolled back by a person', () => {
  it('is seen in copy-mode', async () => {
    await start('scrolled', 'cat', []);

    await enterCopyMode('scrolled');

    expect((await host.readScreen('scrolled')).inCopyMode).toBe(true);
  });

  it.each([
    ['text', (name: string) => host.sendText(name, 'q', pacing), 'q'],
    ['keys', (name: string) => host.sendKeys(name, ['Enter']), '\r'],
    ['bytes', (name: string) => host.sendBytes(name, Uint8Array.of(0x71)), 'q'],
  ])(
    'leaves copy-mode before sending %s, which reach the program',
    async (_what, send, received) => {
      const file = await startRecorder('scrolled');
      await enterCopyMode('scrolled');

      await send('scrolled');

      await expectRecorded(file, received);
      expect((await host.readScreen('scrolled')).inCopyMode).toBe(false);
    },
  );
});

describe('an attached terminal', () => {
  it('receives what the session draws', async () => {
    await startScript('drawn', 'read line; echo "hello from the pane"; exec cat');
    const attachment = await attach('drawn');
    const output = outputOf(attachment);

    await host.sendKeys('drawn', ['Enter']);

    await eventually(() => expect(output.text).toContain('hello from the pane'));
  });

  it('sends what is written to the session’s program', async () => {
    const file = await startRecorder('written');
    const attachment = await attach('written');

    attachment.write('typed é\r');

    await expectRecorded(file, 'typed é\r');
  });

  it('takes input as soon as it is attached, every time', async () => {
    const file = await startRecorder('at-once');
    let written = '';

    for (let index = 0; index < 25; index += 1) {
      const attachment = await attach('at-once');
      attachment.write(`<${index}>`);
      written += `<${index}>`;
      // In order: the next terminal writes once this one's input has arrived.
      await expectRecorded(file, written);
    }

    expect(await host.countAttached('at-once')).toBe(25);
  });

  it('passes a Ctrl+C written at once on to the program, and stays attached', async () => {
    const file = await startRecorder('interrupted');

    const attachment = await attach('interrupted');
    attachment.write('\x03');

    await expectRecorded(file, '\x03');
    expect(await host.countAttached('interrupted')).toBe(1);
  });

  it('gives the session its size, and its new size when resized', async () => {
    await start('sized', 'cat', []);
    const rows = async () => (await screenOf('sized')).split('\n').length;

    const attachment = await attach('sized', { columns: 90, rows: 25 });
    await eventually(async () => expect(await rows()).toBe(25));

    attachment.resize({ columns: 60, rows: 20 });
    await eventually(async () => expect(await rows()).toBe(20));
  });

  it('stops giving output to a listener that left', async () => {
    await startScript('quiet', 'read line; echo marker; exec cat');
    const attachment = await attach('quiet');
    const heard = { text: '' };
    const stop = attachment.onData((data) => {
      heard.text += data;
    });
    const output = outputOf(attachment);

    stop();
    const silenceBegan = heard.text;
    await host.sendKeys('quiet', ['Enter']);

    await eventually(() => expect(output.text).toContain('marker'));
    expect(heard.text).toBe(silenceBegan);
  });

  it('ends when detached, the session living on', async () => {
    await start('left', 'cat', []);
    const attachment = await attach('left');
    let ended = false;
    attachment.onEnd(() => {
      ended = true;
    });

    await attachment.detach();

    expect(ended).toBe(true);
    expect(await host.isLive('left')).toBe(true);
    expect(await host.countAttached('left')).toBe(0);
  });

  it('ends when its session is killed', async () => {
    await start('stays', 'cat', []);
    await start('killed', 'cat', []);
    const attachment = await attach('killed');
    const end = new Promise<void>((resolve) => attachment.onEnd(resolve));

    await host.kill('killed');

    await end;
  });

  it('after its end, tells a late listener, and ignores writes, resizes and detaches', async () => {
    await start('over', 'cat', []);
    const attachment = await attach('over');
    await attachment.detach();
    let told = 0;
    const stop = attachment.onEnd(() => {
      told += 1;
    });
    stop();

    await new Promise<void>((resolve) => attachment.onEnd(resolve));
    attachment.write('ignored');
    attachment.resize({ columns: 50, rows: 10 });
    await attachment.detach();

    expect(told).toBe(0);
    expect(() => attachment.resize({ columns: 0, rows: 10 })).toThrow(RangeError);
  });
});

describe('counting attached terminals', () => {
  it('counts none, one, two, and one again after a detach', async () => {
    await start('counted', 'cat', []);
    await start('other', 'cat', []);
    const count = () => host.countAttached('counted');

    expect(await count()).toBe(0);

    const first = await attach('counted');
    expect(await count()).toBe(1);

    await attach('counted');
    await attach('other');
    expect(await count()).toBe(2);

    await first.detach();
    expect(await count()).toBe(1);
  });
});

describe('the host’s settings', () => {
  it('give the window the size of the terminal last used', async () => {
    await startRecorder('shared');
    const rows = async () => (await screenOf('shared')).split('\n').length;

    const large = await attach('shared', { columns: 100, rows: 30 });
    await eventually(async () => expect(await rows()).toBe(30));
    await attach('shared', { columns: 60, rows: 20 });
    await eventually(async () => expect(await rows()).toBe(20));

    large.write('x');

    await eventually(async () => expect(await rows()).toBe(30));
  });

  it('show the program’s screen on every row of the terminal, with no line of tmux’s', async () => {
    const terminal = { columns: 80, rows: 30 };
    await start('whole', 'sh', ['-c', 'stty size; exec cat'], { size: terminal });

    await attach('whole', terminal);
    await host.sendText('whole', 'typed\n', pacing);

    await expectScreen('whole', 'typed\ntyped');
    expect(await screenOf('whole')).toContain('30 80');
    expect((await screenOf('whole')).split('\n')).toHaveLength(30);
  });

  it('pass 24-bit colors on to the terminal as they are', async () => {
    await startScript('colored', 'read line; printf "\\033[38;2;1;2;3mcolored"; exec cat');
    const attachment = await attach('colored');
    const output = outputOf(attachment);

    await host.sendKeys('colored', ['Enter']);

    await eventually(() => expect(output.text).toContain('colored'));
    expect(output.text).toContain('38;2;1;2;3');
  });

  it('pass Esc on to the program without waiting for a key after it', async () => {
    const file = await startRecorder('escaped');
    const attachment = await attach('escaped');

    attachment.write('\x1b');

    await expectRecorded(file, '\x1b');
    // By default tmux waits half a second, to tell Esc from a key that begins
    // with it. The wait changes when the byte arrives and nothing else, and a
    // bound on the clock fails on a busy machine: the option itself is read.
    expect(serverOption('escape-time')).toBe('0');
  });

  it('pass Ctrl+B on to the program: tmux takes no command from the terminal', async () => {
    const file = await startRecorder('prefixed');
    const attachment = await attach('prefixed');

    attachment.write('\x02c\x02d');

    await expectRecorded(file, '\x02c\x02d');
    expect(await host.countAttached('prefixed')).toBe(1);
  });

  it('scroll the session back when the wheel turns', async () => {
    await start('wheeled', 'cat', []);
    const attachment = await attach('wheeled');

    // What a terminal sends for the wheel turned up, over row 10, column 10.
    attachment.write('\x1b[<64;10;10M');

    await eventually(async () => expect((await host.readScreen('wheeled')).inCopyMode).toBe(true));
  });

  it('tell the program when its terminal gains or loses focus', async () => {
    const file = join(folder, 'focused.keys');
    // The program asks for focus reports, as an agent's TUI does.
    await startScript(
      'focused',
      'stty raw -echo; printf "\\033[?1004hready"; exec cat > "$1"',
      file,
    );
    await expectScreen('focused', 'ready');
    const attachment = await attach('focused');

    attachment.write('\x1b[O\x1b[I');

    // tmux may report the focus of the attaching terminal first.
    await eventually(() => expect(readFileSync(file, 'utf8').endsWith('\x1b[O\x1b[I')).toBe(true));
  });

  it('pass a copy made by the program on to the terminal', async () => {
    await startScript('copied', 'read line; printf "\\033]52;c;aGVsbG8=\\a"; exec cat');
    const attachment = await attach('copied');
    const output = outputOf(attachment);

    await host.sendKeys('copied', ['Enter']);

    await eventually(() => expect(output.text).toContain(';aGVsbG8='));
    expect(output.text).toContain('\x1b]52;');
  });
});

describe('an app with a long name in another script', () => {
  it('has a host of its own, on a socket whose path fits', async () => {
    const other = createTmuxSessionHost({ appName: 'Ứng dụng của tôi — '.repeat(40) });
    try {
      await other.start({
        name: 'long',
        folder,
        command: 'cat',
        args: [],
        environment: { set: {}, remove: [] },
        size,
      });

      expect(await other.list()).toEqual(['long']);
      expect(await host.list()).toEqual([]);
    } finally {
      await other.shutDown();
    }
  });
});

describe('shutting the host down', () => {
  const socketPath = join(
    process.env.TMUX_TMPDIR ?? '/tmp',
    `tmux-${process.getuid?.()}`,
    socketNameFor(appName),
  );

  it('ends every session, its process and its terminal, and leaves no socket', async () => {
    await start('one', 'cat', []);
    await start('two', 'cat', []);
    const one = await host.processOf('one');
    const attachment = await attach('one');
    const end = new Promise<void>((resolve) => attachment.onEnd(resolve));
    expect(existsSync(socketPath)).toBe(true);

    await host.shutDown();

    expect(await host.list()).toEqual([]);
    expect(existsSync(socketPath)).toBe(false);
    await end;
    await eventually(() => expect(isRunning(one?.pid ?? 0)).toBe(false));
  });

  it('removes the socket a server left when it ended with its last session', async () => {
    await start('last', 'cat', []);
    await host.kill('last');
    await eventually(() =>
      expect(
        spawnSync('tmux', [...connectionArguments(socketNameFor(appName)), 'has-session'], {
          encoding: 'utf8',
        }).stderr,
      ).toMatch(/^no server running on /),
    );
    expect(existsSync(socketPath)).toBe(true);

    await host.shutDown();

    expect(existsSync(socketPath)).toBe(false);
  });

  it('leaves nothing either when no server runs, and the host starts sessions again', async () => {
    await host.shutDown();
    await host.shutDown();
    expect(existsSync(socketPath)).toBe(false);

    await startScript('again', 'echo back; exec cat');

    await expectScreen('again', 'back');
  });
});
