import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CANNOT_PLAY_STATUS,
  OF_THE_SESSION,
  STOP_WITH_NO_TASK,
  TERMINATED_STATUS,
} from '../support/fake-agent/agent.ts';
import { fakeAgentCommand } from '../support/fake-agent/launching.ts';
import { release, type Step, writeScript } from '../support/fake-agent/script.ts';
import { transcriptPathFor } from '../support/fake-agent/transcript.ts';
import { versionOutput } from '../support/fake-agent/version.ts';
import { type HookReceiver, startHookReceiver } from '../support/hooks/hook-receiver.ts';
import { recordedPayload } from '../support/recorded-hooks.ts';

let root: string;
let configFolder: string;
let receiver: HookReceiver;
let runs = 0;
const running: ChildProcess[] = [];

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-fake-agent-')));
  configFolder = join(root, 'config');
});

beforeEach(async () => {
  receiver = await startHookReceiver();
});

afterEach(async () => {
  for (const child of running.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'close');
    }
  }
  await receiver.close();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A fake agent run as a process of the test's own, with Claude Code's command line. */
interface Run {
  readonly child: ChildProcess;
  readonly folder: string;
  readonly sessionId: string;
  /** Fulfilled once the process ended, with its status, its error output and all it printed. */
  readonly ended: Promise<{ status: number | null; errors: string; printed: string }>;
}

function run(
  options: {
    script?: readonly Step[];
    prompt?: string;
    resume?: boolean;
    environment?: Record<string, string | undefined>;
  } = {},
): Run {
  runs += 1;
  const folder = join(root, `work-${runs}`);
  mkdirSync(folder);
  if (options.script !== undefined) writeScript(folder, options.script);
  const settingsFile = join(root, `settings-${runs}.json`);
  writeFileSync(settingsFile, JSON.stringify(receiver.settings()));
  const sessionId = randomUUID();
  const agent = fakeAgentCommand();
  const child = spawn(
    agent.command,
    [
      ...agent.args,
      options.resume === true ? '--resume' : '--session-id',
      sessionId,
      '--settings',
      settingsFile,
      '--permission-mode',
      'default',
      ...(options.prompt === undefined ? [] : ['--', options.prompt]),
    ],
    {
      cwd: folder,
      env: options.environment ?? { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: configFolder },
    },
  );
  running.push(child);
  let errors = '';
  let printed = '';
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    errors += chunk;
  });
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    printed += chunk;
  });
  const ended = once(child, 'close').then(([status]) => ({
    status: status as number | null,
    errors,
    printed,
  }));
  return { child, folder, sessionId, ended };
}

/** The values the run's payloads carry: its session's. */
function valuesOf({ folder, sessionId }: Run) {
  const transcriptPath = transcriptPathFor(configFolder, folder, sessionId);
  return { sessionId, transcriptPath, cwd: folder, root: dirname(folder) };
}

/** The payloads the receiver got by HTTP, in order. */
const posted = () => receiver.received.filter((hook) => hook.via === 'http');

describe('the fake agent', () => {
  it("says the pinned agent's version on --version, as Claude Code does, and starts nothing", async () => {
    const agent = fakeAgentCommand();
    const child = spawn(agent.command, [...agent.args, '--version'], {
      env: { PATH: process.env.PATH },
    });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    const [status] = await once(child, 'close');

    expect(status).toBe(0);
    expect(output).toMatch(/^\d+\.\d+\.\d+ \(Claude Code\)\n$/);
    expect(receiver.events()).toEqual([]);
  });

  it('says the version a test sets', async () => {
    const agent = fakeAgentCommand();
    const child = spawn(agent.command, [...agent.args, '--version'], {
      env: { PATH: process.env.PATH, FAKE_AGENT_VERSION: '99.0.0' },
    });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    await once(child, 'close');

    expect(output).toBe(versionOutput('99.0.0'));
  });

  it("refuses to run without a configuration folder of the test's: it never writes the person's", async () => {
    const { ended } = run({ script: [], environment: { PATH: process.env.PATH } });

    const { status, errors } = await ended;
    expect(status).toBe(1);
    expect(errors).toContain('CLAUDE_CONFIG_DIR is not set');
    expect(receiver.events()).toEqual([]);
  });

  it("plays a turn on the launch's prompt with the payloads recorded of the real agent, its session's values in them, and draws nothing", async () => {
    const agent = run({ script: [{ do: 'turn', reply: 'Explained.' }], prompt: 'Explain a.ts' });
    const values = valuesOf(agent);

    await receiver.next('Stop');

    expect(posted().map((hook) => hook.payload)).toEqual([
      { ...recordedPayload('UserPromptSubmit', OF_THE_SESSION, values), prompt: 'Explain a.ts' },
      {
        ...recordedPayload('Stop', STOP_WITH_NO_TASK, values),
        last_assistant_message: 'Explained.',
      },
    ]);
    expect((await receiver.next('SessionStart')).payload).toEqual(
      recordedPayload('SessionStart', { source: 'startup' }, values),
    );
    expect(existsSync(values.transcriptPath)).toBe(true);
    agent.child.kill('SIGTERM');
    expect((await agent.ended).printed).toBe('');
  });

  it('works on the prompt until it is ended: SIGTERM fires SessionEnd, then it exits with 143', async () => {
    const agent = run({ script: [{ do: 'stay-busy' }], prompt: 'Explain a.ts' });
    await receiver.next('UserPromptSubmit');

    agent.child.kill('SIGTERM');

    expect((await agent.ended).status).toBe(TERMINATED_STATUS);
    expect((await receiver.next('SessionEnd')).payload).toEqual(
      recordedPayload('SessionEnd', { reason: 'other' }, valuesOf(agent)),
    );
  });

  it('holds until the test releases it, then exits by itself: SessionEnd of its own exit, status 0', async () => {
    const agent = run({ script: [{ do: 'hold' }, { do: 'exit' }] });
    await receiver.next('SessionStart');
    expect(agent.child.exitCode).toBeNull();

    release(agent.folder);

    expect((await agent.ended).status).toBe(0);
    expect((await receiver.next('SessionEnd')).payload).toEqual(
      recordedPayload('SessionEnd', { reason: 'prompt_input_exit' }, valuesOf(agent)),
    );
  });

  it.each([
    ['a step it does not play', { script: [{ do: 'type' }] as unknown as Step[] }, 'step 1'],
    ['a prompt its script does not take', { script: [], prompt: 'hi' }, 'no step takes it'],
    ['a resumed conversation', { script: [], resume: true }, '--resume'],
  ])('refuses %s, saying why, with status 70', async (_what, options, why) => {
    const { status, errors } = await run(options).ended;

    expect(status).toBe(CANNOT_PLAY_STATUS);
    expect(errors).toContain(why);
    expect(receiver.events()).toEqual([]);
  });
});
