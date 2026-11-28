import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  batchWhoseCalls,
  CANNOT_PLAY_STATUS,
  OF_THE_SESSION,
  ofTheCall,
  STOP_WITH_NO_TASK,
  TERMINATED_STATUS,
} from '../support/fake-agent/agent.ts';
import { fakeAgentCommand } from '../support/fake-agent/launching.ts';
import {
  type AskedCall,
  answerInTerminal,
  release,
  type Step,
  writeScript,
} from '../support/fake-agent/script.ts';
import { transcriptPathFor } from '../support/fake-agent/transcript.ts';
import { versionOutput } from '../support/fake-agent/version.ts';
import { type HookReceiver, startHookReceiver } from '../support/hooks/hook-receiver.ts';
import type { CallOutcome } from '../support/hooks/payload-recording.ts';
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

/** The events the receiver got by HTTP, in order. */
const postedEvents = () => posted().map((hook) => hook.event);

/** The call a turn asks for in these tests. */
const CALL: AskedCall = {
  tool: 'Bash',
  input: { command: 'touch b.txt', description: 'Create b.txt' },
};

/** A turn on the launch's prompt that asks for {@link CALL}. */
const ASKING_TURN: Step = { do: 'turn', reply: 'Made b.txt.', asks: [CALL] };

/** {@link ASKING_TURN}, then the agent's own exit: what it fired is all there once it ended. */
const ASK_THEN_EXIT: readonly Step[] = [ASKING_TURN, { do: 'exit' }];

/** {@link ASKING_TURN}, then a wait: the process, and any connection it left open, stay. */
const ASK_THEN_HOLD: readonly Step[] = [ASKING_TURN, { do: 'hold' }];

/** The reply of a `PermissionRequest` hook that decides, as the cockpit writes one. */
const decision = (decided: Record<string, unknown>) => ({
  hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: decided },
});

/** The texts of the transcript's entries, in order. */
function transcriptTexts(agent: Run): string[] {
  return readFileSync(valuesOf(agent).transcriptPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const { content } = (JSON.parse(line) as { message: { content: unknown } }).message;
      return typeof content === 'string'
        ? content
        : ((content as { text: string }[])[0]?.text ?? '');
    });
}

/** Runs a script that asks, its `PermissionRequest` held, and gives the held hook. */
async function asking(script: readonly Step[] = ASK_THEN_EXIT) {
  receiver.hold('PermissionRequest');
  const agent = run({ script, prompt: 'Make b.txt' });
  const permission = await receiver.next('PermissionRequest');
  return { agent, permission };
}

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

  describe('asks for a call', () => {
    /** What the run's payloads of the call carry: its turn's prompt id, and its PreToolUse's id. */
    function idsOf(agent: Run) {
      const values = valuesOf(agent);
      return {
        prompt_id: recordedPayload('UserPromptSubmit', OF_THE_SESSION, values).prompt_id,
        tool_use_id: recordedPayload('PreToolUse', ofTheCall(CALL.tool), values).tool_use_id,
      };
    }

    /** The recorded PostToolBatch of a call that ended so, made the run's call's. */
    function batchOfTheCall(agent: Run, outcome: CallOutcome, call: Record<string, unknown> = {}) {
      const { prompt_id, tool_use_id } = idsOf(agent);
      const batch = recordedPayload('PostToolBatch', batchWhoseCalls(outcome), valuesOf(agent));
      const [recordedCall] = batch.tool_calls as Record<string, unknown>[];
      return {
        ...batch,
        prompt_id,
        tool_calls: [
          { ...recordedCall, tool_name: CALL.tool, tool_input: CALL.input, tool_use_id, ...call },
        ],
      };
    }

    it("fires the recorded PreToolUse then PermissionRequest for the call, its turn's prompt id in both, and waits on the held hook", async () => {
      const { agent, permission } = await asking();
      const values = valuesOf(agent);
      const { prompt_id } = idsOf(agent);

      expect(postedEvents()).toEqual(['UserPromptSubmit', 'PreToolUse', 'PermissionRequest']);
      expect(posted()[1]?.payload).toEqual({
        ...recordedPayload('PreToolUse', ofTheCall(CALL.tool), values),
        tool_input: CALL.input,
        prompt_id,
      });
      expect(permission.payload).toEqual({
        ...recordedPayload('PermissionRequest', ofTheCall(CALL.tool), values),
        tool_input: CALL.input,
        prompt_id,
      });
      expect(permission.isOpen()).toBe(true);
    });

    it('on allow, fires PostToolUse of the call and the PostToolBatch of a call that ran, then ends the turn', async () => {
      const { agent, permission } = await asking();

      permission.answer(decision({ behavior: 'allow' }));

      expect((await agent.ended).status).toBe(0);
      expect((await receiver.next('PostToolUse')).payload).toEqual({
        ...recordedPayload('PostToolUse', ofTheCall(CALL.tool), valuesOf(agent)),
        tool_input: CALL.input,
        ...idsOf(agent),
      });
      expect((await receiver.next('PostToolBatch')).payload).toEqual(batchOfTheCall(agent, 'ran'));
      expect(postedEvents().slice(3)).toEqual([
        'PostToolUse',
        'PostToolBatch',
        'Stop',
        'SessionEnd',
      ]);
    });

    it.each([
      [
        'with a message, the message its result',
        { message: 'Not now' },
        { tool_response: 'Not now' },
      ],
      ["bare, the agent's own text its result", {}, {}],
    ])(
      'on deny %s, fires the PostToolBatch of a denied call, the call not run, and ends the turn',
      async (_how, message, call) => {
        const { agent, permission } = await asking();

        permission.answer(decision({ behavior: 'deny', ...message }));

        expect((await agent.ended).status).toBe(0);
        expect((await receiver.next('PostToolBatch')).payload).toEqual(
          batchOfTheCall(agent, 'denied', call),
        );
        expect(postedEvents().slice(3)).toEqual(['PostToolBatch', 'Stop', 'SessionEnd']);
      },
    );

    it('on deny with interrupt, ends the turn as an interruption: the marker in the transcript, no Stop', async () => {
      const { agent, permission } = await asking();

      permission.answer(decision({ behavior: 'deny', interrupt: true }));

      expect((await agent.ended).status).toBe(0);
      expect(postedEvents().slice(3)).toEqual(['SessionEnd']);
      expect(transcriptTexts(agent)).toEqual([
        'Make b.txt',
        '[Request interrupted by user for tool use]',
      ]);
    });

    it("on the person's Esc, closes the held connection and ends the turn as an interruption", async () => {
      const { agent, permission } = await asking();

      answerInTerminal(agent.folder, 'esc');

      await permission.closedBySender;
      expect((await agent.ended).status).toBe(0);
      expect(postedEvents().slice(3)).toEqual(['SessionEnd']);
      expect(transcriptTexts(agent).at(-1)).toBe('[Request interrupted by user for tool use]');
    });

    it("on the person's Yes, fires PostToolUse and the PostToolBatch of a call that ran, the connection left open, the turn going on", async () => {
      const { agent, permission } = await asking(ASK_THEN_HOLD);

      answerInTerminal(agent.folder, 'yes');

      await receiver.next('Stop');
      expect((await receiver.next('PostToolBatch')).payload).toEqual(batchOfTheCall(agent, 'ran'));
      expect(postedEvents().slice(3)).toEqual(['PostToolUse', 'PostToolBatch', 'Stop']);
      expect(permission.isOpen()).toBe(true);
    });

    it("on the person's amended No, fires the PostToolBatch of a refused call, the connection left open, the turn going on", async () => {
      const { agent, permission } = await asking(ASK_THEN_HOLD);

      answerInTerminal(agent.folder, 'amended-no');

      await receiver.next('Stop');
      expect((await receiver.next('PostToolBatch')).payload).toEqual(
        batchOfTheCall(agent, 'refused'),
      );
      expect(postedEvents().slice(3)).toEqual(['PostToolBatch', 'Stop']);
      expect(permission.isOpen()).toBe(true);
    });
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
