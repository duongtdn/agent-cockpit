import { expect, it } from 'vitest';
import type { TurnError } from '../../src/shared/session.ts';
import type { TranscriptEntry } from '../support/agent-session.ts';
import { eventually } from '../support/eventually.ts';
import { apiError, type ScriptedAnswer, turn } from '../support/fake-api/index.ts';
import {
  type ContractCockpit,
  type HookPayload,
  type Moment,
  SAID_KEY,
  sessionAfter,
  startContractCockpit,
} from './cockpit-harness.ts';

/** A turn the API fails, met by a cockpit with the driver's own launch and hooks. */

/** The agent tries a failed request once more: a retry is seen, and is short. */
const ONE_RETRY = { CLAUDE_CODE_MAX_RETRIES: '1' };

function eventOf(moment: Moment): unknown {
  return 'hook' in moment ? moment.hook.hook_event_name : undefined;
}

/** The hooks read since a moment of the timeline, by event. */
function eventsSince(cockpit: ContractCockpit, from: number): unknown[] {
  return cockpit.timeline
    .slice(from)
    .map(eventOf)
    .filter((event) => event !== undefined);
}

/**
 * The last entry of the conversation a transcript records: the agent
 * writes entries of its own bookkeeping after it (`last-prompt`, `mode`,
 * `permission-mode`, `atis-latch`), which are no message.
 */
function lastMessageOf(transcript: readonly TranscriptEntry[]): TranscriptEntry | undefined {
  return transcript.findLast((entry) => entry.type === 'user' || entry.type === 'assistant');
}

const FAILURES: readonly {
  readonly answers: readonly ScriptedAnswer[];
  readonly kind: TurnError['kind'];
}[] = [
  // Overloaded, then overloaded again on the retry.
  { answers: [apiError(529), apiError(529)], kind: 'server' },
  { answers: [apiError(500), apiError(500)], kind: 'server' },
  { answers: [apiError(429), apiError(429)], kind: 'rate-limit' },
  // Taken as final: not tried again.
  { answers: [apiError(403)], kind: 'other' },
];

it("64 — A turn that fails on an API error fires StopFailure (error, last_assistant_message) and no Stop; no hook fires while the agent retries; the transcript's last entry has isApiErrorMessage; the session then takes prompts", async () => {
  const cockpit = await startContractCockpit({ shim: { variables: ONE_RETRY } });
  for (const { answers } of FAILURES) cockpit.api.script(...answers);
  cockpit.api.script(turn('Answered.'));
  const session = () => cockpit.terminal(SAID_KEY);

  let from = 0;
  let requests = 0;
  for (const [index, { answers, kind }] of FAILURES.entries()) {
    if (index === 0) {
      expect(await cockpit.say('the first')).toEqual({ action: 'started', state: 'busy' });
    } else {
      await cockpit.submitInTerminal(SAID_KEY, `prompt ${index + 1}`);
    }
    const idle = await sessionAfter(cockpit, 'idle', from);
    requests += answers.length;

    expect(idle, kind).toMatchObject({ state: 'idle', error: { kind } });
    expect(idle.state === 'idle' && idle.error?.message, kind).toMatch(/\S/);
    const events = eventsSince(cockpit, from).filter((event) => event !== 'SessionStart');
    expect(events, kind).toEqual(['UserPromptSubmit', 'StopFailure']);
    const failure = cockpit.timeline
      .slice(from)
      .find((moment) => eventOf(moment) === 'StopFailure') as { hook: HookPayload };
    expect(failure.hook, kind).toMatchObject({
      error: expect.any(String),
      last_assistant_message: expect.any(String),
    });
    // Written as the turn ends: the hook may come first.
    await eventually(() =>
      expect(lastMessageOf(session().transcript()), kind).toMatchObject({
        type: 'assistant',
        isApiErrorMessage: true,
      }),
    );
    expect(
      cockpit.api.requests().filter((request) => request.kind === 'conversation'),
      kind,
    ).toHaveLength(requests);
    from = cockpit.timeline.length;
  }

  await cockpit.submitInTerminal(SAID_KEY, 'the last');
  const answered = await sessionAfter(cockpit, 'idle', from);

  expect(answered).toMatchObject({ state: 'idle', lastMessage: 'Answered.' });
  expect(answered).not.toHaveProperty('error');
  expect(eventsSince(cockpit, from)).toEqual(['UserPromptSubmit', 'Stop']);
});
