import type { BackgroundTask, IdleSession, Session } from '../../shared/session.js';
import type { DriverEvent } from '../driver.js';

/**
 * A session as the core follows it from its agent's events: the session as
 * it is listed, and what a later event needs that the session does not
 * carry.
 */
export interface SessionCourse {
  /** The session, as the app and the browser see it. */
  readonly session: Session;
  /**
   * The `idle` session a compaction began on: the session is `busy` until
   * the compaction ends, then returns to it, its `since` kept — the person
   * did nothing meanwhile.
   */
  readonly compactingFrom?: IdleSession;
}

/**
 * Gives the course a driver's event leaves the session on: the same object
 * when the event changes nothing, and always the same session object when
 * the session does not change, so that the caller tells a change by
 * identity. A session that stays in its state keeps its `since`: it entered
 * the state once.
 *
 * `ending` changes no state: the agent only says why it will end, and the
 * session has ended only once its process is gone.
 *
 * @param course - The course as it is; its session never `ended`, whose
 * events the caller drops.
 * @param event - What a hook told.
 * @param launchedWithPrompt - Whether the launch gave the agent a first
 * prompt: then `ready` is not `idle`, for the agent goes on to take it.
 * @param now - The time of the event, as `since` holds it.
 */
export function courseAfter(
  course: SessionCourse,
  event: DriverEvent,
  launchedWithPrompt: boolean,
  now: string,
): SessionCourse {
  const { session, compactingFrom } = course;
  switch (event.type) {
    case 'ready':
      return session.state === 'starting' && !launchedWithPrompt
        ? { session: { key: session.key, state: 'idle', since: now } }
        : course;
    case 'prompt-taken':
    case 'working':
      if (session.state !== 'busy') return { session: busySince(session, now) };
      // A turn shows: a compaction that began idle is now inside it.
      return compactingFrom === undefined ? course : { session };
    case 'turn-ended':
    case 'turn-failed':
    case 'interrupted':
      return turnOver(course, event, now);
    case 'compaction-began':
      return session.state === 'idle'
        ? { session: busySince(session, now), compactingFrom: session }
        : course;
    case 'compaction-ended':
      return compactingFrom === undefined ? course : { session: compactingFrom };
    case 'tasks':
      return withIdle(course, (idle) => withTasks(idle, event.running));
    case 'task-finished':
      return withIdle(course, (idle) => withoutTask(idle, event.id));
    case 'ending':
      return course;
  }
}

function busySince(session: Session, now: string): Session {
  return { key: session.key, state: 'busy', since: now };
}

/**
 * The end of a turn — an answer, a failure or an interruption: `idle`,
 * with the turn's last message or its error, which replace whatever the last `idle` carried. On
 * an `idle` session there is no turn to end.
 */
function turnOver(
  course: SessionCourse,
  event: Extract<DriverEvent, { type: 'turn-ended' | 'turn-failed' | 'interrupted' }>,
  now: string,
): SessionCourse {
  const { key, state } = course.session;
  if (state === 'idle') return course;
  const idle: IdleSession = { key, state: 'idle', since: now };
  if (event.type === 'turn-failed') return { session: { ...idle, error: event.error } };
  if (event.type === 'interrupted' || event.lastMessage === undefined) return { session: idle };
  return { session: { ...idle, lastMessage: event.lastMessage } };
}

/**
 * Changes what an `idle` session carries: the session itself, or the one a
 * compaction will return to. Any other session carries no tasks.
 */
function withIdle(
  course: SessionCourse,
  change: (idle: IdleSession) => IdleSession,
): SessionCourse {
  const { session, compactingFrom } = course;
  if (compactingFrom !== undefined) {
    const changed = change(compactingFrom);
    return changed === compactingFrom ? course : { session, compactingFrom: changed };
  }
  if (session.state !== 'idle') return course;
  const changed = change(session);
  return changed === session ? course : { session: changed };
}

/** The idle session without the task; the same one when it does not list it. */
function withoutTask(idle: IdleSession, id: string): IdleSession {
  const tasks = idle.backgroundTasks ?? [];
  if (!tasks.some((task) => task.id === id)) return idle;
  return withTasks(
    idle,
    tasks.filter((task) => task.id !== id),
  );
}

/** The idle session with these tasks, the field absent when none runs; the same one when it lists none and none ran. */
function withTasks(idle: IdleSession, running: readonly BackgroundTask[]): IdleSession {
  if (running.length > 0) return { ...idle, backgroundTasks: running };
  if (idle.backgroundTasks === undefined) return idle;
  const { backgroundTasks: _gone, ...withoutTasks } = idle;
  return withoutTasks;
}
