import { createFakeAgent, type FakeAgent } from './fake-agent/agent.ts';
import type { StartUpDialogKind } from './fake-agent/configuration.ts';
import type { HookEvent } from './fake-agent/hook-events.ts';
import type { ScreenView } from './fake-agent/screen.ts';
import type { Turn } from './fake-agent/script.ts';

/** A fake agent with nothing around it, and what it showed, fired, recorded and exited with. */
export interface Played {
  readonly agent: FakeAgent;
  /** The hook events fired, in order. */
  readonly events: HookEvent[];
  /** The names of the hook events fired, in order. */
  readonly fired: string[];
  /** What the transcript recorded, in order: each prompt, reply and interruption marker. */
  readonly recorded: string[];
  /** The statuses the agent exited with: one at most, unless it went on after its exit. */
  readonly exits: number[];
  /** What the agent wrote of the start-up dialogs' answers, in order: `accept <dialog>`, `reject-key`. */
  readonly answersWritten: string[];
  /** What the screen shows now. */
  screen(): ScreenView;
}

/** What a test chooses about an agent: its script, its mode, what its hooks answer by event. */
export interface Playing {
  readonly script: readonly Turn[] | (() => readonly Turn[]);
  readonly mode?: string;
  /** What the one hook of an event answers, or a promise of it; `{}` for an event not named. */
  readonly hookAnswers?: Readonly<Record<string, unknown>>;
  /** The events the settings give no hook; none by default: every event has its hook. */
  readonly withoutHooksFor?: readonly string[];
  /** The rules the settings allow tool calls by; none by default. */
  readonly allowRules?: readonly string[];
  /** The paths the settings deny (folders to `Read` and `Edit`, files to `Edit`); none by default. */
  readonly deniedPaths?: readonly string[];
  /** Whether the agent resumes a conversation, and how long ago it last answered in it; a new one by default. */
  readonly resumedAfterSeconds?: number;
  /** The start-up dialogs the configuration shows; none by default. */
  readonly startUpDialogs?: readonly StartUpDialogKind[];
  /** The prompt given on the command line; none by default. */
  readonly prompt?: string;
  /** Whether the person declined the environment's key before; not by default. */
  readonly keyRejected?: boolean;
  /** The API's address; the scripted API's usual one by default. */
  readonly apiBaseUrl?: string;
  /** Fulfilled when the test lets background tasks work; at once by default. */
  readonly tasksReleased?: Promise<void>;
}

/** The API's address a played agent is given unless the test says otherwise. */
export const API_BASE_URL = 'http://127.0.0.1:4010';

/** The folder a played agent says it runs in. */
export const WORK_FOLDER = '/work';

/**
 * Starts a fake agent in memory, for a test of what it plays: no process, no
 * terminal, one hook an event that answers what the test says.
 *
 * @param playing - See {@link Playing}.
 * @returns The agent, started and idle, with what it did so far.
 */
export async function playFakeAgent({
  script,
  mode = 'default',
  hookAnswers = {},
  withoutHooksFor = [],
  allowRules = [],
  deniedPaths = [],
  resumedAfterSeconds,
  startUpDialogs = [],
  keyRejected = false,
  prompt,
  apiBaseUrl = API_BASE_URL,
  tasksReleased = Promise.resolve(),
}: Playing): Promise<Played> {
  const events: HookEvent[] = [];
  const fired: string[] = [];
  const recorded: string[] = [];
  const exits: number[] = [];
  const views: ScreenView[] = [];
  const answersWritten: string[] = [];
  const agent = createFakeAgent({
    commandLine: {
      sessionId: '6f1c2f0e-3b1a-4c66-9d57-0a4b8a3e5c11',
      resumes: resumedAfterSeconds !== undefined,
      settingsFile: undefined,
      permissionMode: mode,
      model: 'haiku',
      prompt,
    },
    hooks: {
      configures: (event) => !withoutHooksFor.includes(event),
      fire: async (event) => {
        events.push(event);
        fired.push(event.name);
        const answer = hookAnswers[event.name] ?? {};
        // A plain answer comes at once, as it always did; a promised one when it settles.
        return [answer instanceof Promise ? await answer : answer];
      },
    },
    transcript: {
      recordPrompt: (prompt) => recorded.push(prompt),
      recordReply: (text) => recorded.push(text),
      recordToolCall: () => {},
      recordInterruption: (marker) => recorded.push(marker),
      recordApiError: ({ message }) => recorded.push(message),
    },
    promptsTaken: 0,
    secondsSinceLastResponse: resumedAfterSeconds,
    workFolder: WORK_FOLDER,
    allowRules,
    deniedPaths,
    configuration: {
      startUpDialogs,
      keyRejected,
      accept: (dialog) => answersWritten.push(`accept ${dialog}`),
      rejectKey: () => answersWritten.push('reject-key'),
    },
    dialogSubjects: { folder: WORK_FOLDER, keySuffix: '000000000-FAKEFAKEAA' },
    apiBaseUrl,
    taskFiles: (agentId) => ({
      outputFile: `/tmp/tasks/${agentId}.output`,
      transcriptPath: `/config/subagents/agent-${agentId}.jsonl`,
    }),
    startReleased: async () => {},
    tasksReleased: () => tasksReleased,
    readScript: typeof script === 'function' ? script : () => script,
    show: (view) => views.push(view),
    exit: (status) => exits.push(status),
  });
  // A session that shows a start-up dialog starts once it is answered: the test answers it.
  if (startUpDialogs.length === 0) await agent.start();
  else void agent.start();
  return {
    agent,
    events,
    fired,
    recorded,
    exits,
    answersWritten,
    screen: () => views.at(-1) as ScreenView,
  };
}

/** Types a prompt into a played agent and presses Enter. */
export function submit(played: Played, prompt: string): void {
  played.agent.press({ kind: 'text', text: prompt });
  played.agent.press({ kind: 'enter' });
}
