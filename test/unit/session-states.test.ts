import { describe, expect, it } from 'vitest';
import type { DriverEvent } from '../../src/server/driver.ts';
import {
  courseAfter,
  courseWithdrawn,
  type SessionCourse,
} from '../../src/server/sessions/session-states.ts';
import type { BackgroundTask, IdleSession, Session } from '../../src/shared/session.ts';

const KEY = 'chapter-1';
const BEFORE = '2026-11-26T10:00:00.000Z';
const NOW = '2026-11-26T10:05:00.000Z';

const reviewer: BackgroundTask = { id: 'a1', type: 'general-purpose', description: 'Review a.ts' };
const tests: BackgroundTask = { id: 'b2', type: 'shell', description: 'Run the tests' };
const helper: BackgroundTask = { id: 'c3', type: 'general-purpose' };

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
      'a task started while idle',
      idle,
      { type: 'task-started', task: helper },
      true,
      { ...idle, backgroundTasks: [helper] },
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

describe('the end of a command of the agent’s own that the transcript recorded', () => {
  const done: DriverEvent = { type: 'command-done', entry: 'result' };
  const caveat: DriverEvent = { type: 'command-done', entry: 'caveat' };
  const panel: Session = {
    key: KEY,
    state: 'waiting',
    since: BEFORE,
    pending: [{ kind: 'terminal' }],
  };

  it.each([
    ['its result', done],
    ['its caveat', caveat],
  ])('ends a launch prompt that was such a command, told by %s: `idle`', (_, event) => {
    expect(sessionAfterOne(starting, event)).toEqual({ key: KEY, state: 'idle', since: NOW });
  });

  it('ends a launch prompt whose panel waits in the terminal: a choice on it ends the command', () => {
    expect(sessionAfterOne(panel, done)).toEqual({ key: KEY, state: 'idle', since: NOW });
  });

  it('changes nothing of a session launched with no prompt, still starting', () => {
    expect(sessionAfterOne(starting, done, false)).toBe(starting);
  });

  it.each([
    ['busy', busy],
    ['idle', idle],
    ['waiting for a start-up dialog', waiting],
  ])('changes nothing of a session %s', (_, session) => {
    expect(sessionAfterOne(session, done)).toBe(session);
  });

  it('changes nothing of a compaction inside a turn', () => {
    expect(afterEvents({ session: busy }, [{ type: 'compaction-began' }, caveat])).toEqual({
      session: busy,
    });
  });
});

describe('a compaction begun while idle, ended by the transcript alone', () => {
  const BEGAN = NOW;
  const EARLIER = '2026-11-26T10:04:59.650Z';
  const LATER = '2026-11-26T10:05:01.000Z';

  /** The course once a compaction began while idle, at {@link BEGAN}. */
  function compacting(): SessionCourse {
    return courseAfter({ session: idleWithTasks }, { type: 'compaction-began' }, true, BEGAN);
  }

  /** The course after an event told later than the compaction began. */
  function told(course: SessionCourse, event: DriverEvent): SessionCourse {
    return courseAfter(course, event, true, LATER);
  }

  it('is interrupted by a caveat recorded after it began: back to the idle session it left', () => {
    expect(told(compacting(), { type: 'command-done', entry: 'caveat', at: LATER })).toEqual({
      session: idleWithTasks,
    });
  });

  it('is interrupted by a caveat recorded in the very millisecond it began', () => {
    expect(told(compacting(), { type: 'command-done', entry: 'caveat', at: BEGAN })).toEqual({
      session: idleWithTasks,
    });
  });

  it('is interrupted by a caveat that says not when it was recorded', () => {
    expect(told(compacting(), { type: 'command-done', entry: 'caveat' })).toEqual({
      session: idleWithTasks,
    });
  });

  it('goes on past a caveat recorded before it began: an earlier command’s, written late', () => {
    const course = compacting();

    expect(told(course, { type: 'command-done', entry: 'caveat', at: EARLIER })).toBe(course);
  });

  it.each([
    ['before it began', EARLIER],
    ['after it began', LATER],
    ['at no time it says', undefined],
  ])('goes on past a command’s result recorded %s: only the caveat ends it', (_, at) => {
    const course = compacting();
    const result: DriverEvent =
      at === undefined
        ? { type: 'command-done', entry: 'result' }
        : { type: 'command-done', entry: 'result', at };

    expect(told(course, result)).toBe(course);
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

describe('the prompt an early Esc may withdraw', () => {
  const EARLIER = '2026-11-26T10:04:59.000Z';
  const taken: DriverEvent = { type: 'prompt-taken', prompt: 'Fix the tests.' };

  it('is the prompt a turn began with, its text carried', () => {
    expect(courseAfter({ session: idle }, taken, true, NOW).withdrawablePrompt).toBe(
      'Fix the tests.',
    );
  });

  it('is none for a prompt taken with no text', () => {
    expect(
      courseAfter({ session: idle }, { type: 'prompt-taken' }, true, NOW).withdrawablePrompt,
    ).toBeUndefined();
  });

  it('is the later prompt when another is taken', () => {
    const course = afterEvents({ session: idle }, [
      taken,
      { type: 'prompt-taken', prompt: 'And the docs.' },
    ]);

    expect(course.withdrawablePrompt).toBe('And the docs.');
  });

  it.each<[string, DriverEvent]>([
    ['a tool', { type: 'working' }],
    ['the end of the turn', { type: 'turn-ended', lastMessage: 'Done.' }],
    ['a failed turn', overloaded],
    ['its interruption', { type: 'interrupted' }],
    ['a compaction', { type: 'compaction-began' }],
    ['a background task started', { type: 'task-started', task: helper }],
    ['another conversation', { type: 'conversation', conversationId: 'c2' }],
    ['the agent ending', { type: 'ending', reason: 'agent-exit' }],
  ])('is forgotten at any later sign of the turn: %s', (_, event) => {
    expect(afterEvents({ session: idle }, [taken, event]).withdrawablePrompt).toBeUndefined();
  });

  it('is kept past an interruption recorded before it was taken: an earlier turn’s', () => {
    const course = afterEvents({ session: idle }, [taken, { type: 'interrupted', at: EARLIER }]);

    expect(course.withdrawablePrompt).toBe('Fix the tests.');
  });

  it('is kept past a background task finished: no sign of the turn', () => {
    const course = afterEvents({ session: idleWithTasks }, [
      taken,
      { type: 'task-finished', id: 'a1' },
    ]);

    expect(course.withdrawablePrompt).toBe('Fix the tests.');
  });
});

describe('a prompt withdrawn, as the screen shows it', () => {
  const taken: DriverEvent = { type: 'prompt-taken', prompt: 'Fix the tests.' };

  it('leaves the session idle since then, the prompt no longer withdrawable', () => {
    const course = courseWithdrawn(afterEvents({ session: idle }, [taken]), NOW);

    expect(course).toEqual({
      session: { key: KEY, state: 'idle', since: NOW },
      promptTakenAt: NOW,
    });
  });

  it('changes nothing of a session not busy: the same course', () => {
    const course: SessionCourse = { session: idle };

    expect(courseWithdrawn(course, NOW)).toBe(course);
  });
});

describe('the background tasks across a turn that ends with no list of them', () => {
  const taken: DriverEvent = { type: 'prompt-taken', prompt: 'Fix the tests.' };

  it('are kept while the turn goes on: a tool, another prompt', () => {
    const course = afterEvents({ session: idleWithTasks }, [
      taken,
      { type: 'working' },
      { type: 'prompt-taken', prompt: 'And the docs.' },
      { type: 'interrupted' },
    ]);

    expect(course.session).toMatchObject({ state: 'idle', backgroundTasks: [reviewer, tests] });
  });

  it('take in a task started during the turn', () => {
    const course = afterEvents({ session: idleWithTasks }, [
      taken,
      { type: 'task-started', task: helper },
      { type: 'interrupted' },
    ]);

    expect(course.session).toMatchObject({
      state: 'idle',
      backgroundTasks: [reviewer, tests, helper],
    });
  });

  it('take in a task started during a turn begun with none listed', () => {
    const course = afterEvents({ session: idle }, [
      taken,
      { type: 'task-started', task: helper },
      { type: 'interrupted' },
    ]);

    expect(course.session).toMatchObject({ state: 'idle', backgroundTasks: [helper] });
  });

  it('take in a task started once only, however often it is told', () => {
    const course = afterEvents({ session: idle }, [
      taken,
      { type: 'task-started', task: helper },
      { type: 'task-started', task: helper },
      { type: 'interrupted' },
    ]);

    expect(course.session).toMatchObject({ backgroundTasks: [helper] });
  });

  it('leave out a task started then finished during the turn', () => {
    const course = afterEvents({ session: idle }, [
      taken,
      { type: 'task-started', task: helper },
      { type: 'task-finished', id: helper.id },
      { type: 'interrupted' },
    ]);

    expect(course.session).toEqual({ key: KEY, state: 'idle', since: NOW });
  });

  it('leave out a task that finished during the turn', () => {
    const course = afterEvents({ session: idleWithTasks }, [
      taken,
      { type: 'task-finished', id: 'a1' },
      { type: 'interrupted' },
    ]);

    expect(course.session).toEqual({
      key: KEY,
      state: 'idle',
      since: NOW,
      backgroundTasks: [tests],
    });
  });

  it('are those of the idle session a compaction began on, when a prompt followed it', () => {
    const course = afterEvents({ session: idleWithTasks }, [
      { type: 'compaction-began' },
      taken,
      { type: 'interrupted' },
    ]);

    expect(course.session).toMatchObject({ state: 'idle', backgroundTasks: [reviewer, tests] });
  });

  it('give way to the list the end of a turn gives', () => {
    const course = afterEvents({ session: idleWithTasks }, [
      taken,
      { type: 'turn-ended' },
      { type: 'tasks', running: [tests] },
    ]);

    expect(course.session).toEqual({
      key: KEY,
      state: 'idle',
      since: NOW,
      backgroundTasks: [tests],
    });
  });

  it('are none once the idle session is listed: a later interrupted turn lists only what it set aside', () => {
    const course = afterEvents({ session: idleWithTasks }, [
      taken,
      { type: 'interrupted' },
      { type: 'tasks', running: [] },
      taken,
      { type: 'interrupted' },
    ]);

    expect(course.session).toEqual({ key: KEY, state: 'idle', since: NOW });
  });
});
