// What the page tells the person of an operation: its result, as the
// cockpit gives it (action, reason, state) and in words, or its error.

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
 * @param result - What a run, a send or an open gave.
 */
export function showResult(element, result) {
  element.dataset.action = result.action;
  element.dataset.reason = result.reason ?? '';
  element.dataset.state = result.state ?? '';
  delete element.dataset.error;
  const terms = [result.action, result.reason].filter(Boolean).join(' · ');
  const state = result.state === undefined ? '' : ` → ${result.state}`;
  element.textContent = `${terms}${state}: ${meaningOf(result)}`;
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
  element.textContent = explain(error);
}

/** Shows that an operation is under way, until its result or error replaces it. */
export function showPending(element, text) {
  for (const name of ['action', 'reason', 'state', 'error']) delete element.dataset[name];
  element.textContent = text;
}

function meaningOf(result) {
  const tasks = stoppedTasksOf(result);
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
      return result.state === undefined
        ? 'no unit of work has that key.'
        : 'its session is live already.';
    default:
      return '';
  }
}

function stoppedTasksOf(result) {
  const tasks = result.stoppedTasks ?? [];
  if (tasks.length === 0) return '';
  return ` Stopped with the old session: ${tasks.map((task) => task.description ?? task.type).join(', ')}.`;
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
      return error.issues.map((issue) => issue.message).join(' ');
    case 'not-a-choice':
      return `${JSON.stringify(error.value)} is not among the choices of ${error.field} any more: choose again.`;
    case 'wrong-state':
      return `${error.key} is ${error.state}: wait until it is idle.`;
    case 'prompt-not-taken':
      return `${error.key} did not take the prompt; it is ${error.state}. Your draft is back in its box.`;
    case 'prompt-too-long':
      return `The prompt has ${error.length} characters; at most ${error.max} are typed.`;
    case 'folder-changed':
      return `This unit of work started in ${error.recorded}, not ${error.computed}.`;
    case 'session-cap-reached':
      return `The cap of ${error.cap} live sessions is reached (${error.live.join(', ')}), and none is idle to end for this one.`;
    default:
      return error.message;
  }
}
