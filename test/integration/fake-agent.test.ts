import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionHost } from '../../src/server/session-host/session-host.ts';
import { createTmuxSessionHost } from '../../src/server/session-host/tmux-session-host.ts';
import { eventually } from '../support/eventually.ts';
import {
  type HookReceiver,
  RECEIVER_AUTHORIZATION,
  type ReceivedHook,
  startHookReceiver,
} from '../support/fake-agent/hook-receiver.ts';
import { fakeAgentCommand } from '../support/fake-agent/launching.ts';
import { type Question, type Turn, writeScript } from '../support/fake-agent/script.ts';
import { holdStart, releaseStart } from '../support/fake-agent/start-gate.ts';
import {
  INTERRUPTED,
  INTERRUPTED_FOR_TOOL_USE,
  transcriptPathFor,
} from '../support/fake-agent/transcript.ts';

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

async function launch(options: Launch = {}): Promise<Session> {
  sessions += 1;
  const name = `session-${sessions}`;
  const folder = options.resume?.folder ?? join(root, name);
  const id = options.resume?.id ?? randomUUID();
  mkdirSync(folder, { recursive: true });
  if (options.script) writeScript(folder, options.script);
  if (options.heldStart) holdStart(folder);
  const settingsFile = join(root, `${name}.settings.json`);
  writeFileSync(settingsFile, JSON.stringify(receiver.settings()));

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
    const session = await launch({ prompt: 'hello' });

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
    await launch({ prompt: 'hello', mode: 'acceptEdits' });

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
    const session = await launch({ prompt: 'hello from the command line' });

    const taken = await receiver.next('UserPromptSubmit');

    expect(taken.payload).toMatchObject({
      session_id: session.id,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'hello from the command line',
    });
  });

  it('submits a line typed after SessionStart and ended with Enter (behaviors 4, 5)', async () => {
    const session = await launchReady();

    await type(session, 'hello from the keyboard');

    const taken = await receiver.next('UserPromptSubmit');
    expect(taken.payload).toMatchObject({ prompt: 'hello from the keyboard' });
  });

  it('loses the Enter of keys typed before SessionStart; a later Enter submits them (behavior 4)', async () => {
    const session = await launch({ heldStart: true });

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
    expect(receiver.events()).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop']);
  });

  it('shows on its screen its state and the last prompt', async () => {
    const session = await launchReady({ script: [[{ do: 'stay-busy' }]] });
    await expectScreen(session, `session: ${session.id}`, 'state: idle', 'prompt: none\n>');

    await type(session, 'work on it');

    await expectScreen(session, 'state: busy', 'prompt: "work on it"');
  });

  it('shows a script it cannot play, and takes no prompt with it', async () => {
    const session = await launchReady({ script: [[]] });

    await type(session, 'hello');

    await expectScreen(session, 'state: idle', 'problem: turn 1 has no step');
    expect(receiver.events()).toEqual(['SessionStart']);
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

  it('runs the tool with no ask in a mode that asks for none', async () => {
    await launch({ script, prompt: 'touch it', mode: 'acceptEdits' });

    await receiver.next('Stop');

    expect(receiver.events()).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'Stop',
    ]);
  });
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

  it('answered in the terminal, reports the answers in PostToolUse (behavior 46)', async () => {
    receiver.hold('PermissionRequest');
    const session = await launch({ script, prompt: 'ask me' });
    await receiver.next('PermissionRequest');
    await expectScreen(session, 'dialog: question AskUserQuestion');

    await host.sendKeys(session.name, ['Enter']);

    const after = await receiver.next('PostToolUse');
    expect(after.payload).toMatchObject({
      tool_response: { answers: { 'Which fruit?': 'Mango' } },
    });
  });

  it('is denied at once in dontAsk when PreToolUse does not answer it (behavior 47)', async () => {
    await launch({ script, prompt: 'ask me', mode: 'dontAsk' });

    await receiver.next('Stop');

    expect(receiver.events()).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop']);
  });
});

describe('the fake agent: an interruption', () => {
  it('ends the turn on Esc with no hook, records the marker, and takes prompts again (behavior 6)', async () => {
    const script: Turn[] = [[{ do: 'stay-busy' }], [{ do: 'reply', text: 'Back.' }]];
    const session = await launch({ script, prompt: 'work' });
    const taken = await receiver.next('UserPromptSubmit');
    await expectScreen(session, 'state: busy');

    await host.sendKeys(session.name, ['Escape']);

    await expectScreen(session, 'state: idle');
    expect(transcriptOf(taken)).toContain(`"${INTERRUPTED}"`);
    await type(session, 'again');
    const end = await receiver.next('Stop');
    expect(end.payload).toMatchObject({ last_assistant_message: 'Back.' });
    expect(receiver.events()).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'UserPromptSubmit',
      'Stop',
    ]);
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
    const session = await launchReady();

    await host.sendKeys(session.name, ['Escape']);
    await type(session, 'hello');

    await receiver.next('Stop');
    expect(receiver.events()).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop']);
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

  it('on kill -9, ends with no SessionEnd, and the tmux session is gone (behavior 8)', async () => {
    const session = await launchReady();

    process.kill(await pidOf(session), 'SIGKILL');

    await expectGone(session);
    expect(receiver.events()).toEqual(['SessionStart']);
  });
});
