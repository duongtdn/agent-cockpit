import { describe, expect, it, vi } from 'vitest';
import { CANNOT_PLAY_STATUS } from '../support/fake-agent/agent.ts';
import type { TaskStep } from '../support/fake-agent/script.ts';
import { failureOf } from '../support/fake-agent/turn-failures.ts';
import { apiError } from '../support/fake-api/index.ts';
import { API_BASE_URL, type Played, playFakeAgent, submit } from '../support/played-fake-agent.ts';

const touch = {
  do: 'tool',
  name: 'Bash',
  input: { command: 'touch inner.txt' },
  result: '(Bash completed with no output)',
} as const;
const reply = (text: string) => ({ do: 'reply', text }) as const;
const task: TaskStep = {
  do: 'task',
  description: 'Count files',
  prompt: 'Count the files.',
  agentType: 'general-purpose',
  work: [touch, reply('Counted.')],
};

async function refused(played: Played, problem: RegExp): Promise<void> {
  await vi.waitFor(() => expect(played.exits).toEqual([CANNOT_PLAY_STATUS]));
  expect(played.screen().problem).toMatch(problem);
}

function fieldsOf(played: Played, event: string, nth = 0): Readonly<Record<string, unknown>> {
  return played.events.filter((fired) => fired.name === event)[nth]?.fields ?? {};
}

describe('how a turn fails on an error of the API, seen of Claude Code 2.1.332', () => {
  const gateway = 'http://127.0.0.1:4010';

  it.each([
    [529, 'server_error', `API Error: 529 ${apiError(529).message}. This is a server-side issue`],
    [500, 'server_error', `API Error: 500 ${apiError(500).message}. This is a server-side issue`],
    [429, 'rate_limit', `API Error: Request rejected (429) · ${apiError(429).message}`],
    [401, 'authentication_failed', `Please run /login · API Error: 401 ${apiError(401).message}`],
    [403, 'authentication_failed', `Please run /login · API Error: 403 ${apiError(403).message}`],
  ])('names a %i %s, with the API message', (status, error, message) => {
    const failure = failureOf(status, gateway);

    expect(failure.error).toBe(error);
    expect(failure.message.startsWith(message)).toBe(true);
  });

  it('names the API it calls in a server error', () => {
    expect(failureOf(529, gateway).message).toMatch(
      /If it persists, check your inference gateway \(127\.0\.0\.1:4010\)\.$/,
    );
  });

  it('refuses a status no failure was seen for, and a server error with no API address', () => {
    expect(() => failureOf(400, gateway)).toThrow(/status 400.*not observed/);
    expect(() => failureOf(529, undefined)).toThrow(/no ANTHROPIC_BASE_URL/);
  });
});

describe('the fake agent, failing a turn', () => {
  it('fires StopFailure, never Stop, records the error, and takes the next prompt (behavior 64)', async () => {
    const played = await playFakeAgent({
      script: [[touch, { do: 'fail', status: 529 }], [reply('Again.')]],
      allowRules: ['Bash'],
    });

    submit(played, 'fail please');
    await vi.waitFor(() => expect(played.fired.at(-1)).toBe('StopFailure'));
    expect(played.fired).not.toContain('Stop');
    expect(fieldsOf(played, 'StopFailure')).toMatchObject({ error: 'server_error' });
    expect(played.recorded.at(-1)).toMatch(/^API Error: 529/);
    expect(played.screen().state).toBe('idle');

    submit(played, 'again');
    await vi.waitFor(() => expect(played.fired.at(-1)).toBe('Stop'));
  });

  it('refuses a failure it has no evidence for', async () => {
    const played = await playFakeAgent({ script: [[{ do: 'fail', status: 418 }]] });

    submit(played, 'fail please');

    await refused(played, /status 418/);
  });
});

describe('the fake agent, with a task in the background', () => {
  async function startedTask(release: Promise<void>): Promise<Played> {
    const played = await playFakeAgent({
      script: [[task, reply('Started.')], [reply('Noted.')]],
      allowRules: ['Bash'],
      tasksReleased: release,
    });
    submit(played, 'start a task');
    await vi.waitFor(() => expect(played.fired).toContain('Stop'));
    return played;
  }

  it('starts the subagent with the Agent call, and Stop lists it running (behaviors 15, 73)', async () => {
    const played = await startedTask(new Promise(() => {}));

    expect(played.fired).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'SubagentStart',
      'PostToolUse',
      'PostToolBatch',
      'MessageDisplay',
      'Stop',
    ]);
    const { agent_id: agentId } = fieldsOf(played, 'SubagentStart');
    expect(agentId).toMatch(/^a[0-9a-f]{16}$/);
    expect(fieldsOf(played, 'PreToolUse')).toMatchObject({
      tool_name: 'Agent',
      tool_input: {
        description: 'Count files',
        prompt: 'Count the files.',
        subagent_type: 'general-purpose',
      },
    });
    expect(fieldsOf(played, 'PostToolUse')).toMatchObject({
      tool_response: { isAsync: true, status: 'async_launched', agentId },
    });
    expect(fieldsOf(played, 'Stop').background_tasks).toEqual([
      {
        id: agentId,
        type: 'subagent',
        status: 'running',
        description: 'Count files',
        agent_type: 'general-purpose',
      },
    ]);
    expect(played.screen().state).toBe('idle');
  });

  it("plays the subagent's work once let, its hooks naming it, then a turn of its notification (behavior 62)", async () => {
    let release = () => {};
    const played = await startedTask(new Promise((resolve) => (release = resolve)));

    release();

    await vi.waitFor(() => expect(played.fired.filter((name) => name === 'Stop')).toHaveLength(2));
    expect(played.fired.slice(8)).toEqual([
      'PreToolUse',
      'PostToolUse',
      'PostToolBatch',
      'SubagentStop',
      'UserPromptSubmit',
      'MessageDisplay',
      'Stop',
    ]);
    const agent = {
      agent_id: fieldsOf(played, 'SubagentStart').agent_id,
      agent_type: 'general-purpose',
    };
    expect(fieldsOf(played, 'PreToolUse', 1)).toMatchObject({ ...agent, tool_name: 'Bash' });
    expect(fieldsOf(played, 'SubagentStop')).toMatchObject({
      ...agent,
      last_assistant_message: 'Counted.',
    });
    const notification = String(fieldsOf(played, 'UserPromptSubmit', 1).prompt);
    expect(notification).toMatch(/^<task-notification>\n<task-id>a[0-9a-f]{16}<\/task-id>/);
    expect(notification).toContain('<result>Counted.</result>');
    expect(notification).toContain('<tool_uses>1</tool_uses>');
    expect(fieldsOf(played, 'Stop', 1).background_tasks).toEqual([]);
  });

  it("refuses a subagent's call that would ask", async () => {
    const played = await playFakeAgent({ script: [[task, reply('Started.')], [reply('Noted.')]] });

    submit(played, 'start a task');

    await refused(played, /does not run unasked/);
  });

  it('refuses a typed prompt while its task is pending', async () => {
    const played = await startedTask(new Promise(() => {}));

    submit(played, 'anything else?');

    await refused(played, /background task is pending/);
  });

  it('refuses a task in a mode it was not seen in', async () => {
    const played = await playFakeAgent({
      script: [[task, reply('Started.')]],
      mode: 'acceptEdits',
    });

    submit(played, 'start a task');

    await refused(played, /acceptEdits mode/);
  });
});

describe('the fake agent, compacting on /compact', () => {
  const compaction = [[reply('Something.')], [{ do: 'compact', summary: 'The summary.' }]] as const;

  it('fires PreCompact, its two helpers end, starts again from the summary, then PostCompact (behavior 16)', async () => {
    const played = await playFakeAgent({ script: compaction });
    submit(played, 'say something');
    await vi.waitFor(() => expect(played.fired).toContain('Stop'));

    submit(played, '/compact');

    await vi.waitFor(() => expect(played.fired.at(-1)).toBe('PostCompact'));
    expect(played.fired.slice(4)).toEqual([
      'PreCompact',
      'SubagentStop',
      'SubagentStop',
      'SessionStart',
      'PostCompact',
    ]);
    expect(fieldsOf(played, 'PreCompact')).toMatchObject({
      trigger: 'manual',
      custom_instructions: null,
    });
    expect(fieldsOf(played, 'SubagentStop')).toMatchObject({
      agent_type: '',
      last_assistant_message: 'The summary.',
    });
    expect(fieldsOf(played, 'SessionStart', 1)).toMatchObject({ source: 'compact' });
    expect(fieldsOf(played, 'PostCompact')).toMatchObject({ compact_summary: 'The summary.' });
    expect(played.screen().state).toBe('idle');
    expect(played.recorded.slice(2)).toEqual([
      'caveat',
      '/compact',
      'output: Compacted (ctrl+o to see full summary)',
    ]);
  });

  it('fails on an error of the API: PreCompact, then StopFailure with the agent_id of its own agent, of no type, and no PostCompact; records the command with its error (behavior 123)', async () => {
    const played = await playFakeAgent({
      script: [[reply('Something.')], [{ do: 'compact-fails', status: 500 }]],
    });
    submit(played, 'say something');
    await vi.waitFor(() => expect(played.fired).toContain('Stop'));

    submit(played, '/compact');

    await vi.waitFor(() => expect(played.fired.at(-1)).toBe('StopFailure'));
    const message = failureOf(500, API_BASE_URL).message;
    expect(played.fired.slice(4)).toEqual(['PreCompact', 'StopFailure']);
    expect(fieldsOf(played, 'StopFailure')).toMatchObject({
      agent_id: expect.stringMatching(/^a[0-9a-f]{16}$/),
      error: 'server_error',
      last_assistant_message: message,
    });
    expect(fieldsOf(played, 'StopFailure')).not.toHaveProperty('agent_type');
    expect(played.recorded.slice(2)).toEqual([
      'caveat',
      '/compact',
      `error: Error during compaction: ${message}`,
    ]);
    expect(played.screen()).toMatchObject({ state: 'idle', compacting: false });
  });

  describe('until a person interrupts it with Esc', () => {
    async function compacting(): Promise<Played> {
      const played = await playFakeAgent({
        script: [[reply('Something.')], [{ do: 'compact-stays' }], [reply('After.')]],
      });
      submit(played, 'say something');
      await vi.waitFor(() => expect(played.fired).toContain('Stop'));
      submit(played, '/compact');
      await vi.waitFor(() => expect(played.fired.at(-1)).toBe('PreCompact'));
      return played;
    }

    it('ends with no hook, records the caveat alone, and puts /compact back in the box with its hint (behavior 124)', async () => {
      const played = await compacting();
      expect(played.screen()).toMatchObject({ state: 'busy', compacting: true });

      played.agent.press({ kind: 'escape' });

      await vi.waitFor(() => expect(played.screen().state).toBe('idle'));
      expect(played.fired.slice(4)).toEqual(['PreCompact']);
      expect(played.recorded.slice(2)).toEqual(['caveat']);
      expect(played.screen()).toMatchObject({ compacting: false });
      expect(played.screen().box.rows).toEqual([
        '❯\u00a0/compact  <optional custom summarization instructions>',
      ]);
    });

    it('takes Ctrl+U on the command put back, which clears the box and its hint, then the next prompt', async () => {
      const played = await compacting();
      played.agent.press({ kind: 'escape' });
      await vi.waitFor(() => expect(played.screen().state).toBe('idle'));

      played.agent.press({ kind: 'kill-line' });
      expect(played.screen().box.rows).toEqual(['❯\u00a0']);
      submit(played, 'say more');

      await vi.waitFor(() => expect(played.fired.at(-1)).toBe('Stop'));
      expect(fieldsOf(played, 'Stop', 1)).toMatchObject({ last_assistant_message: 'After.' });
    });

    it('refuses any other key on the command put back, and an Esc over a draft', async () => {
      const keyed = await compacting();
      keyed.agent.press({ kind: 'escape' });
      await vi.waitFor(() => expect(keyed.screen().state).toBe('idle'));
      keyed.agent.press({ kind: 'text', text: 'x' });
      await refused(keyed, /put back/);

      const drafted = await compacting();
      drafted.agent.press({ kind: 'text', text: 'a draft' });
      drafted.agent.press({ kind: 'escape' });
      await refused(drafted, /draft/);
    });
  });

  it('refuses /compact on a conversation with nothing in it', async () => {
    const played = await playFakeAgent({ script: compaction });

    submit(played, '/compact');

    await refused(played, /nothing in it/);
  });

  it('refuses a prompt that meets the compaction, and /compact that meets a turn', async () => {
    const meetsCompaction = await playFakeAgent({ script: [[{ do: 'compact', summary: 's' }]] });
    submit(meetsCompaction, 'say something');
    await refused(meetsCompaction, /only \/compact plays it/);

    const meetsTurn = await playFakeAgent({ script: [[reply('One.')], [reply('Two.')]] });
    submit(meetsTurn, 'say something');
    await vi.waitFor(() => expect(meetsTurn.fired).toContain('Stop'));
    submit(meetsTurn, '/compact');
    await refused(meetsTurn, /does not compact/);
  });

  it('refuses any other local command', async () => {
    const played = await playFakeAgent({ script: [] });

    submit(played, '/help');

    await refused(played, /local command "\/help"/);
  });
});
