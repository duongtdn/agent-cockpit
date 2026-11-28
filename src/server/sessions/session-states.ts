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
   * did nothing meanwhile. The `busy` session's own `since` is when the
   * compaction began.
   */
  readonly compactingFrom?: IdleSession;
  /**
   * When the agent last took a prompt, as `since` holds it: an
   * interruption recorded before it ended an earlier turn.
   */
  readonly promptTakenAt?: string;
  /**
   * The prompt of the open turn, while nothing else of that turn was told:
   * an early Esc may put it back into the input box, which no hook, no
   * transcript entry and nothing but the screen tells. Absent for a turn
   * whose prompt the agent gave no text of, and for one with no prompt (a
   * compaction begun `idle`).
   */
  readonly withdrawablePrompt?: string;
  /**
   * The background tasks the session listed as it left `idle` for a turn,
   * less those finished since: no `busy` session lists them, and the
   * `idle` session an interruption or a withdrawn prompt leaves, of which
   * no `Stop` gives a list, lists them again.
   */
  readonly tasksDuringTurn?: readonly BackgroundTask[];
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
  const after = nextCourse(course, event, launchedWithPrompt, now);
  if (event.type === 'prompt-taken') return withWithdrawablePrompt(after, event.prompt);
  return isOfTheTurn(course, event) ? withoutWithdrawablePrompt(after) : after;
}

/**
 * Gives the course once the screen showed the turn's prompt withdrawn by an
 * early Esc: `idle`, listing the background tasks it listed before the
 * turn, the prompt no longer withdrawable. A session not `busy` has no
 * turn to withdraw, and keeps its course.
 *
 * @param course - The course as it is.
 * @param now - The time the screen was read, as `since` holds it.
 * @returns The course, the same object when nothing changes.
 */
export function courseWithdrawn(course: SessionCourse, now: string): SessionCourse {
  const { key, state } = course.session;
  if (state !== 'busy') return course;
  return withSession(course, withTasks({ key, state: 'idle', since: now }, tasksSetAside(course)));
}

/**
 * Whether an event tells something of the open turn, past its prompt: the
 * prompt was no longer withdrawable by then. A background task's end is
 * not of the turn, nor an interruption recorded before the turn's prompt
 * was taken, which ended an earlier one.
 */
function isOfTheTurn(course: SessionCourse, event: DriverEvent): boolean {
  if (event.type === 'task-finished') return false;
  return !(event.type === 'interrupted' && endsAnEarlierTurn(course, event.at));
}

function withWithdrawablePrompt(course: SessionCourse, prompt: string | undefined): SessionCourse {
  return prompt === undefined
    ? withoutWithdrawablePrompt(course)
    : { ...course, withdrawablePrompt: prompt };
}

function withoutWithdrawablePrompt(course: SessionCourse): SessionCourse {
  if (course.withdrawablePrompt === undefined) return course;
  const { withdrawablePrompt: _told, ...rest } = course;
  return rest;
}

function nextCourse(
  course: SessionCourse,
  event: DriverEvent,
  launchedWithPrompt: boolean,
  now: string,
): SessionCourse {
  const { session, compactingFrom } = course;
  switch (event.type) {
    case 'ready':
      return session.state === 'starting' && !launchedWithPrompt
        ? { ...course, session: { key: session.key, state: 'idle', since: now } }
        : course;
    case 'prompt-taken':
      return { ...inTurn(course, now), promptTakenAt: now };
    case 'working':
      return inTurn(course, now);
    case 'interrupted':
      return endsAnEarlierTurn(course, event.at) ? course : turnOver(course, event, now);
    case 'turn-ended':
    case 'turn-failed':
      return turnOver(course, event, now);
    case 'compaction-began':
      return session.state === 'idle'
        ? { ...course, session: busySince(session, now), compactingFrom: session }
        : course;
    case 'compaction-ended':
      return compactingFrom === undefined ? course : withSession(course, compactingFrom);
    case 'command-done':
      if (compactingFrom !== undefined) {
        return interruptsTheCompaction(course, event)
          ? withSession(course, compactingFrom)
          : course;
      }
      return launchedWithPrompt && awaitsLaunchCommand(session)
        ? withSession(course, { key: session.key, state: 'idle', since: now })
        : course;
    case 'tasks':
      return withIdle(course, (idle) => withTasks(idle, event.running));
    case 'task-started':
      return isInATurn(course)
        ? withTaskDuringTurn(course, event.task)
        : withIdle(course, (idle) => withTask(idle, event.task));
    case 'task-finished':
      return withIdle(withoutTaskDuringTurn(course, event.id), (idle) =>
        withoutTask(idle, event.id),
      );
    case 'conversation':
    case 'ending':
      return course;
  }
}

/**
 * Whether the session still waits for its launch prompt to be done: not
 * taken yet (`starting`), or a panel it opened waits in the terminal, with
 * no dialog's name (a session waits so only at its start).
 */
function awaitsLaunchCommand(session: Session): boolean {
  if (session.state === 'starting') return true;
  return (
    session.state === 'waiting' &&
    session.pending.every((pending) => pending.kind === 'terminal' && pending.dialog === undefined)
  );
}

/** The course with this session, and no compaction to return from. */
function withSession(course: SessionCourse, session: Session): SessionCourse {
  return course.promptTakenAt === undefined
    ? { session }
    : { session, promptTakenAt: course.promptTakenAt };
}

/**
 * The course of a session whose turn shows: `busy`, its `since` kept when
 * it was already; a compaction that began idle is now inside the turn. The
 * tasks the `idle` session listed are set aside for the turn.
 */
function inTurn(course: SessionCourse, now: string): SessionCourse {
  const { session, compactingFrom } = course;
  const resting = compactingFrom ?? (session.state === 'idle' ? session : undefined);
  const turn =
    session.state === 'busy' && compactingFrom === undefined
      ? course
      : withSession(course, session.state === 'busy' ? session : busySince(session, now));
  // A turn that waited on a person goes on with the tasks it set aside.
  const tasks = resting === undefined ? course.tasksDuringTurn : resting.backgroundTasks;
  return tasks === undefined ? turn : { ...turn, tasksDuringTurn: tasks };
}

/** The background tasks the open turn set aside: those of the idle session a compaction began on, while it runs. */
function tasksSetAside(course: SessionCourse): readonly BackgroundTask[] {
  return course.compactingFrom?.backgroundTasks ?? course.tasksDuringTurn ?? [];
}

/** Whether a turn runs that no compaction begun `idle` holds: what it starts, it sets aside. */
function isInATurn({ session, compactingFrom }: SessionCourse): boolean {
  return compactingFrom === undefined && (session.state === 'busy' || session.state === 'waiting');
}

/** The course with the task among those set aside for the turn, once. */
function withTaskDuringTurn(course: SessionCourse, task: BackgroundTask): SessionCourse {
  const tasks = course.tasksDuringTurn ?? [];
  if (tasks.some((each) => each.id === task.id)) return course;
  return { ...course, tasksDuringTurn: [...tasks, task] };
}

/** The idle session with the task listed, once; the same one when it lists it. */
function withTask(idle: IdleSession, task: BackgroundTask): IdleSession {
  const tasks = idle.backgroundTasks ?? [];
  if (tasks.some((each) => each.id === task.id)) return idle;
  return withTasks(idle, [...tasks, task]);
}

/** The course without the task among those set aside for the turn. */
function withoutTaskDuringTurn(course: SessionCourse, id: string): SessionCourse {
  const tasks = course.tasksDuringTurn;
  if (tasks === undefined || !tasks.some((task) => task.id === id)) return course;
  return { ...course, tasksDuringTurn: tasks.filter((task) => task.id !== id) };
}

/**
 * Whether an interruption was recorded before the last prompt was taken:
 * it ended the turn before, which the transcript tells later than the
 * hooks tell the next prompt.
 */
function endsAnEarlierTurn(course: SessionCourse, recordedAt: string | undefined): boolean {
  return course.promptTakenAt !== undefined && recordedBefore(recordedAt, course.promptTakenAt);
}

/**
 * Whether a command's end the transcript recorded interrupts the compaction
 * begun while `idle`: only its caveat, all that an interrupted compaction
 * writes, and only one not recorded before the compaction began (an earlier
 * command's, written late). A command's result never does: a compaction
 * that is done or failed ends at its hooks.
 */
function interruptsTheCompaction(
  course: SessionCourse,
  event: Extract<DriverEvent, { type: 'command-done' }>,
): boolean {
  return event.entry === 'caveat' && !recordedBefore(event.at, course.session.since);
}

/**
 * Whether what the agent recorded is proved earlier than a moment the
 * cockpit took from a hook.
 *
 * The agent's time and the cockpit's are read from one clock: the agent
 * runs on the server's own host, under its tmux. An entry recorded in the
 * very millisecond, or that says no time, is no proof of being earlier,
 * and is taken as later: a session left `busy` with nothing more to tell
 * would stay so.
 */
function recordedBefore(recordedAt: string | undefined, moment: string): boolean {
  return recordedAt !== undefined && Date.parse(recordedAt) < Date.parse(moment);
}

function busySince(session: Session, now: string): Session {
  return { key: session.key, state: 'busy', since: now };
}

/**
 * The end of a turn — an answer, a failure or an interruption: `idle`,
 * with the turn's last message or its error, which replace whatever the last `idle` carried. On
 * an `idle` session there is no turn to end. An interruption, of which no
 * `Stop` lists the tasks, lists those set aside for the turn.
 */
function turnOver(
  course: SessionCourse,
  event: Extract<DriverEvent, { type: 'turn-ended' | 'turn-failed' | 'interrupted' }>,
  now: string,
): SessionCourse {
  const { key, state } = course.session;
  if (state === 'idle') return course;
  const idle: IdleSession = { key, state: 'idle', since: now };
  if (event.type === 'turn-failed') return withSession(course, { ...idle, error: event.error });
  if (event.type === 'interrupted')
    return withSession(course, withTasks(idle, tasksSetAside(course)));
  if (event.lastMessage === undefined) return withSession(course, idle);
  return withSession(course, { ...idle, lastMessage: event.lastMessage });
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
    return changed === compactingFrom ? course : { ...course, compactingFrom: changed };
  }
  if (session.state !== 'idle') return course;
  const changed = change(session);
  return changed === session ? course : { ...course, session: changed };
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
