import { describe, expect, it } from 'vitest';
import type { DriverEvent } from '../../src/server/driver.ts';
import { courseAfter, type SessionCourse } from '../../src/server/sessions/session-states.ts';
import type { BackgroundTask, IdleSession, Session } from '../../src/shared/session.ts';

const KEY = 'chapter-1';
const BEFORE = '2026-11-26T10:00:00.000Z';
const NOW = '2026-11-26T10:05:00.000Z';

const reviewer: BackgroundTask = { id: 'a1', type: 'general-purpose', description: 'Review a.ts' };
const tests: BackgroundTask = { id: 'b2', type: 'shell', description: 'Run the tests' };

const starting: Session = { key: KEY, state: 'starting', since: BEFORE };
const busy: Session = { key: KEY, state: 'busy', since: BEFORE };
const waiting: Session = {
  key: KEY,
  state: 'waiting',
  since: BEFORE,
  pending: [{ kind: 'terminal', dialog: 'trust-folder' }],
};
const idle: IdleSession = { key: KEY, state: 'idle', since: BEFORE, lastMessage: 'Done.' };
const idleWithTasks: IdleSession = { ...idle, backgroundTasks: [reviewer, tests] };
const failed: IdleSession = {
  key: KEY,
  state: 'idle',
  since: BEFORE,
  error: { kind: 'server', message: 'API Error: 529 Overloaded.' },
};

const overloaded: DriverEvent = {
  type: 'turn-failed',
  error: { kind: 'server', message: 'API Error: 529 Overloaded.' },
};

/** The session after one event, launched with a prompt. */
function sessionAfterOne(session: Session, event: DriverEvent, launchedWithPrompt = true): Session {
  return courseAfter({ session }, event, launchedWithPrompt, NOW).session;
}

/** The course after several events, in order. */
function afterEvents(course: SessionCourse, events: readonly DriverEvent[]): SessionCourse {
  return events.reduce((current, event) => courseAfter(current, event, true, NOW), course);
}

describe('a session after an event of its agent', () => {
  it.each<[string, Session, DriverEvent, boolean, Session]>([
    [
      'ready, launched without a prompt',
      starting,
      { type: 'ready' },
      false,
      { key: KEY, state: 'idle', since: NOW },
    ],
    [
      'a prompt taken at launch',
      starting,
      { type: 'prompt-taken' },
      true,
      { key: KEY, state: 'busy', since: NOW },
    ],
    [
      'a prompt taken while idle',
      idle,
      { type: 'prompt-taken' },
      true,
      { key: KEY, state: 'busy', since: NOW },
    ],
    [
      "the agent's own turn, a task finished",
      idleWithTasks,
      { type: 'prompt-taken' },
      true,
      { key: KEY, state: 'busy', since: NOW },
    ],
    [
      'a later turn after a failed one',
      failed,
      { type: 'prompt-taken' },
      true,
      { key: KEY, state: 'busy', since: NOW },
    ],
    [
      'a tool while waiting',
      waiting,
      { type: 'working' },
      true,
      { key: KEY, state: 'busy', since: NOW },
    ],
    [
      'the end of a turn',
      busy,
      { type: 'turn-ended', lastMessage: 'Done.' },
      true,
      { key: KEY, state: 'idle', since: NOW, lastMessage: 'Done.' },
    ],
    [
      'the end of a turn with no message',
      busy,
      { type: 'turn-ended' },
      true,
      { key: KEY, state: 'idle', since: NOW },
    ],
    ['a failed turn', busy, overloaded, true, { ...failed, since: NOW }],
    [
      'an interruption',
      busy,
      { type: 'interrupted' },
      true,
      { key: KEY, state: 'idle', since: NOW },
    ],
    [
      'an interruption while waiting',
      waiting,
      { type: 'interrupted' },
      true,
      { key: KEY, state: 'idle', since: NOW },
    ],
    [
      'a failed turn while waiting',
      waiting,
      { type: 'turn-failed', error: { kind: 'rate-limit', message: 'Slow down.' } },
      true,
      { key: KEY, state: 'idle', since: NOW, error: { kind: 'rate-limit', message: 'Slow down.' } },
    ],
    [
      'a compaction begun while idle',
      idle,
      { type: 'compaction-began' },
      true,
      { key: KEY, state: 'busy', since: NOW },
    ],
    [
      'the tasks at the end of a turn',
      idle,
      { type: 'tasks', running: [reviewer] },
      true,
      { ...idle, backgroundTasks: [reviewer] },
    ],
    [
      'no task left at the end of a turn',
      idleWithTasks,
      { type: 'tasks', running: [] },
      true,
      idle,
    ],
    [
      'a task finished',
      idleWithTasks,
      { type: 'task-finished', id: 'a1' },
      true,
      { ...idle, backgroundTasks: [tests] },
    ],
    [
      'the last task finished',
      { ...idle, backgroundTasks: [reviewer] },
      { type: 'task-finished', id: 'a1' },
      true,
      idle,
    ],
  ])('%s', (_, session, event, launchedWithPrompt, expected) => {
    expect(sessionAfterOne(session, event, launchedWithPrompt)).toEqual(expected);
  });

  it.each<[string, Session, DriverEvent]>([
    ['ready, launched with a prompt', starting, { type: 'ready' }],
    ['ready once started', busy, { type: 'ready' }],
    ['a prompt taken while busy', busy, { type: 'prompt-taken' }],
    ['a tool while busy', busy, { type: 'working' }],
    ['the end of a turn while idle', idle, { type: 'turn-ended', lastMessage: 'Other.' }],
    ['a failed turn while idle', idle, overloaded],
    ['an interruption while idle', idle, { type: 'interrupted' }],
    ['a compaction begun while busy', busy, { type: 'compaction-began' }],
    ['a compaction begun while waiting', waiting, { type: 'compaction-began' }],
    ['a compaction begun while starting', starting, { type: 'compaction-began' }],
    ['a compaction ended that began in a turn', busy, { type: 'compaction-ended' }],
    ['tasks while busy', busy, { type: 'tasks', running: [reviewer] }],
    ['no task, none listed', idle, { type: 'tasks', running: [] }],
    ['a task finished while busy', busy, { type: 'task-finished', id: 'a1' }],
    ['a task the session does not list', idleWithTasks, { type: 'task-finished', id: 'helper' }],
    ['a task finished, none listed', idle, { type: 'task-finished', id: 'a1' }],
    ['the agent ending', busy, { type: 'ending', reason: 'agent-exit' }],
  ])('%s: nothing changes, the same session', (_, session, event) => {
    expect(sessionAfterOne(session, event)).toBe(session);
  });

  it('keeps the error of a failed turn until a later turn', () => {
    const course = afterEvents({ session: busy }, [overloaded, { type: 'tasks', running: [] }]);

    expect(course.session).toEqual({ ...failed, since: NOW });
    expect(afterEvents(course, [{ type: 'prompt-taken' }, { type: 'turn-ended' }]).session).toEqual(
      {
        key: KEY,
        state: 'idle',
        since: NOW,
      },
    );
  });
});

describe('a compaction', () => {
  it('begun while idle returns to that idle session, its since and all it carried', () => {
    const course = afterEvents({ session: idleWithTasks }, [
      { type: 'compaction-began' },
      { type: 'compaction-ended' },
    ]);

    expect(course).toEqual({ session: idleWithTasks });
  });

  it('begun while idle remembers it until it ends', () => {
    expect(courseAfter({ session: idle }, { type: 'compaction-began' }, true, NOW)).toEqual({
      session: { key: KEY, state: 'busy', since: NOW },
      compactingFrom: idle,
    });
  });

  it('begun after a failed turn returns to it with its error', () => {
    expect(
      afterEvents({ session: failed }, [
        { type: 'compaction-began' },
        { type: 'compaction-ended' },
      ]),
    ).toEqual({ session: failed });
  });

  it('keeps the tasks that change meanwhile for the idle session it returns to', () => {
    const course = afterEvents({ session: idleWithTasks }, [
      { type: 'compaction-began' },
      { type: 'task-finished', id: 'a1' },
      { type: 'compaction-ended' },
    ]);

    expect(course.session).toEqual({ ...idle, backgroundTasks: [tests] });
  });

  it('begun inside a turn changes nothing, nor does its end', () => {
    const course = afterEvents({ session: busy }, [
      { type: 'compaction-began' },
      { type: 'compaction-ended' },
    ]);

    expect(course).toEqual({ session: busy });
  });

  it.each<[string, DriverEvent, Session]>([
    ['a prompt taken', { type: 'prompt-taken' }, { key: KEY, state: 'busy', since: NOW }],
    ['a tool', { type: 'working' }, { key: KEY, state: 'busy', since: NOW }],
    ['the end of a turn', { type: 'turn-ended' }, { key: KEY, state: 'idle', since: NOW }],
    ['a failed turn', overloaded, { ...failed, since: NOW }],
    ['an interruption', { type: 'interrupted' }, { key: KEY, state: 'idle', since: NOW }],
  ])('is forgotten once a turn shows: %s', (_, event, session) => {
    const course = afterEvents({ session: idle }, [{ type: 'compaction-began' }, event]);

    expect(course.session).toEqual(session);
    expect(course.compactingFrom).toBeUndefined();
    expect(afterEvents(course, [{ type: 'compaction-ended' }])).toBe(course);
  });
});

describe('an interruption the transcript recorded', () => {
  const EARLIER = '2026-11-26T10:04:59.000Z';
  const LATER = '2026-11-26T10:05:01.000Z';

  it('ends the turn when it was recorded after the last prompt was taken', () => {
    const course = afterEvents({ session: busy }, [
      { type: 'prompt-taken' },
      { type: 'interrupted', at: LATER },
    ]);

    expect(course.session).toEqual({ key: KEY, state: 'idle', since: NOW });
  });

  it('ends the turn when it was recorded in the same millisecond as the last prompt was taken', () => {
    const course = afterEvents({ session: busy }, [
      { type: 'prompt-taken' },
      { type: 'interrupted', at: NOW },
    ]);

    expect(course.session).toEqual({ key: KEY, state: 'idle', since: NOW });
  });

  it('ended an earlier turn when it was recorded before the last prompt was taken: the new one stays busy', () => {
    const taken = afterEvents({ session: busy }, [{ type: 'prompt-taken' }]);

    const course = afterEvents(taken, [{ type: 'interrupted', at: EARLIER }]);

    expect(course.session).toBe(busy);
  });

  it('ends the turn when it says not when it was recorded', () => {
    const course = afterEvents({ session: busy }, [
      { type: 'prompt-taken' },
      { type: 'interrupted' },
    ]);

    expect(course.session.state).toBe('idle');
  });
});

describe('the conversation the agent names', () => {
  it.each([starting, busy, idle, waiting])('changes no state: %s', (session) => {
    const course = { session };

    expect(courseAfter(course, { type: 'conversation', conversationId: 'c2' }, true, NOW)).toBe(
      course,
    );
  });
});
