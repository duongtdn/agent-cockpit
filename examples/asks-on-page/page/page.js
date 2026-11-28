// The page of "Asks on the page": it runs a job, follows the sessions, and
// shows every ask of the agent's, answering those the app may answer, with
// no terminal mounted. Plain browser JavaScript: the package's client comes
// through the page's import map.

import { createCockpitClient } from '@duongtdn/agent-cockpit/client';
import { createAsksList } from './asks-list.js';
import { explain } from './explain.js';
import { showSessions } from './sessions-table.js';

/** Where the app mounted the cockpit. */
const BASE_URL = '/cockpit';

// Takes the token from the link's fragment and clears it from the address bar.
const client = createCockpitClient({ baseUrl: BASE_URL });

const connection = document.getElementById('connection');
const runForm = document.getElementById('run-form');
const runResult = document.getElementById('run-result');
const sessionsTable = document.getElementById('sessions');
const noSessions = document.getElementById('no-sessions');

client.on('error', (error) => {
  connection.textContent = explain(error);
});

client.sessions.follow((sessions) => {
  connection.textContent = 'Following the sessions and their asks.';
  showSessions(sessionsTable, noSessions, sessions);
});

const asks = createAsksList(
  {
    pending: document.getElementById('pending'),
    settled: document.getElementById('settled'),
    noPending: document.getElementById('no-pending'),
    noSettled: document.getElementById('no-settled'),
  },
  client,
);
client.asks.on('settled', asks.settle);
client.asks.follow('*', asks.show);

runForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const jobId = event.submitter.value;
  const file = new FormData(runForm).get('file');
  runResult.textContent = 'Running…';
  try {
    const result = await client.run(jobId, { file });
    runResult.textContent = `${jobId} on ${file}: ${result.action} → ${result.state}.`;
  } catch (error) {
    runResult.textContent = explain(error);
  }
});
