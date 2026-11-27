import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { claudeCode } from '../../src/claude-code/index.ts';
import { readInputBox } from '../../src/claude-code/screen-reading.ts';
import {
  type Cockpit,
  type CockpitOptions,
  createCockpit,
  type Job,
} from '../../src/server/index.ts';
import type { SessionHost } from '../../src/server/session-host/session-host.ts';
import { createTmuxSessionHost } from '../../src/server/session-host/tmux-session-host.ts';
import type { Session } from '../../src/shared/session.ts';
import { writeAgentShim } from '../support/agent-shim.ts';
import { eventually } from '../support/eventually.ts';
import { fakeAgentCommand } from '../support/fake-agent/launching.ts';
import { writeScript } from '../support/fake-agent/script.ts';
import { holdTasks, releaseTasks } from '../support/fake-agent/tasks.ts';
import { startNodeHttpApp } from '../support/node-http-app.ts';
import { PATIENCE } from '../support/patience.ts';
import { agentConfiguration, FAKE_API_KEY } from '../support/real-agent/environment.ts';
import { findTranscript } from '../support/transcript-files.ts';
import { call, post } from '../support/wire-client.ts';

/**
 * The units of work through `createCockpit`, with the fake agent in tmux:
 * run, send and open in each state of a key's session, starting over, the
 * records across a restart, the cap, and the jobs and their choices over
 * the wire.
 */

const pacing = { chunkLength: 100, pauseMs: 1 };

/** The port an app that runs its jobs in-process gives the cockpit. */
const APP_PORT = 4312;

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-');

const explain = {
  id: 'explain',
  title: 'Explain a file',
  args: z.object({ file: z.string().min(1) }),
  key: ({ file }: { file: string }) => `explain-${slug(file)}`,
  prompt: ({ file }: { file: string }) => `Explain ${file}`,
};

/** The same unit of work, in another permission mode: other launch settings. */
const review = {
  ...explain,
  id: 'review',
  title: 'Review a file',
  prompt: ({ file }: { file: string }) => `Review ${file}`,
  driver: claudeCode.job({ permissionMode: 'plan' }),
};

/** The same unit of work, started anew whenever its session ended. */
const explainAfresh = { ...explain, id: 'explain-afresh', fresh: true as const };

/** A job for typing, in a folder of the app's. */
let workFolderOf = (folder: string) => folder;
const work = {
  id: 'work',
  title: 'Work in a folder',
  args: z.object({ folder: z.string().min(1) }),
  key: ({ folder }: { folder: string }) => `work-${slug(folder)}`,
  directory: ({ folder }: { folder: string }) => workFolderOf(folder),
};

/** A job whose file is chosen among the files of the folder chosen. */
const pick = {
  id: 'pick',
  title: 'Pick a file',
  args: z.object({
    folder: z.string().meta({ label: 'Folder' }),
    file: z.string().meta({ label: 'File', hint: 'one of the folder’s' }),
    tag: z.string().optional(),
  }),
  options: {
    folder: () => [{ value: 'docs', label: 'Documents' }, { value: 'src' }],
    file: ({ folder }: { folder?: string }) =>
      folder === 'docs' ? [{ value: 'a.md' }] : [{ value: 'b.ts' }],
    tag: { choices: () => [{ value: 'urgent' }], suggestions: true as const },
  },
  key: ({ folder, file }: { folder: string; file: string }) => `pick-${slug(folder)}-${slug(file)}`,
  prompt: ({ file }: { file: string }) => `Read ${file}`,
};

/** A job whose prompt is the text given: one over the command line's bound is typed after the start. */
const ask = {
  id: 'ask',
  title: 'Ask anything',
  args: z.object({ name: z.string().min(1), text: z.string().min(1) }),
  key: ({ name }: { name: string }) => `ask-${slug(name)}`,
  prompt: ({ text }: { text: string }) => text,
};

/** A prompt typed into an `idle` session: the state is the turn's, which may have ended already. */
const SENT = { action: 'sent', state: expect.stringMatching(/^(busy|idle)$/) };

const JOBS = [explain, review, explainAfresh, work, pick, ask] as unknown as readonly Job[];

let root: string;
let shims: string;
let made = 0;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-units-')));
  shims = join(root, 'bin');
  mkdirSync(shims);
  writeAgentShim(shims, fakeAgentCommand());
});

beforeEach(() => {
  vi.stubEnv('PATH', `${shims}${delimiter}${process.env.PATH}`);
  vi.stubEnv('CLAUDE_CONFIG_DIR', configFolder());
  workFolderOf = (folder) => folder;
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function configFolder(): string {
  return join(root, 'config');
}

/** A cockpit of an app of its own, its folders and tmux server ended after the test. */
interface Made {
  readonly cockpit: Cockpit;
  readonly directory: string;
  readonly stateDirectory: string;
  /** The app's tmux sessions, as a person at the terminal reaches them. */
  readonly host: SessionHost;
  /** The options it was created with, to create it again. */
  readonly options: CockpitOptions;
}

async function newCockpit(options: Partial<CockpitOptions> = {}): Promise<Made> {
  made += 1;
  const name = `units-${process.pid}-${made}`;
  const directory = join(root, `work-${made}`);
  mkdirSync(directory);
  const stateDirectory = join(root, `state-${made}`);
  const host = createTmuxSessionHost({ appName: name });
  const given: CockpitOptions = {
    name,
    directory,
    driver: claudeCode(),
    jobs: JOBS,
    stateDirectory,
    port: APP_PORT,
    ...options,
  };
  const cockpit = await createCockpit(given);
  cleanups.push(async () => {
    await cockpit.close();
    await host.shutDown();
  });
  return { cockpit, directory, stateDirectory, host, options: given };
}

function sessionOf(cockpit: Cockpit, key: string): Session | undefined {
  return cockpit.sessions.list().find((session) => session.key === key);
}

function inState<S extends Session['state']>(cockpit: Cockpit, key: string, state: S) {
  return eventually(() => {
    const session = sessionOf(cockpit, key);
    expect(session?.state).toBe(state);
    return session as Extract<Session, { state: S }>;
  });
}

/** Waits until the session is `idle` with the last message. */
function idleWith(cockpit: Cockpit, key: string, lastMessage: string): Promise<void> {
  return eventually(() =>
    expect(sessionOf(cockpit, key)).toMatchObject({ state: 'idle', lastMessage }),
  );
}

/** The states a session goes through from now on, each once in a row. */
function statesOf(cockpit: Cockpit, key: string): Session[] {
  const seen: Session[] = [];
  const stop = cockpit.sessions.follow((sessions) => {
    const session = sessions.find((each) => each.key === key);
    if (session === undefined) return;
    const last = seen.at(-1);
    if (last?.state === session.state && last.since === session.since) seen.pop();
    seen.push(session);
  });
  cleanups.push(async () => stop());
  return seen;
}

async function refusalOf(operation: Promise<unknown>): Promise<Record<string, unknown>> {
  return operation.then(
    () => expect.fail('Expected a refusal.'),
    (error: unknown) => error as Record<string, unknown>,
  );
}

/** The text of the session's input box, as the driver reads it. */
async function inputBoxOf(host: SessionHost, key: string): Promise<string | undefined> {
  return readInputBox((await host.readScreen(key)).text)?.text;
}

/** Types a draft into the session's input box as a person does, lines broken with Alt+Enter. */
async function typeDraft(host: SessionHost, key: string, lines: readonly string[]): Promise<void> {
  for (const [index, line] of lines.entries()) {
    if (index > 0) await host.sendKeys(key, ['M-Enter']);
    await host.sendText(key, line, pacing);
  }
  await eventually(async () => expect(await inputBoxOf(host, key)).toBe(lines.join('\n')));
}

/** The conversation a key's record says it works in. */
function conversationOf(cockpit: Cockpit, key: string): string {
  const conversation = sessionOf(cockpit, key)?.record?.conversationId;
  if (conversation === undefined) throw new Error(`The key ${key} has no record.`);
  return conversation;
}

/** Deletes the transcript of the key's conversation: the agent no longer keeps it. */
function forgetConversation(cockpit: Cockpit, key: string): void {
  const transcript = findTranscript(configFolder(), conversationOf(cockpit, key));
  if (transcript === undefined) throw new Error(`The key ${key}'s conversation has no transcript.`);
  rmSync(transcript);
}

/** Ends a key's session as an agent that is killed does: `ended`, `lost`, its conversation kept. */
async function endSession(made: Made, key: string): Promise<void> {
  await made.host.kill(key);
  await inState(made.cockpit, key, 'ended');
}

const backgroundTask = {
  do: 'task',
  description: 'Count files',
  prompt: 'Count the files.',
  agentType: 'general-purpose',
  work: [{ do: 'reply', text: 'Counted.' }],
} as const;

describe('a run, by the state of its unit of work', () => {
  it('starts a unit of work with no record, which records its conversation and the run', async () => {
    const { cockpit, directory } = await newCockpit();
    writeScript(directory, [[{ do: 'reply', text: 'Explained.' }]]);

    expect(await cockpit.run('explain', { file: 'a' })).toEqual({
      action: 'started',
      state: 'busy',
    });

    const idle = await inState(cockpit, 'explain-a', 'idle');
    expect(idle.record).toEqual({
      conversationId: expect.any(String),
      earlierConversations: [],
      history: [
        {
          operation: 'run',
          jobId: 'explain',
          args: { file: 'a' },
          at: expect.any(String),
          action: 'started',
          conversationId: idle.record?.conversationId,
        },
      ],
    });
  });

  it('types the prompt into an `idle` session launched with the same settings: sent, kept in the history', async () => {
    const { cockpit, directory } = await newCockpit();
    writeScript(directory, [[{ do: 'reply', text: 'One.' }], [{ do: 'reply', text: 'Two.' }]]);
    await cockpit.run('explain', { file: 'a' });
    await inState(cockpit, 'explain-a', 'idle');

    expect(await cockpit.run('explain', { file: 'a' })).toEqual(SENT);
    await idleWith(cockpit, 'explain-a', 'Two.');
    const { record } = sessionOf(cockpit, 'explain-a') ?? {};
    expect(record?.history.map(({ action }) => action)).toEqual(['started', 'sent']);
    expect(record?.history.at(-1)).toMatchObject({
      operation: 'run',
      jobId: 'explain',
      conversationId: record?.conversationId,
    });
  });

  it('refuses a `busy` session: wrong-state, with its state', async () => {
    const { cockpit, directory } = await newCockpit();
    writeScript(directory, [[{ do: 'stay-busy' }]]);
    await cockpit.run('explain', { file: 'a' });

    expect(await refusalOf(cockpit.run('explain', { file: 'a' }))).toMatchObject({
      code: 'wrong-state',
      key: 'explain-a',
      state: 'busy',
    });
  });

  /** Makes the agent's configuration trust no folder of the app's: its start shows the trust dialog. */
  function trustNoFolder(): void {
    const untrusting = join(root, `config-untrusting-${made + 1}`);
    mkdirSync(untrusting);
    writeFileSync(
      join(untrusting, '.claude.json'),
      JSON.stringify(agentConfiguration({ workFolder: '/somewhere/else' })),
    );
    vi.stubEnv('CLAUDE_CONFIG_DIR', untrusting);
    vi.stubEnv('ANTHROPIC_API_KEY', FAKE_API_KEY);
  }

  it('frees the key of a run whose long first prompt waits behind a start-up dialog: the calls that follow act on `waiting`, a fresh run ends it', async () => {
    trustNoFolder();
    const { cockpit } = await newCockpit();
    const parked = cockpit.run('ask', { name: 'a', text: 'ệ'.repeat(50_000) });
    parked.catch(() => {});
    await inState(cockpit, 'ask-a', 'waiting');

    expect(await refusalOf(cockpit.send('ask-a', 'Go on.'))).toMatchObject({
      code: 'wrong-state',
      state: 'waiting',
      pending: [{ kind: 'terminal', dialog: 'trust-folder' }],
    });
    expect(await cockpit.open('ask-a')).toEqual({ action: 'nothing-to-open', state: 'waiting' });
    expect(await cockpit.run('ask', { name: 'a', text: 'Short.' }, { fresh: true })).toEqual({
      action: 'started',
      reason: 'fresh-on-request',
      state: 'waiting',
    });
    await expect(parked).resolves.toEqual({ action: 'started', state: 'ended' });
    expect(sessionOf(cockpit, 'ask-a')?.record?.history).toMatchObject([
      { jobId: 'ask', action: 'started' },
      { jobId: 'ask', action: 'started', reason: 'fresh-on-request' },
    ]);
  });

  it('refuses a `waiting` session: wrong-state, with what it waits for', async () => {
    trustNoFolder();
    const { cockpit, directory } = await newCockpit();
    writeScript(directory, [[{ do: 'reply', text: 'Explained.' }]]);
    expect(await cockpit.run('explain', { file: 'a' })).toMatchObject({ state: 'waiting' });

    expect(await refusalOf(cockpit.run('explain', { file: 'a' }))).toMatchObject({
      code: 'wrong-state',
      state: 'waiting',
      pending: [{ kind: 'terminal', dialog: 'trust-folder' }],
    });
  });

  it('resumes an `ended` unit of work with the prompt: resumed, in the same conversation', async () => {
    const { cockpit, directory } = await newCockpit();
    writeScript(directory, [[{ do: 'exit' }], [{ do: 'reply', text: 'Back.' }]]);
    await cockpit.run('explain', { file: 'a' });
    await inState(cockpit, 'explain-a', 'ended');
    const conversation = conversationOf(cockpit, 'explain-a');

    expect(await cockpit.run('explain', { file: 'a' })).toEqual({
      action: 'resumed',
      state: 'busy',
    });

    const idle = await inState(cockpit, 'explain-a', 'idle');
    expect(idle.lastMessage).toBe('Back.');
    expect(idle.record?.conversationId).toBe(conversation);
    expect(idle.record?.history.map(({ action }) => action)).toEqual(['started', 'resumed']);
  });

  it('starts a new conversation on an `ended` one when the job is fresh: fresh, the old one kept', async () => {
    const made = await newCockpit();
    const { cockpit, directory } = made;
    writeScript(directory, [[{ do: 'reply', text: 'Explained.' }]]);
    await cockpit.run('explain', { file: 'a' });
    await inState(cockpit, 'explain-a', 'idle');
    const first = conversationOf(cockpit, 'explain-a');
    await endSession(made, 'explain-a');

    expect(await cockpit.run('explain-afresh', { file: 'a' })).toEqual({
      action: 'started',
      reason: 'fresh',
      state: 'busy',
    });

    const idle = await inState(cockpit, 'explain-a', 'idle');
    expect(idle.record?.conversationId).not.toBe(first);
    expect(idle.record?.earlierConversations).toEqual([first]);
    expect(idle.record?.history.at(-1)).toMatchObject({ action: 'started', reason: 'fresh' });
  });

  it('reads the arguments the last run was given again: the history keeps them as given, never as the schema gave them', async () => {
    const page = {
      id: 'page',
      title: 'Explain a page',
      args: z.object({ page: z.string().transform(Number) }),
      key: ({ page }: { page: number }) => `page-${page}`,
      prompt: ({ page }: { page: number }) => `Explain page ${page + 1}`,
    };
    const made = await newCockpit({ jobs: [...JOBS, page as unknown as Job] });
    const { cockpit, directory } = made;
    writeScript(directory, [
      [{ do: 'reply', text: 'Explained.' }],
      [{ do: 'reply', text: 'Sent.' }],
    ]);
    await cockpit.run('page', { page: '3' });
    await inState(cockpit, 'page-3', 'idle');
    await endSession(made, 'page-3');

    expect(await cockpit.send('page-3', 'Go on.')).toEqual({ action: 'resumed', state: 'busy' });
    expect(sessionOf(cockpit, 'page-3')?.record?.history).toMatchObject([
      { jobId: 'page', args: { page: '3' } },
    ]);
  });

  it('starts a new conversation when the agent no longer keeps the ended one: conversation-gone', async () => {
    const made = await newCockpit();
    const { cockpit, directory } = made;
    writeScript(directory, [[{ do: 'reply', text: 'Explained.' }]]);
    await cockpit.run('explain', { file: 'a' });
    await inState(cockpit, 'explain-a', 'idle');
    await endSession(made, 'explain-a');
    forgetConversation(cockpit, 'explain-a');

    expect(await cockpit.run('explain', { file: 'a' })).toEqual({
      action: 'started',
      reason: 'conversation-gone',
      state: 'busy',
    });
  });

  it('restarts an `idle` session launched with other settings, keeping its conversation: settings-changed', async () => {
    const { cockpit, directory } = await newCockpit();
    writeScript(directory, [
      [{ do: 'reply', text: 'Explained.' }],
      [{ do: 'reply', text: 'Reviewed.' }],
    ]);
    await cockpit.run('explain', { file: 'a' });
    await inState(cockpit, 'explain-a', 'idle');
    const conversation = conversationOf(cockpit, 'explain-a');
    const seen = statesOf(cockpit, 'explain-a');

    expect(await cockpit.run('review', { file: 'a' })).toEqual({
      action: 'resumed',
      reason: 'settings-changed',
      state: 'busy',
    });

    const idle = await inState(cockpit, 'explain-a', 'idle');
    expect(idle.lastMessage).toBe('Reviewed.');
    expect(idle.record?.conversationId).toBe(conversation);
    expect(seen.find((session) => session.state === 'ended')).toMatchObject({
      reason: 'restarted',
    });
    // The settings are the review's now: another review is typed.
    writeScript(directory, [
      [{ do: 'reply', text: 'Explained.' }],
      [{ do: 'reply', text: 'Reviewed.' }],
      [{ do: 'reply', text: 'Reviewed again.' }],
    ]);
    expect(await cockpit.run('review', { file: 'a' })).toEqual(SENT);
  });

  it('starts and resumes a job for typing at `idle`, in its folder; on a live session nothing to send', async () => {
    const made = await newCockpit();
    const { cockpit, directory, host } = made;
    mkdirSync(join(directory, 'sub'));
    writeScript(join(directory, 'sub'), [[{ do: 'reply', text: 'In sub.' }]]);

    expect(await cockpit.run('work', { folder: 'sub' })).toEqual({
      action: 'started',
      state: 'idle',
    });
    expect(await cockpit.run('work', { folder: 'sub' })).toEqual({
      action: 'nothing-to-send',
      state: 'idle',
    });
    // The person types in the terminal: the agent answers from the folder's script.
    await host.sendText('work-sub', 'Hello', pacing);
    await host.sendKeys('work-sub', ['Enter']);
    await idleWith(cockpit, 'work-sub', 'In sub.');
    await endSession(made, 'work-sub');

    expect(await cockpit.run('work', { folder: 'sub' })).toEqual({
      action: 'resumed',
      state: 'idle',
    });
  });

  it('makes a job’s missing folder, and refuses a folder outside the app’s or other than the one recorded', async () => {
    const { cockpit } = await newCockpit();

    expect(await cockpit.run('work', { folder: 'made/here' })).toMatchObject({ state: 'idle' });
    expect(await refusalOf(cockpit.run('work', { folder: '../outside' }))).toMatchObject({
      code: 'folder-outside-app',
    });
    workFolderOf = (folder) => `${folder}-moved`;
    expect(await refusalOf(cockpit.run('work', { folder: 'made/here' }))).toMatchObject({
      code: 'folder-changed',
      recorded: 'made/here',
      computed: 'made/here-moved',
    });
  });

  it('refuses a value not among its field’s choices before anything is launched: not-a-choice', async () => {
    const { cockpit } = await newCockpit();

    expect(await refusalOf(cockpit.run('pick', { folder: 'docs', file: 'b.ts' }))).toMatchObject({
      code: 'not-a-choice',
      field: 'file',
      value: 'b.ts',
    });
    expect(cockpit.sessions.list()).toEqual([]);
  });
});

describe('a run afresh', () => {
  it('ends an `idle` session first and starts a new conversation, listing the background tasks it stopped', async () => {
    const { cockpit, directory } = await newCockpit();
    holdTasks(directory);
    writeScript(directory, [[backgroundTask, { do: 'reply', text: 'Started.' }]]);
    await cockpit.run('explain', { file: 'a' });
    await inState(cockpit, 'explain-a', 'idle');
    const first = conversationOf(cockpit, 'explain-a');

    expect(await cockpit.run('explain', { file: 'a' }, { fresh: true })).toEqual({
      action: 'started',
      reason: 'fresh-on-request',
      state: 'busy',
      stoppedTasks: [
        { id: expect.any(String), type: 'general-purpose', description: 'Count files' },
      ],
    });
    const idle = await inState(cockpit, 'explain-a', 'idle');
    expect(idle.record?.earlierConversations).toEqual([first]);
  });

  it('ends a `busy` session first', async () => {
    const { cockpit, directory } = await newCockpit();
    writeScript(directory, [[{ do: 'stay-busy' }]]);
    await cockpit.run('explain', { file: 'a' });

    expect(await cockpit.run('explain', { file: 'a' }, { fresh: true })).toEqual({
      action: 'started',
      reason: 'fresh-on-request',
      state: 'busy',
    });
  });
});

describe('a send', () => {
  it("types into an `idle` session, keeping the person's draft of several lines", async () => {
    const { cockpit, directory, host } = await newCockpit();
    writeScript(directory, [[{ do: 'reply', text: 'One.' }], [{ do: 'reply', text: 'Two.' }]]);
    await cockpit.run('explain', { file: 'a' });
    await inState(cockpit, 'explain-a', 'idle');
    await typeDraft(host, 'explain-a', ['first line of my draft', 'and its second line']);

    expect(await cockpit.send('explain-a', 'Tighten it.')).toEqual(SENT);

    await idleWith(cockpit, 'explain-a', 'Two.');
    expect(await inputBoxOf(host, 'explain-a')).toBe('first line of my draft\nand its second line');
    // A send is no run: the history keeps the run alone.
    expect(sessionOf(cockpit, 'explain-a')?.record?.history).toHaveLength(1);
  });

  it("resumes an `ended` unit of work with the prompt and the settings of the key's last run", async () => {
    const made = await newCockpit();
    const { cockpit, directory } = made;
    writeScript(directory, [
      [{ do: 'reply', text: 'Reviewed.' }],
      [{ do: 'reply', text: 'Sent.' }],
      [{ do: 'reply', text: 'Reviewed again.' }],
    ]);
    await cockpit.run('review', { file: 'a' });
    await inState(cockpit, 'explain-a', 'idle');
    await endSession(made, 'explain-a');

    expect(await cockpit.send('explain-a', 'Go on.')).toEqual({ action: 'resumed', state: 'busy' });
    await idleWith(cockpit, 'explain-a', 'Sent.');
    // Launched with the review's settings, another review is typed into it.
    expect(await cockpit.run('review', { file: 'a' })).toEqual(SENT);
  });

  it('starts a new conversation when the agent no longer keeps the ended one: conversation-gone', async () => {
    const made = await newCockpit();
    const { cockpit, directory } = made;
    writeScript(directory, [[{ do: 'reply', text: 'Explained.' }]]);
    await cockpit.run('explain', { file: 'a' });
    await inState(cockpit, 'explain-a', 'idle');
    await endSession(made, 'explain-a');
    forgetConversation(cockpit, 'explain-a');

    expect(await cockpit.send('explain-a', 'Go on.')).toEqual({
      action: 'started',
      reason: 'conversation-gone',
      state: 'busy',
    });
  });

  it('is refused on a key with no record, on a busy session, and over 100,000 characters', async () => {
    const { cockpit, directory } = await newCockpit();
    writeScript(directory, [[{ do: 'stay-busy' }]]);
    await cockpit.run('explain', { file: 'a' });

    expect(await refusalOf(cockpit.send('nothing', 'Hi.'))).toMatchObject({
      code: 'unknown-key',
      key: 'nothing',
    });
    expect(await refusalOf(cockpit.send('explain-a', 'Hi.'))).toMatchObject({
      code: 'wrong-state',
      state: 'busy',
    });
    expect(await refusalOf(cockpit.send('explain-a', 'x'.repeat(100_001)))).toMatchObject({
      code: 'prompt-too-long',
      length: 100_001,
      max: 100_000,
    });
  });

  it("is stopped by a turn the agent began by itself; the person's draft is put back while the box shows", async () => {
    const { cockpit, directory, host } = await newCockpit();
    holdTasks(directory);
    writeScript(directory, [
      [backgroundTask, { do: 'reply', text: 'Started.' }],
      [{ do: 'reply', text: 'Noted.' }],
    ]);
    await cockpit.run('explain', { file: 'a' });
    await inState(cockpit, 'explain-a', 'idle');
    await typeDraft(host, 'explain-a', ['my draft']);

    const sending = refusalOf(cockpit.send('explain-a', longPrompt()));
    await promptBeingTyped(host, 'explain-a', 1);
    releaseTasks(directory);

    const refused = await sending;
    expect(refused).toMatchObject({ code: 'wrong-state' });
    expect(refused.message).not.toContain('kill ring');
    await idleWith(cockpit, 'explain-a', 'Noted.');
    expect(await inputBoxOf(host, 'explain-a')).toBe('my draft');
  });

  it("is stopped by a permission dialog drawn over the box; the person's draft is left in the kill ring, and the error says so", async () => {
    const { cockpit, directory, host } = await newCockpit();
    holdTasks(directory);
    writeScript(directory, [
      [backgroundTask, { do: 'reply', text: 'Started.' }],
      [
        { do: 'tool', name: 'Bash', input: { command: 'touch a.txt' } },
        { do: 'reply', text: 'Touched.' },
      ],
    ]);
    await cockpit.run('explain', { file: 'a' });
    await inState(cockpit, 'explain-a', 'idle');
    await typeDraft(host, 'explain-a', ['my draft']);

    const sending = refusalOf(cockpit.send('explain-a', longPrompt()));
    // Rows enough that clearing them outlasts the turn's first tool hook, after which nothing is typed.
    await promptBeingTyped(host, 'explain-a', 40);
    releaseTasks(directory);

    const refused = await sending;
    expect(refused).toMatchObject({ code: 'wrong-state', key: 'explain-a' });
    expect(refused.message).toMatch(/The person's draft is in the input box's kill ring: Ctrl\+Y/);
    // The dialog shows in place of the box, unanswered: no key of the cockpit's reached it.
    await eventually(async () => expect(await inputBoxOf(host, 'explain-a')).toBeUndefined());
    expect(await host.isLive('explain-a')).toBe(true);
  });
});

/** A prompt of many rows of the input box, in words: about 15,000 characters. */
function longPrompt(): string {
  return Array.from({ length: 2500 }, (_, index) => `w${index}`).join(' ');
}

/** Waits until the send typed so many rows of its prompt that the box scrolled past them, or shows the first. */
function promptBeingTyped(host: SessionHost, key: string, rows: number): Promise<void> {
  return eventually(
    async () => {
      const { text } = await host.readScreen(key);
      const scrolled = Number(/↑ (\d+) more/.exec(text)?.[1] ?? 0);
      expect(rows <= 1 ? text.includes('w0 w1') : scrolled >= rows).toBe(true);
    },
    undefined,
    PATIENCE.longPromptTyped,
  );
}

describe('an open', () => {
  it('resumes an `ended` unit of work with no prompt, at `idle`, in its history', async () => {
    const made = await newCockpit();
    const { cockpit, directory } = made;
    writeScript(directory, [[{ do: 'reply', text: 'Explained.' }]]);
    await cockpit.run('explain', { file: 'a' });
    await inState(cockpit, 'explain-a', 'idle');
    await endSession(made, 'explain-a');

    expect(await cockpit.open('explain-a')).toEqual({ action: 'resumed', state: 'idle' });

    expect(sessionOf(cockpit, 'explain-a')?.record?.history.at(-1)).toMatchObject({
      operation: 'open',
      jobId: 'explain',
      args: { file: 'a' },
      action: 'resumed',
    });
  });

  it('has nothing to open on a live session, with its state, or on a key with no record', async () => {
    const { cockpit, directory } = await newCockpit();
    writeScript(directory, [[{ do: 'reply', text: 'Explained.' }]]);
    await cockpit.run('explain', { file: 'a' });
    await inState(cockpit, 'explain-a', 'idle');

    expect(await cockpit.open('explain-a')).toEqual({ action: 'nothing-to-open', state: 'idle' });
    expect(await cockpit.open('nothing')).toEqual({ action: 'nothing-to-open' });
    expect(await cockpit.open('nothing', { fresh: true })).toEqual({ action: 'nothing-to-open' });
  });

  it('opens afresh: the live session ended first, a new conversation at `idle`', async () => {
    const { cockpit, directory } = await newCockpit();
    writeScript(directory, [[{ do: 'reply', text: 'Explained.' }]]);
    await cockpit.run('explain', { file: 'a' });
    await inState(cockpit, 'explain-a', 'idle');
    const first = conversationOf(cockpit, 'explain-a');

    expect(await cockpit.open('explain-a', { fresh: true })).toEqual({
      action: 'started',
      reason: 'fresh-on-request',
      state: 'idle',
    });
    expect(sessionOf(cockpit, 'explain-a')?.record?.earlierConversations).toEqual([first]);
  });

  it('starts a new conversation when the agent no longer keeps the ended one: conversation-gone', async () => {
    const made = await newCockpit();
    const { cockpit, directory } = made;
    writeScript(directory, [[{ do: 'reply', text: 'Explained.' }]]);
    await cockpit.run('explain', { file: 'a' });
    await inState(cockpit, 'explain-a', 'idle');
    await endSession(made, 'explain-a');
    forgetConversation(cockpit, 'explain-a');

    expect(await cockpit.open('explain-a')).toEqual({
      action: 'started',
      reason: 'conversation-gone',
      state: 'idle',
    });
  });
});

describe('the records, across a restart of the server', () => {
  it("lists each recorded key `ended`, with its record; an open or a send whose last run's job is gone is refused: unknown-job", async () => {
    const made = await newCockpit();
    writeScript(made.directory, [[{ do: 'exit' }]]);
    await made.cockpit.run('explain', { file: 'a' });
    await inState(made.cockpit, 'explain-a', 'ended');
    const record = sessionOf(made.cockpit, 'explain-a')?.record;
    await made.cockpit.close();

    const again = await createCockpit({ ...made.options, jobs: [work as unknown as Job] });
    cleanups.push(() => again.close());

    expect(again.sessions.list()).toEqual([
      {
        key: 'explain-a',
        state: 'ended',
        since: expect.any(String),
        canResume: true,
        reason: 'lost',
        record,
      },
    ]);
    expect(await refusalOf(again.open('explain-a'))).toMatchObject({
      code: 'unknown-job',
      jobId: 'explain',
    });
    expect(await refusalOf(again.send('explain-a', 'Go on.'))).toMatchObject({
      code: 'unknown-job',
    });
  });
});

describe('the cap on live sessions', () => {
  it('ends the `idle` session idle longest to make room for a start: session-cap', async () => {
    const { cockpit, directory } = await newCockpit({ maxSessions: 1 });
    writeScript(directory, [[{ do: 'reply', text: 'Explained.' }]]);
    await cockpit.run('explain', { file: 'a' });
    await inState(cockpit, 'explain-a', 'idle');

    expect(await cockpit.run('explain', { file: 'b' })).toMatchObject({ action: 'started' });

    expect(sessionOf(cockpit, 'explain-a')).toMatchObject({
      state: 'ended',
      reason: 'session-cap',
    });
  });

  it('refuses a start when no live session can be ended: session-cap-reached', async () => {
    const { cockpit, directory } = await newCockpit({ maxSessions: 1 });
    writeScript(directory, [[{ do: 'stay-busy' }]]);
    await cockpit.run('explain', { file: 'a' });

    expect(await refusalOf(cockpit.run('explain', { file: 'b' }))).toMatchObject({
      code: 'session-cap-reached',
      cap: 1,
      live: ['explain-a'],
    });
    expect(sessionOf(cockpit, 'explain-b')).toBeUndefined();
  });
});

describe('the jobs, their choices and the operations, over the wire', () => {
  async function mounted(): Promise<{ base: string; token: string; made: Made }> {
    const app = await startNodeHttpApp('127.0.0.1', '/cockpit');
    cleanups.push(() => app.close());
    const made = await newCockpit({ port: app.port });
    app.serve(made.cockpit);
    const token = new URL(made.cockpit.link('http://127.0.0.1/')).hash.replace('#cockpit=', '');
    return { base: app.base, token, made };
  }

  const bodyOf = (reply: { body: string }) => JSON.parse(reply.body) as Record<string, unknown>;

  it('describes the jobs, with no key, prompt, folder or driver part', async () => {
    const { base, token, made } = await mounted();

    const reply = await call(`${base}/jobs`, { token });

    expect(reply.status).toBe(200);
    expect(bodyOf(reply)).toEqual({ jobs: made.cockpit.jobs() });
    const described = (bodyOf(reply).jobs as Record<string, unknown>[]).find(
      (job) => job.id === 'pick',
    );
    expect(described).toEqual({
      id: 'pick',
      title: 'Pick a file',
      schema: expect.objectContaining({
        type: 'object',
        properties: expect.objectContaining({
          file: expect.objectContaining({ label: 'File', hint: 'one of the folder’s' }),
        }),
      }),
      options: { folder: 'choices', file: 'choices', tag: 'suggestions' },
      hasPrompt: true,
    });
    expect(
      (bodyOf(reply).jobs as Record<string, unknown>[]).find((job) => job.id === 'work'),
    ).toMatchObject({ hasPrompt: false });
  });

  it('reads a field’s choices given the other fields: a field that depends on another', async () => {
    const { base, token } = await mounted();
    const choices = async (field: string, args: object) =>
      bodyOf(await post(`${base}/options`, { jobId: 'pick', field, args }, { token }));

    expect(await choices('folder', {})).toEqual({
      choices: [{ value: 'docs', label: 'Documents' }, { value: 'src' }],
    });
    expect(await choices('file', { folder: 'docs' })).toEqual({ choices: [{ value: 'a.md' }] });
    expect(await choices('file', { folder: 'src' })).toEqual({ choices: [{ value: 'b.ts' }] });
    const refused = await post(
      `${base}/options`,
      { jobId: 'pick', field: 'key', args: {} },
      { token },
    );
    expect(refused.status).toBe(400);
    expect(bodyOf(refused).error).toMatchObject({ code: 'invalid-arguments' });
  });

  it('answers a run, a send and an open, and their refusals with their errors', async () => {
    const { base, token, made } = await mounted();
    writeScript(made.directory, [[{ do: 'reply', text: 'Read.' }]]);

    const notAChoice = await post(
      `${base}/run`,
      { jobId: 'pick', args: { folder: 'docs', file: 'b.ts' } },
      { token },
    );
    expect(notAChoice.status).toBe(400);
    expect(bodyOf(notAChoice).error).toMatchObject({ code: 'not-a-choice', field: 'file' });

    const run = await post(
      `${base}/run`,
      { jobId: 'pick', args: { folder: 'docs', file: 'a.md', tag: 'anything' } },
      { token },
    );
    expect(bodyOf(run)).toEqual({ action: 'started', state: 'busy' });
    await inState(made.cockpit, 'pick-docs-a-md', 'idle');

    const open = await post(`${base}/open`, { key: 'pick-docs-a-md' }, { token });
    expect(bodyOf(open)).toEqual({ action: 'nothing-to-open', state: 'idle' });

    const unknown = await post(`${base}/send`, { key: 'nothing', prompt: 'Hi.' }, { token });
    expect(unknown.status).toBe(404);
    expect(bodyOf(unknown).error).toMatchObject({ code: 'unknown-key', key: 'nothing' });

    const listed = bodyOf(await call(`${base}/sessions`, { token }));
    expect(listed.sessions).toEqual([
      expect.objectContaining({ key: 'pick-docs-a-md', record: expect.any(Object) }),
    ]);
  });
});
