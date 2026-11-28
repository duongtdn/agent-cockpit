// What the page tells the person of an operation: its result, as the
// cockpit gives it (action, reason, state) and in words, or its error.

/** What a result with no state says: the key names no unit of work. */
const NO_SUCH_KEY = 'no unit of work has that key.';

/** Why a new conversation was started, by the result's reason. */
const STARTED_BECAUSE = {
  fresh: 'the job starts each run afresh',
  'fresh-on-request': 'you asked for a fresh one',
  'conversation-gone': 'the agent no longer kept the last one',
};

/**
 * Shows a result in a status element: the cockpit's own words first
 * (`action · reason → state`), then what they mean. The element keeps them
 * as data too (`data-action`, `data-reason`, `data-state`).
 *
 * @param element - The status element.
 * @param result - What a run, a send, an open, an interrupt, an end or a remove gave.
 * @param key - The unit of work it was about, named first: for a status
 *   that is not the unit of work's own.
 */
export function showResult(element, result, key) {
  element.dataset.action = result.action;
  element.dataset.reason = result.reason ?? '';
  element.dataset.state = result.state ?? '';
  delete element.dataset.error;
  const terms = [result.action, result.reason].filter(Boolean).join(' · ');
  const state = result.state === undefined ? '' : ` → ${result.state}`;
  const about = key === undefined ? '' : `${key} — `;
  element.textContent = `${about}${terms}${state}: ${meaningOf(result)}`;
}

/**
 * Shows an error in a status element, in words, its code kept as data
 * (`data-error`).
 *
 * @param element - The status element.
 * @param error - What the operation threw.
 */
export function showError(element, error) {
  for (const name of ['action', 'reason', 'state']) delete element.dataset[name];
  element.dataset.error = error.code ?? 'error';
  element.textContent = error.code === 'unreachable' ? unreachableOperation(error) : explain(error);
}

/**
 * An operation that met no cockpit: the server is down, or failed inside
 * while doing it. Nothing tries the operation again, so the page never
 * says it does; what came of it shows in the session's card.
 */
function unreachableOperation(error) {
  return `The server could not be reached, or failed while doing this (${error.message}). The session’s card shows what came of it.`;
}

/** Shows that an operation is under way, until its result or error replaces it. */
export function showPending(element, text) {
  for (const name of ['action', 'reason', 'state', 'error']) delete element.dataset[name];
  element.textContent = text;
}

function meaningOf(result) {
  const tasks = stoppedTasksOf(result, 'the old session');
  switch (result.action) {
    case 'started':
      return result.reason === undefined
        ? `a new session started.${tasks}`
        : `a new conversation started: ${STARTED_BECAUSE[result.reason]}.${tasks}`;
    case 'resumed':
      return result.reason === 'settings-changed'
        ? `the session was restarted with this job's settings, its conversation resumed.${tasks}`
        : 'the conversation was resumed.';
    case 'sent':
      return 'the session took the prompt.';
    case 'nothing-to-send':
      return 'the job has no prompt and its session is live: type in its terminal.';
    case 'nothing-to-open':
      return result.state === undefined ? NO_SUCH_KEY : 'its session is live already.';
    case 'interrupted':
      return 'the turn was stopped; the agent waits for a prompt, its background tasks going on.';
    case 'nothing-to-interrupt':
      return nothingToInterrupt(result.state);
    case 'ended':
      return `the session ended; its conversation and record are kept for the next run or open.${stoppedTasksOf(result, 'it')}`;
    case 'nothing-to-end':
      return result.state === undefined ? NO_SUCH_KEY : 'its session has ended already.';
    case 'removed':
      return `its record and history are deleted, its session ended if it was live; the agent’s transcripts are kept.${stoppedTasksOf(result, 'its session')}`;
    case 'nothing-to-remove':
      return NO_SUCH_KEY;
    default:
      return '';
  }
}

/** Why there was no turn to stop, by the state the session is in. */
function nothingToInterrupt(state) {
  switch (state) {
    case undefined:
      return NO_SUCH_KEY;
    case 'waiting':
      return 'it waits in its terminal, where the cockpit sends no key: answer there.';
    default:
      return 'no turn was running.';
  }
}

/** The background tasks a result says were stopped, with what they stopped with. */
function stoppedTasksOf(result, stoppedWith) {
  const tasks = result.stoppedTasks ?? [];
  if (tasks.length === 0) return '';
  return ` Stopped with ${stoppedWith}: ${tasksNamed(tasks)}.`;
}

/**
 * Background tasks as the person tells them apart: what each was given to
 * do, or its kind when the agent does not say.
 *
 * @param tasks - The tasks, as a session or a result lists them.
 * @returns Their names, joined.
 */
export function tasksNamed(tasks) {
  return tasks.map((task) => task.description ?? task.type).join(', ');
}

/**
 * Says what a `CockpitError` means for the person, by its code.
 *
 * @param error - What an operation threw, or a stream reported.
 * @returns A sentence.
 */
export function explain(error) {
  switch (error.code) {
    case 'no-token':
      return 'This page has no valid token: open the link the server printed.';
    case 'refused':
      return `The cockpit refused this page (${error.cause}).`;
    case 'unreachable':
      return 'The server cannot be reached; trying again.';
    case 'invalid-arguments':
      return error.issues.map(issueText).join(' ');
    case 'not-a-choice':
      return `${JSON.stringify(error.value)} is not among the choices of ${error.field} any more: choose again.`;
    case 'prompt-not-taken':
      return `${error.key} did not take the prompt; it is ${error.state}. Your draft is back in its box.`;
    case 'interrupt-unconfirmed':
      return `${error.message} See its terminal, or press End.`;
    case 'prompt-too-long':
      return `The prompt has ${error.length} characters; at most ${error.max} are typed.`;
    case 'folder-changed':
      return `This unit of work started in ${error.recorded}, not ${error.computed}.`;
    case 'session-cap-reached':
      return `The cap of ${error.cap} live sessions is reached (${error.live.join(', ')}), and none is idle to end for this one.`;
    default:
      // `wrong-state` among them: its message says where the person's draft went, when it moved.
      return error.message;
  }
}

/** One way the arguments do not fit, after the field it is in, when it is in one. */
function issueText({ path, message }) {
  return path.length === 0 ? message : `${path.join('.')}: ${message}`;
}
