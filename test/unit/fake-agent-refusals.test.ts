import { describe, expect, it, vi } from 'vitest';
import {
  CANNOT_PLAY_STATUS,
  createFakeAgent,
  type FakeAgent,
} from '../support/fake-agent/agent.ts';
import type { ScreenView } from '../support/fake-agent/screen.ts';
import type { Turn } from '../support/fake-agent/script.ts';

const touch = { do: 'tool', name: 'Bash', input: { command: 'touch a.txt' } } as const;
const write = { do: 'tool', name: 'Write', input: { file_path: 'a.txt', content: '' } } as const;
const reply = { do: 'reply', text: 'Done.' } as const;

/** A fake agent with nothing around it, and what it showed, fired and exited with. */
interface Played {
  readonly agent: FakeAgent;
  /** The names of the hook events fired, in order. */
  readonly fired: string[];
  /** The statuses the agent exited with: one at most, unless it went on after its exit. */
  readonly exits: number[];
  /** What the screen shows now. */
  screen(): ScreenView;
}

/** What a test chooses about an agent: its script, its mode, what its hooks answer by event. */
interface Playing {
  readonly script: readonly Turn[] | (() => readonly Turn[]);
  readonly mode?: string;
  readonly hookAnswers?: Readonly<Record<string, unknown>>;
}

async function start({ script, mode = 'default', hookAnswers = {} }: Playing): Promise<Played> {
  const fired: string[] = [];
  const exits: number[] = [];
  const views: ScreenView[] = [];
  const agent = createFakeAgent({
    commandLine: {
      sessionId: '6f1c2f0e-3b1a-4c66-9d57-0a4b8a3e5c11',
      resumes: false,
      settingsFile: undefined,
      permissionMode: mode,
      prompt: undefined,
    },
    hooks: {
      fire: async (event) => {
        fired.push(event.name);
        return [hookAnswers[event.name] ?? {}];
      },
    },
    transcript: { recordPrompt: () => {}, recordReply: () => {}, recordInterruption: () => {} },
    promptsTaken: 0,
    startReleased: async () => {},
    readScript: typeof script === 'function' ? script : () => script,
    show: (view) => views.push(view),
    exit: (status) => exits.push(status),
  });
  await agent.start();
  return { agent, fired, exits, screen: () => views.at(-1) as ScreenView };
}

function submit(played: Played, prompt: string): void {
  played.agent.press({ kind: 'text', text: prompt });
  played.agent.press({ kind: 'enter' });
}

/** Waits until the agent has failed, and checks it said why and went no further. */
async function expectFailure(played: Played, problem: RegExp): Promise<void> {
  await vi.waitFor(() => expect(played.exits).toEqual([CANNOT_PLAY_STATUS]));
  expect(played.screen().problem).toMatch(problem);
  const firedThen = [...played.fired];
  submit(played, 'anyone there?');
  played.agent.press({ kind: 'escape' });
  await played.agent.terminate();
  expect(played.fired).toEqual(firedThen);
  expect(played.exits).toEqual([CANNOT_PLAY_STATUS]);
}

describe('the fake agent, asked to play what it has no evidence for', () => {
  it('exits with a status that is no success and no signal', () => {
    expect(CANNOT_PLAY_STATUS).toBeGreaterThan(0);
    expect(CANNOT_PLAY_STATUS).toBeLessThan(126);
  });

  it('fails on a prompt its script has no turn for, and answers nothing', async () => {
    const played = await start({ script: [[reply]] });
    submit(played, 'scripted');
    await vi.waitFor(() => expect(played.fired).toContain('Stop'));

    submit(played, 'not scripted');

    await expectFailure(played, /no turn for prompt 2.*1 turn/);
    expect(played.fired).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop']);
  });

  it('fails on a script it cannot read', async () => {
    const played = await start({
      script: () => {
        throw new Error('turn 1 has no step');
      },
    });

    submit(played, 'hello');

    await expectFailure(played, /turn 1 has no step/);
  });

  it('fails on an Enter while a turn runs, whatever the input box holds', async () => {
    for (const typed of ['and this too', '']) {
      const played = await start({ script: [[{ do: 'stay-busy' }]] });
      submit(played, 'work');
      await vi.waitFor(() => expect(played.fired).toContain('UserPromptSubmit'));

      played.agent.press({ kind: 'text', text: typed });
      played.agent.press({ kind: 'enter' });

      await expectFailure(played, /Enter.*while a turn runs/);
      expect(played.fired).toEqual(['SessionStart', 'UserPromptSubmit']);
    }
  });

  it('still loses the Enter of an idle session with an empty input box', async () => {
    const played = await start({ script: [[reply]] });

    played.agent.press({ kind: 'enter' });
    submit(played, 'hello');

    await vi.waitFor(() => expect(played.fired).toContain('Stop'));
    expect(played.exits).toEqual([]);
  });

  it.each(['deny', 'ask', 'defer'])(
    'fails when a PreToolUse hook answers "%s"',
    async (decision) => {
      const played = await start({
        script: [[touch, reply]],
        hookAnswers: {
          PreToolUse: {
            hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision },
          },
        },
      });

      submit(played, 'touch it');

      await expectFailure(played, new RegExp(`PreToolUse.*"${decision}"`));
      expect(played.fired).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse']);
    },
  );

  it.each(['acceptEdits', 'plan', 'auto', 'bypassPermissions'])(
    'fails on a tool that is no touch in the %s mode, and runs a touch',
    async (mode) => {
      const played = await start({
        script: [
          [touch, reply],
          [write, reply],
        ],
        mode,
      });
      submit(played, 'touch it');
      await vi.waitFor(() => expect(played.fired).toContain('Stop'));
      expect(played.fired).toEqual([
        'SessionStart',
        'UserPromptSubmit',
        'PreToolUse',
        'PostToolUse',
        'Stop',
      ]);

      submit(played, 'write it');

      await expectFailure(played, new RegExp(`Write.*${mode}`));
      expect(played.fired.slice(5)).toEqual(['UserPromptSubmit', 'PreToolUse']);
    },
  );

  it('fails on a call in a mode it does not know', async () => {
    const played = await start({ script: [[touch, reply]], mode: 'yolo' });

    submit(played, 'touch it');

    await expectFailure(played, /Bash.*yolo/);
  });
});
