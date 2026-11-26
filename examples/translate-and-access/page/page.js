// The page of "Translate and access": it shows how the page proves itself —
// to the cockpit, and to the app's own API — runs the job, follows the
// sessions and mounts a session's terminal. Plain browser JavaScript: the
// package's modules come through the page's import map.

import { cockpitHeaders, createCockpitClient } from '@duongtdn/agent-cockpit/client';
import { mountTerminal } from '@duongtdn/agent-cockpit/terminal';

/** Where the app mounted the cockpit. */
const BASE_URL = '/cockpit';
/** The job the form runs. */
const JOB_ID = 'hello';
/** The causes of a refusal that mean the page comes from the network. */
const FROM_THE_NETWORK = ['remote', 'forwarded'];

// Takes the token from the link's fragment and clears it from the address bar.
const client = createCockpitClient({ baseUrl: BASE_URL });

const connection = document.getElementById('connection');
const whoami = document.getElementById('whoami');
const accessResult = document.getElementById('access-result');
const signInForm = document.getElementById('sign-in');
const signOut = document.getElementById('sign-out');
const runForm = document.getElementById('run-form');
const runResult = document.getElementById('run-result');
const sessionsTable = document.getElementById('sessions');
const noSessions = document.getElementById('no-sessions');
let terminal;

client.on('error', (error) => {
  connection.textContent = explain(error);
  if (error.code === 'refused' && FROM_THE_NETWORK.includes(error.cause)) signInForm.hidden = false;
});

client.sessions.follow((sessions) => {
  connection.textContent = 'Following the sessions.';
  showSessions(sessions);
});

askWhoThisPageIs();

document.getElementById('without-token').addEventListener('click', async () => {
  const answer = await fetch('/api/whoami');
  accessResult.textContent = `Without the token’s header, the app’s API answered ${answer.status}.`;
});

document.getElementById('renew').addEventListener('click', async () => {
  const answer = await fetch('/api/renew-token', { method: 'POST', headers: cockpitHeaders() });
  accessResult.textContent = answer.ok
    ? 'Renewed: every page needs the new link, printed in the server’s terminal.'
    : `The app refused to renew the token (${answer.status}).`;
});

signOut.addEventListener('click', async () => {
  await fetch('/api/sign-out', { method: 'POST' });
  location.reload();
});

signInForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const answer = await fetch('/api/sign-in', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: new FormData(signInForm).get('password') }),
  });
  if (answer.ok) {
    // The sign-in is a cookie now: every request from here on carries it.
    location.reload();
    return;
  }
  const { error } = await answer.json();
  accessResult.textContent =
    error === 'not-open'
      ? 'The app was started without --open: it serves no page of the network.'
      : 'That is not the password the app printed.';
});

runForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = new FormData(runForm).get('name');
  try {
    const result = await client.run(JOB_ID, { name });
    runResult.textContent = `Started a session for ${name}: it is ${result.state}.`;
  } catch (error) {
    runResult.textContent = explain(error);
  }
});

/** Calls the app's own API, which proves the page by the headers the cockpit's client gives. */
async function askWhoThisPageIs() {
  const answer = await fetch('/api/whoami', { headers: cockpitHeaders() });
  if (!answer.ok) {
    whoami.textContent = `The app’s API refused this page (${answer.status}).`;
    return;
  }
  const { provedBy, from } = await answer.json();
  signOut.hidden = provedBy !== 'sign-in';
  whoami.textContent =
    provedBy === 'token'
      ? `The app’s API knows this page by the app’s token, from ${from}.`
      : `The app’s API knows this page by its sign-in, from ${from}.`;
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
    cell(session.state === 'idle' ? (session.lastMessage ?? '') : ''),
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
  const terminalError = document.getElementById('terminal-error');
  terminalError.textContent = '';
  terminal = mountTerminal(document.getElementById('terminal'), key, { baseUrl: BASE_URL });
  terminal.on('status', (current) => {
    status.textContent = `(${current})`;
    // Connected: what kept it from connecting before no longer holds.
    if (current === 'open') terminalError.textContent = '';
  });
  terminal.on('error', (error) => {
    terminalError.textContent = explain(error);
  });
  document.getElementById('terminal-key').textContent = key;
  document.getElementById('terminal-section').hidden = false;
}

/** Says what a `CockpitError` means for the person, by its code. */
function explain(error) {
  switch (error.code) {
    case 'no-token':
      return 'This page has no valid token: open the link the server printed.';
    case 'refused':
      return error.cause === 'terminal-off'
        ? 'The terminal stays on the app’s machine (refused · terminal-off).'
        : `The cockpit refused this page (refused · ${error.cause}).`;
    case 'unreachable':
      return 'The server cannot be reached; trying again.';
    case 'invalid-arguments':
      return error.issues.map((issue) => issue.message).join(' ');
    case 'wrong-state':
      return `${error.key} already has a session (${error.state}).`;
    default:
      return error.message;
  }
}
