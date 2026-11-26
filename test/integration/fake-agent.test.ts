import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionHost } from '../../src/server/session-host/session-host.ts';
import { createTmuxSessionHost } from '../../src/server/session-host/tmux-session-host.ts';
import { eventually } from '../support/eventually.ts';
import { fakeAgentCommand } from '../support/fake-agent/launching.ts';
import { type Question, type Turn, writeScript } from '../support/fake-agent/script.ts';
import { holdStart, releaseStart } from '../support/fake-agent/start-gate.ts';
import {
  INTERRUPTED,
  INTERRUPTED_FOR_TOOL_USE,
  transcriptPathFor,
} from '../support/fake-agent/transcript.ts';
import {
  type HookReceiver,
  RECEIVER_AUTHORIZATION,
  type ReceivedHook,
  startHookReceiver,
} from '../support/hooks/hook-receiver.ts';

const appName = `fake-agent-test-${process.pid}-${Date.now()}`;
const pacing = { chunkLength: 200, pauseMs: 1 };

const touch = { do: 'tool', name: 'Bash', input: { command: 'touch a.txt' } } as const;
const fruit: Question = {
  question: 'Which fruit?',
  header: 'Fruit',
  options: [
    { label: 'Mango', description: 'Sweet.' },
    { label: 'Lime', description: 'Sour.' },
  ],
  multiSelect: false,
};
/** The script of a session that is given one prompt and answers it. */
const oneReply: Turn[] = [[{ do: 'reply', text: 'Done.' }]];
const askFruit = { do: 'question', questions: [fruit] } as const;
const fruitAnswered = { questions: [fruit], answers: { 'Which fruit?': 'Lime' } };

let host: SessionHost;
let root: string;
let configFolder: string;
let receiver: HookReceiver;
let sessions = 0;

beforeAll(() => {
  host = createTmuxSessionHost({ appName });
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-fake-agent-')));
  configFolder = join(root, 'config');
});

beforeEach(async () => {
  receiver = await startHookReceiver();
});

afterEach(async () => {
  for (const name of await host.list()) await host.kill(name);
  await receiver.close();
});

afterAll(async () => {
  await host.shutDown();
  rmSync(root, { recursive: true, force: true });
});

/** A session of the fake agent, as a test knows it. */
interface Session {
  readonly name: string;
  readonly id: string;
  readonly folder: string;
}

/** What a test chooses about a launch; the rest is as the cockpit would launch Claude Code. */
interface Launch {
  /** The turns the agent plays, one a prompt. */
  readonly script?: readonly Turn[];
  /** The prompt on the command line. */
  readonly prompt?: string;
  readonly mode?: string;
  /** The session whose conversation is resumed, in its folder. */
  readonly resume?: Session;
  /** Whether the agent stays before SessionStart until the test releases its start. */
  readonly heldStart?: boolean;
  /** Variables the agent must not see. */
  readonly without?: readonly string[];
}

/** Makes the folder of a new session, with its script, and its settings file. */
function prepare(script: readonly Turn[] | undefined, settings: string, resumedIn?: string) {
  sessions += 1;
  const name = `session-${sessions}`;
  const folder = resumedIn ?? join(root, name);
  mkdirSync(folder, { recursive: true });
  if (script) writeScript(folder, script);
  const settingsFile = join(root, `${name}.settings.json`);
  writeFileSync(settingsFile, settings);
  return { name, folder, settingsFile };
}

/** The settings a receiver gives, as far as a test picks events from them. */
interface ReceiverSettings {
  readonly hooks: Readonly<Record<string, unknown>>;
}

/** A fake agent run as a process of the test's own, with no terminal: for what a terminal hides, its exit. */
interface DirectRun {
  readonly process: ChildProcess;
  /** Fulfilled when the process has ended, with its status, what it wrote to its error output and all it drew. */
  readonly ended: Promise<{ status: number | null; errors: string; drawn: string }>;
}

function runDirectly(options: {
  script?: readonly Turn[];
  settings?: string;
  prompt?: string;
}): DirectRun {
  const { folder, settingsFile } = prepare(
    options.script,
    options.settings ?? JSON.stringify(receiver.settings()),
  );
  const agent = fakeAgentCommand();
  const child = spawn(
    agent.command,
    [
      ...agent.args,
      '--session-id',
      randomUUID(),
      '--settings',
      settingsFile,
      ...(options.prompt === undefined ? [] : ['--', options.prompt]),
    ],
    { cwd: folder, env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: configFolder } },
  );
  let errors = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    errors += chunk;
  });
  let drawn = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    drawn += chunk;
  });
  const ended = once(child, 'close').then(([status]) => ({
    status: status as number | null,
    errors,
    drawn,
  }));
  return { process: child, ended };
}

async function launch(options: Launch = {}): Promise<Session> {
  const { name, folder, settingsFile } = prepare(
    options.script,
    JSON.stringify(receiver.settings()),
    options.resume?.folder,
  );
  const id = options.resume?.id ?? randomUUID();
  if (options.heldStart) holdStart(folder);

  const agent = fakeAgentCommand();
  await host.start({
    name,
    folder,
    command: agent.command,
    args: [
      ...agent.args,
      options.resume ? '--resume' : '--session-id',
      id,
      '--settings',
      settingsFile,
      '--permission-mode',
      options.mode ?? 'default',
      ...(options.prompt === undefined ? [] : ['--', options.prompt]),
    ],
    environment: { set: { CLAUDE_CONFIG_DIR: configFolder }, remove: options.without ?? [] },
    size: { columns: 100, rows: 30 },
  });
  return { name, id, folder };
}

/** Launches a session and waits until it takes input. */
async function launchReady(options: Launch = {}): Promise<Session> {
  const session = await launch(options);
  await receiver.next('SessionStart');
  return session;
}

async function type(session: Session, line: string): Promise<void> {
  await host.sendText(session.name, line, pacing);
  await host.sendKeys(session.name, ['Enter']);
}

function expectScreen(session: Session, ...texts: string[]): Promise<void> {
  return eventually(async () => {
    const screen = (await host.readScreen(session.name)).text;
    for (const text of texts) expect(screen).toContain(text);
  });
}

function expectGone(session: Session): Promise<void> {
  return eventually(async () => expect(await host.isLive(session.name)).toBe(false));
}

async function pidOf(session: Session): Promise<number> {
  const running = await host.processOf(session.name);
  if (!running) throw new Error(`${session.name} does not live`);
  return running.pid;
}

function transcriptOf(hook: ReceivedHook): string {
  return readFileSync(hook.payload.transcript_path as string, 'utf8');
}

const allow = {
  hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
};

function deny(more: object = {}) {
  const decision = { behavior: 'deny', message: 'Not this file.', ...more };
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

describe('the fake agent: its start and its hooks', () => {
  it('fires SessionStart as a command hook, never as an HTTP hook, with the id of --session-id (behavior 1)', async () => {
    const session = await launch({ script: oneReply, prompt: 'hello' });

    const start = await receiver.next('SessionStart');
    await receiver.next('Stop');

    expect(start.via).toBe('command');
    expect(start.payload).toEqual({
      session_id: session.id,
      transcript_path: transcriptPathFor(configFolder, session.folder, session.id),
      cwd: session.folder,
      permission_mode: 'default',
      hook_event_name: 'SessionStart',
      source: 'startup',
    });
    expect(receiver.received.filter((hook) => hook.event === 'SessionStart')).toHaveLength(1);
  });

  it('posts its HTTP hooks with the headers the settings give them (behavior 14)', async () => {
    await launch({ script: oneReply, prompt: 'hello', mode: 'acceptEdits' });

    const taken = await receiver.next('UserPromptSubmit');

    expect(taken.via).toBe('http');
    expect(taken.headers.authorization).toBe(RECEIVER_AUTHORIZATION);
    expect(taken.payload).toMatchObject({ permission_mode: 'acceptEdits' });
  });

  it('resumed with --resume, keeps the session id and goes on with the conversation (behavior 3)', async () => {
    const script: Turn[] = [[{ do: 'reply', text: 'One.' }], [{ do: 'reply', text: 'Two.' }]];
    const first = await launch({ script, prompt: 'first' });
    await receiver.next('Stop');
    process.kill(await pidOf(first), 'SIGKILL');
    await expectGone(first);

    await launch({ resume: first, prompt: 'second' });
    await receiver.next('SessionStart');
    const start = await receiver.next('SessionStart');
    const end = await receiver.next('Stop');

    expect(start.payload).toMatchObject({ session_id: first.id, source: 'resume' });
    expect(end.payload).toMatchObject({ session_id: first.id, last_assistant_message: 'Two.' });
    expect(transcriptOf(end)).toContain('"first"');
  });

  it('resumed for a conversation that does not exist, exits at once with no SessionStart', async () => {
    const never = { name: 'never', id: randomUUID(), folder: join(root, 'never') };

    const session = await launch({ resume: never });

    await expectGone(session);
    expect(receiver.events()).toEqual([]);
  });

  it('refuses to start without a configuration folder of the test: it writes nowhere else', async () => {
    const session = await launch({ without: ['CLAUDE_CONFIG_DIR'] });

    await expectGone(session);
    expect(receiver.events()).toEqual([]);
  });
});

describe('the fake agent: taking a prompt', () => {
  it('submits the prompt that follows -- with no keys (behaviors 2, 5)', async () => {
    const session = await launch({ script: oneReply, prompt: 'hello from the command line' });

    const taken = await receiver.next('UserPromptSubmit');

    expect(taken.payload).toMatchObject({
      session_id: session.id,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'hello from the command line',
    });
  });

  it('submits a line typed after SessionStart and ended with Enter (behaviors 4, 5)', async () => {
    const session = await launchReady({ script: oneReply });

    await type(session, 'hello from the keyboard');

    const taken = await receiver.next('UserPromptSubmit');
    expect(taken.payload).toMatchObject({ prompt: 'hello from the keyboard' });
  });

  it('loses the Enter of keys typed before SessionStart; a later Enter submits them (behavior 4)', async () => {
    const session = await launch({ script: oneReply, heldStart: true });

    await type(session, 'early');
    await host.sendText(session.name, '!', pacing);
    await expectScreen(session, 'state: starting', '> early!');
    expect(receiver.events()).toEqual([]);
    releaseStart(session.folder);
    await receiver.next('SessionStart');
    await expectScreen(session, 'state: idle', '> early!');
    expect(receiver.events()).toEqual(['SessionStart']);
    await host.sendKeys(session.name, ['Enter']);

    const taken = await receiver.next('UserPromptSubmit');
    expect(taken.payload).toMatchObject({ prompt: 'early!' });
  });

  it('ends a turn with Stop, which carries the last message of the agent (behavior 7)', async () => {
    await launch({ script: [[{ do: 'reply', text: 'All done.' }]], prompt: 'hello' });

    const end = await receiver.next('Stop');

    expect(end.payload).toMatchObject({
      hook_event_name: 'Stop',
      last_assistant_message: 'All done.',
    });
    expect(receiver.events()).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'MessageDisplay',
      'Stop',
    ]);
  });

  it('tells MessageDisplay of a reply as its one and last part, and ends the turn without its answer', async () => {
    receiver.hold('MessageDisplay');
    const session = await launch({ script: oneReply, prompt: 'hello' });

    const shown = await receiver.next('MessageDisplay');
    const stop = await receiver.next('Stop');

    expect(shown.isOpen()).toBe(true);
    expect(shown.payload).toEqual({
      session_id: session.id,
      transcript_path: stop.payload.transcript_path,
      cwd: session.folder,
      hook_event_name: 'MessageDisplay',
      turn_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      message_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      index: 0,
      final: true,
      delta: 'Done.',
    });
    await expectScreen(session, 'state: idle');
  });

  it('goes on working when the address of its hooks does not answer (behavior 40)', async () => {
    const silent = await startHookReceiver();
    const { UserPromptSubmit, MessageDisplay } = (silent.settings() as ReceiverSettings).hooks;
    const { Stop } = (receiver.settings() as ReceiverSettings).hooks;
    const settings = { hooks: { UserPromptSubmit, MessageDisplay, Stop } };
    await silent.close();

    const run = runDirectly({
      script: oneReply,
      settings: JSON.stringify(settings),
      prompt: 'hello',
    });
    const stop = await receiver.next('Stop');
    run.process.kill('SIGTERM');

    expect(stop.payload.last_assistant_message).toBe('Done.');
    expect(receiver.events()).toEqual(['Stop']);
    expect((await run.ended).status).toBe(143);
  });

  it('shows on its screen its state and the last prompt', async () => {
    const session = await launchReady({ script: [[{ do: 'stay-busy' }]] });
    await expectScreen(session, `session: ${session.id}`, 'state: idle', 'prompt: none\n>');

    await type(session, 'work on it');

    await expectScreen(session, 'state: busy', 'prompt: "work on it"');
  });
});

describe('the fake agent: what it cannot play', () => {
  /** A session that fails ends without a word to the hooks: it is the test's fault, not a session's end. */
  async function expectFailed(session: Session, hooksSoFar: readonly string[]): Promise<void> {
    await expectGone(session);
    expect(receiver.events()).toEqual(hooksSoFar);
  }

  it('ends, failing, on a script it cannot read, and takes no prompt with it', async () => {
    const session = await launchReady({ script: [[]] });

    await type(session, 'hello');

    await expectFailed(session, ['SessionStart']);
  });

  it('ends, failing, on a prompt its script has no turn for: it invents no answer', async () => {
    const session = await launch({ script: oneReply, prompt: 'scripted' });
    await receiver.next('Stop');

    await type(session, 'not scripted');

    await expectFailed(session, ['SessionStart', 'UserPromptSubmit', 'MessageDisplay', 'Stop']);
  });

  it('ends, failing, on an Enter while a turn runs', async () => {
    const session = await launch({ script: [[{ do: 'stay-busy' }]], prompt: 'work' });
    await receiver.next('UserPromptSubmit');
    await expectScreen(session, 'state: busy');

    await type(session, 'and this too');

    await expectFailed(session, ['SessionStart', 'UserPromptSubmit']);
  });

  it('ends, failing, when a PreToolUse hook denies a call', async () => {
    receiver.hold('PreToolUse');
    const session = await launch({
      script: [[touch, { do: 'reply', text: 'Touched.' }]],
      prompt: 'touch it',
    });

    (await receiver.next('PreToolUse')).answer({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    });

    await expectFailed(session, ['SessionStart', 'UserPromptSubmit', 'PreToolUse']);
  });

  it('ends, failing, when a hook answers what it does not play: a Stop that keeps the turn from ending', async () => {
    receiver.hold('Stop');
    const session = await launch({ script: oneReply, prompt: 'hello' });

    (await receiver.next('Stop')).answer({ decision: 'block', reason: 'Go on.' });

    await expectFailed(session, ['SessionStart', 'UserPromptSubmit', 'MessageDisplay', 'Stop']);
  });

  it.each([
    [
      'a hook of a type it does not play',
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'Done?' }] }] } }),
      /a hook of type "prompt"/,
    ],
    ['settings that are no JSON', '{ "hooks": ', /settings that are no JSON/],
  ])(
    'refuses to start on %s, with the status of what it cannot play and no stack',
    async (_what, settings, problem) => {
      const { status, errors } = await runDirectly({ settings }).ended;

      expect(status).toBe(70);
      expect(errors).toMatch(problem);
      expect(errors.trim().split('\n')).toHaveLength(1);
      expect(receiver.events()).toEqual([]);
    },
  );

  it('ends, failing, when a hook fails: it does not guess what Claude Code makes of it', async () => {
    const settings = {
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'exit 3' }] }] },
    };

    const { status, drawn } = await runDirectly({ settings: JSON.stringify(settings) }).ended;

    expect(status).toBe(70);
    expect(drawn).toContain('a SessionStart command hook exited with status 3');
  });

  it('refuses to start on a hook with a field it does not play', async () => {
    const hook = { type: 'command', command: 'true', async: true };
    const settings = JSON.stringify({ hooks: { Stop: [{ hooks: [hook] }] } });

    const { status, errors } = await runDirectly({ settings }).ended;

    expect(status).toBe(70);
    expect(errors).toMatch(/the field "async" of a command hook/);
  });

  it('ends, failing, on a reply of several lines while MessageDisplay has a hook', async () => {
    const session = await launch({
      script: [[{ do: 'reply', text: 'One.\n\nTwo.' }]],
      prompt: 'hello',
    });

    await expectFailed(session, ['SessionStart', 'UserPromptSubmit']);
  });

  it('ends, failing, on a tool nothing tells the fate of in the mode of the session', async () => {
    const write = {
      do: 'tool',
      name: 'Write',
      input: { file_path: 'a.txt', content: '' },
    } as const;
    const session = await launch({
      script: [[write, { do: 'reply', text: 'Written.' }]],
      prompt: 'write it',
      mode: 'acceptEdits',
    });

    await expectFailed(session, ['SessionStart', 'UserPromptSubmit', 'PreToolUse']);
  });
});

describe('the fake agent: a tool that needs permission', () => {
  const script: Turn[] = [[touch, { do: 'reply', text: 'Touched.' }]];

  it('shows its dialog while PermissionRequest waits; an allow runs the tool (behavior 9)', async () => {
    receiver.hold('PermissionRequest');
    const session = await launch({ script, prompt: 'touch it' });

    const before = await receiver.next('PreToolUse');
    const ask = await receiver.next('PermissionRequest');
    await expectScreen(session, 'state: waiting', 'dialog: permission Bash');
    ask.answer(allow);
    const after = await receiver.next('PostToolUse');
    await receiver.next('Stop');

    expect(before.payload).toMatchObject({ tool_name: 'Bash', tool_input: touch.input });
    expect(ask.payload).toMatchObject({ tool_name: 'Bash', tool_input: touch.input });
    expect(ask.payload).not.toHaveProperty('tool_use_id');
    expect(after.payload.tool_use_id).toBe(before.payload.tool_use_id);
    await expectScreen(session, 'state: idle', 'dialog: none');
  });

  it('goes on with the turn, without the tool, on a deny (behavior 9)', async () => {
    receiver.hold('PermissionRequest');
    await launch({ script, prompt: 'touch it' });

    (await receiver.next('PermissionRequest')).answer(deny());
    const end = await receiver.next('Stop');

    expect(end.payload).toMatchObject({ last_assistant_message: 'Touched.' });
    expect(receiver.events()).not.toContain('PostToolUse');
  });

  it('runs the tool on a Yes in the terminal, and leaves the waiting hook open (behavior 10)', async () => {
    receiver.hold('PermissionRequest');
    const session = await launch({ script, prompt: 'touch it' });
    const before = await receiver.next('PreToolUse');
    const ask = await receiver.next('PermissionRequest');
    await expectScreen(session, 'dialog: permission Bash');

    await host.sendKeys(session.name, ['Enter']);

    const after = await receiver.next('PostToolUse');
    await receiver.next('Stop');
    expect(after.payload.tool_use_id).toBe(before.payload.tool_use_id);
    expect(ask.isOpen()).toBe(true);
  });

  it('leaves the dialog to the terminal when the hook gives no decision', async () => {
    const session = await launch({ script, prompt: 'touch it' });
    await receiver.next('PermissionRequest');
    await expectScreen(session, 'state: waiting', 'dialog: permission Bash');

    await host.sendKeys(session.name, ['Enter']);

    await receiver.next('PostToolUse');
  });

  it.each(['acceptEdits', 'plan', 'auto', 'bypassPermissions'])(
    'runs a touch with no ask in the %s mode',
    async (mode) => {
      await launch({ script, prompt: 'touch it', mode });

      await receiver.next('Stop');

      expect(receiver.events()).toEqual([
        'SessionStart',
        'UserPromptSubmit',
        'PreToolUse',
        'PostToolUse',
        'MessageDisplay',
        'Stop',
      ]);
    },
  );
});

describe('the fake agent: a question', () => {
  const script: Turn[] = [[askFruit, { do: 'reply', text: 'Noted.' }]];

  it('shows no dialog while PreToolUse for AskUserQuestion waits (behavior 12)', async () => {
    receiver.hold('PreToolUse');
    const session = await launch({ script, prompt: 'ask me' });

    const before = await receiver.next('PreToolUse');

    expect(before.payload).toMatchObject({
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [fruit] },
    });
    await expectScreen(session, 'state: busy', 'dialog: none');
    expect(receiver.events()).not.toContain('PermissionRequest');
  });

  it('is answered by a PreToolUse allow whose updatedInput has the answers (behavior 13)', async () => {
    receiver.hold('PreToolUse');
    await launch({ script, prompt: 'ask me' });

    (await receiver.next('PreToolUse')).answer({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: fruitAnswered,
      },
    });
    const after = await receiver.next('PostToolUse');
    await receiver.next('Stop');

    expect(after.payload).toMatchObject({
      tool_name: 'AskUserQuestion',
      tool_input: fruitAnswered,
      tool_response: { answers: { 'Which fruit?': 'Lime' } },
    });
    expect(receiver.events()).not.toContain('PermissionRequest');
  });

  it('asks in the terminal and through PermissionRequest when PreToolUse gives no decision (behaviors 12, 46)', async () => {
    receiver.hold('PermissionRequest');
    const session = await launch({ script, prompt: 'ask me' });

    const ask = await receiver.next('PermissionRequest');
    await expectScreen(session, 'state: waiting', 'dialog: question AskUserQuestion');
    ask.answer({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedInput: fruitAnswered },
      },
    });
    const after = await receiver.next('PostToolUse');

    expect(ask.payload).toMatchObject({ tool_name: 'AskUserQuestion' });
    expect(after.payload).toMatchObject({ tool_response: { answers: { 'Which fruit?': 'Lime' } } });
  });

  it('answered in the terminal, reports the answers in PostToolUse and leaves the hook open (behavior 46)', async () => {
    const drink: Question = { ...fruit, question: 'Which drink?', header: 'Drink' };
    receiver.hold('PermissionRequest');
    const session = await launch({
      script: [
        [
          { do: 'question', questions: [fruit, drink] },
          { do: 'reply', text: 'Noted.' },
        ],
      ],
      prompt: 'ask me',
    });
    const ask = await receiver.next('PermissionRequest');
    await expectScreen(session, 'dialog: question AskUserQuestion');

    await host.sendKeys(session.name, ['Enter']);

    const after = await receiver.next('PostToolUse');
    await receiver.next('Stop');
    expect(after.payload).toMatchObject({
      tool_input: { answers: { 'Which fruit?': 'Mango', 'Which drink?': 'Mango' } },
      tool_response: { answers: { 'Which fruit?': 'Mango', 'Which drink?': 'Mango' } },
    });
    expect(ask.isOpen()).toBe(true);
  });

  it('denies a tool at once, with no ask, in dontAsk', async () => {
    await launch({
      script: [[touch, { do: 'reply', text: 'Not touched.' }]],
      prompt: 'touch it',
      mode: 'dontAsk',
    });

    await receiver.next('Stop');

    expect(receiver.events()).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'MessageDisplay',
      'Stop',
    ]);
  });

  it('is denied at once in dontAsk when PreToolUse does not answer it (behavior 47)', async () => {
    await launch({ script, prompt: 'ask me', mode: 'dontAsk' });

    await receiver.next('Stop');

    expect(receiver.events()).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'MessageDisplay',
      'Stop',
    ]);
  });
});

describe('the fake agent: an interruption', () => {
  it('ends on Esc a turn that produced something, with no hook, records the marker, and takes prompts again (behaviors 6, 22)', async () => {
    const script: Turn[] = [[touch, { do: 'stay-busy' }], [{ do: 'reply', text: 'Back.' }]];
    const session = await launch({ script, prompt: 'work', mode: 'acceptEdits' });
    const ran = await receiver.next('PostToolUse');
    await expectScreen(session, 'state: busy');

    await host.sendKeys(session.name, ['Escape']);

    await expectScreen(session, 'state: idle', '\n>\n');
    expect(transcriptOf(ran)).toContain(`"${INTERRUPTED}"`);
    await type(session, 'again');
    const end = await receiver.next('Stop');
    expect(end.payload).toMatchObject({ last_assistant_message: 'Back.' });
    expect(receiver.events()).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'UserPromptSubmit',
      'MessageDisplay',
      'Stop',
    ]);
  });

  it('withdraws on Esc a prompt nothing was produced for: back in the input box, no hook, no marker (behavior 23)', async () => {
    const script: Turn[] = [[{ do: 'stay-busy' }], [{ do: 'reply', text: 'Back.' }]];
    const session = await launch({ script, prompt: 'think about it' });
    const taken = await receiver.next('UserPromptSubmit');
    await expectScreen(session, 'state: busy', 'prompt: "think about it"');

    await host.sendKeys(session.name, ['Escape']);

    await expectScreen(session, 'state: idle', 'prompt: none', '> think about it');
    expect(transcriptOf(taken)).not.toContain('interrupted');
    expect(receiver.events()).toEqual(['SessionStart', 'UserPromptSubmit']);
    await host.sendKeys(session.name, ['Enter']);
    const again = await receiver.next('UserPromptSubmit');
    expect(again.payload.prompt).toBe('think about it');
    await receiver.next('Stop');
  });

  it('closes on Esc the connection of the hook it holds, and fires no hook (behavior 11)', async () => {
    receiver.hold('PermissionRequest');
    const session = await launch({
      script: [[touch, { do: 'reply', text: 'Touched.' }]],
      prompt: 'touch it',
    });
    const ask = await receiver.next('PermissionRequest');
    await expectScreen(session, 'dialog: permission Bash');

    await host.sendKeys(session.name, ['Escape']);

    await ask.closedBySender;
    await expectScreen(session, 'state: idle', 'dialog: none');
    expect(transcriptOf(ask)).toContain(`"${INTERRUPTED_FOR_TOOL_USE}"`);
    expect(receiver.events()).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PermissionRequest',
    ]);
  });

  it('closes on Esc the PreToolUse hook of a question it holds (behavior 11)', async () => {
    receiver.hold('PreToolUse');
    const session = await launch({
      script: [[askFruit, { do: 'reply', text: 'Noted.' }]],
      prompt: 'ask me',
    });
    const before = await receiver.next('PreToolUse');

    await host.sendKeys(session.name, ['Escape']);

    await before.closedBySender;
    await expectScreen(session, 'state: idle');
  });

  it('is interrupted, as by Esc, by a deny that says so (behavior 26)', async () => {
    receiver.hold('PermissionRequest');
    const session = await launch({
      script: [[touch, { do: 'reply', text: 'Touched.' }]],
      prompt: 'touch it',
    });

    const ask = await receiver.next('PermissionRequest');
    ask.answer(deny({ interrupt: true }));

    await expectScreen(session, 'state: idle', 'dialog: none');
    expect(transcriptOf(ask)).toContain(`"${INTERRUPTED_FOR_TOOL_USE}"`);
    expect(receiver.events()).not.toContain('Stop');
  });

  it('does nothing on Esc when no turn runs', async () => {
    const session = await launchReady({ script: oneReply });

    await host.sendKeys(session.name, ['Escape']);
    await type(session, 'hello');

    await receiver.next('Stop');
    expect(receiver.events()).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'MessageDisplay',
      'Stop',
    ]);
  });
});

describe('the fake agent: an exit', () => {
  it('on a scripted exit, fires SessionEnd and ends, so the tmux session is gone (behavior 8)', async () => {
    const session = await launch({ script: [[{ do: 'exit' }]], prompt: 'leave' });

    const ends = [await receiver.next('SessionEnd'), await receiver.next('SessionEnd')];

    expect(ends.map((end) => end.via).sort()).toEqual(['command', 'http']);
    expect(ends[0]?.payload).toMatchObject({ session_id: session.id, reason: 'prompt_input_exit' });
    await expectGone(session);
  });

  it('on SIGTERM, fires SessionEnd with the reason "other" and ends, in the middle of a turn too', async () => {
    const session = await launch({ script: [[{ do: 'stay-busy' }]], prompt: 'work' });
    const taken = await receiver.next('UserPromptSubmit');

    process.kill(await pidOf(session), 'SIGTERM');

    const end = await receiver.next('SessionEnd');
    expect(end.payload).toMatchObject({ reason: 'other' });
    await expectGone(session);
    expect(transcriptOf(taken)).not.toContain(INTERRUPTED);
  });

  it('exits with success on a scripted exit, as Claude Code does when the person leaves', async () => {
    const run = runDirectly({ script: [[{ do: 'exit' }]], prompt: 'leave' });

    expect((await run.ended).status).toBe(0);
  });

  it('exits on SIGTERM with the status of the signal, 143, as Claude Code does', async () => {
    const run = runDirectly({});
    await receiver.next('SessionStart');

    run.process.kill('SIGTERM');

    expect((await run.ended).status).toBe(143);
    expect((await receiver.next('SessionEnd')).payload).toMatchObject({ reason: 'other' });
  });

  it('on kill -9, ends with no SessionEnd, and the tmux session is gone (behavior 8)', async () => {
    const session = await launchReady();

    process.kill(await pidOf(session), 'SIGKILL');

    await expectGone(session);
    expect(receiver.events()).toEqual(['SessionStart']);
  });
});
