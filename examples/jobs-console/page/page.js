// The jobs console's page: it runs the job, follows the sessions, and mounts
// the terminal of the session the person chooses. Plain browser JavaScript:
// the package's modules come through the page's import map.

import { createCockpitClient } from '@duongtdn/agent-cockpit/client';
import { mountTerminal } from '@duongtdn/agent-cockpit/terminal';

/** Where the app mounted the cockpit. */
const BASE_URL = '/cockpit';
/** The job the form runs. */
const JOB_ID = 'explain';
/** The address's query parameter that names the chosen session, so that a reload shows it again. */
const CHOSEN = 'session';

// Takes the token from the link's fragment and clears it from the address bar.
const client = createCockpitClient({ baseUrl: BASE_URL });

const connection = document.getElementById('connection');
const runForm = document.getElementById('run-form');
const runResult = document.getElementById('run-result');
const sessionsTable = document.getElementById('sessions');
const noSessions = document.getElementById('no-sessions');

/** Every state the page has seen each session in, in order: a fast `busy` stays visible. */
const statesSeen = new Map();
let terminal;

client.on('error', (error) => {
  connection.textContent = explain(error);
});

client.sessions.follow((sessions) => {
  connection.textContent = 'Following the sessions.';
  for (const session of sessions) noteState(session);
  showSessions(sessions);
});

runForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = new FormData(runForm).get('file');
  const button = runForm.querySelector('button');
  button.disabled = true;
  runResult.textContent = `Running the job on ${file}…`;
  try {
    const result = await client.run(JOB_ID, { file });
    runResult.textContent = `Started a session on ${file}: it is ${result.state}.`;
  } catch (error) {
    runResult.textContent = explain(error);
  } finally {
    button.disabled = false;
  }
});

const chosen = new URL(location.href).searchParams.get(CHOSEN);
if (chosen !== null) showTerminal(chosen);

function noteState(session) {
  const seen = statesSeen.get(session.key) ?? [];
  if (seen.at(-1) !== session.state) seen.push(session.state);
  statesSeen.set(session.key, seen);
}

function showSessions(sessions) {
  noSessions.hidden = sessions.length > 0;
  sessionsTable.hidden = sessions.length === 0;
  sessionsTable.tBodies[0].replaceChildren(...sessions.map(sessionRow));
}

function sessionRow(session) {
  const row = document.createElement('tr');
  row.dataset.key = session.key;
  const state = cell(session.state);
  state.dataset.state = session.state;
  const lastAnswer = cell(session.state === 'idle' ? (session.lastMessage ?? '') : '');
  lastAnswer.className = 'last-answer';
  lastAnswer.title = lastAnswer.textContent;
  const open = document.createElement('button');
  open.type = 'button';
  open.textContent = 'Terminal';
  open.setAttribute('aria-label', `Open the terminal of ${session.key}`);
  open.addEventListener('click', () => showTerminal(session.key));
  const actions = cell('');
  actions.append(open);
  row.append(
    cell(session.key),
    state,
    cell((statesSeen.get(session.key) ?? []).join(' → ')),
    cell(new Date(session.since).toLocaleTimeString()),
    lastAnswer,
    actions,
  );
  return row;
}

function cell(text) {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
}

/** Mounts the session's terminal, in place of the one shown before; the session itself goes on. */
function showTerminal(key) {
  terminal?.dispose();
  const status = document.getElementById('terminal-status');
  try {
    terminal = mountTerminal(document.getElementById('terminal'), key, { baseUrl: BASE_URL });
  } catch (error) {
    runResult.textContent = explain(error);
    return;
  }
  terminal.on('status', (current) => {
    status.textContent = `(${current})`;
  });
  document.getElementById('terminal-key').textContent = key;
  document.getElementById('terminal-section').hidden = false;
  const address = new URL(location.href);
  address.searchParams.set(CHOSEN, key);
  history.replaceState(history.state, '', address);
  terminal.focus();
}

/** Says what a `CockpitError` means for the person, by its code. */
function explain(error) {
  switch (error.code) {
    case 'no-token':
      return 'This page has no valid token: open the link the server printed.';
    case 'refused':
      return `The cockpit refused this page (${error.cause}).`;
    case 'unreachable':
      return 'The server cannot be reached; trying again.';
    case 'invalid-arguments':
      return error.issues.map((issue) => issue.message).join(' ');
    case 'wrong-state':
      return `${error.key} already has a session (${error.state}): this version runs a job only on a file with none.`;
    default:
      return error.message;
  }
}
