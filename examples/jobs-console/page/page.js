// The jobs console's page: a launcher form for each of the app's jobs,
// drawn from what the cockpit says of them; the sessions, followed live;
// the terminal of the session the person chooses. Plain browser
// JavaScript: the package's modules come through the page's import map.

import { createCockpitClient } from '@duongtdn/agent-cockpit/client';
import { mountTerminal } from '@duongtdn/agent-cockpit/terminal';
import { drawLauncher } from './launcher.js';
import { explain } from './results.js';
import { createSessionsList } from './sessions-list.js';

/** Where the app mounted the cockpit. */
const BASE_URL = '/cockpit';
/** The address's query parameter that names the chosen session, so that a reload shows it again. */
const CHOSEN = 'session';

// Takes the token from the link's fragment and clears it from the address bar.
const client = createCockpitClient({ baseUrl: BASE_URL });

const connection = document.getElementById('connection');
const launchers = document.getElementById('launchers');
const sessionsList = document.getElementById('sessions');
const noSessions = document.getElementById('no-sessions');

let terminal;

client.on('error', (error) => {
  connection.textContent = explain(error);
});

const sessions = createSessionsList(sessionsList, client, showTerminal);
client.sessions.follow((listed) => {
  connection.textContent = 'Following the sessions.';
  noSessions.hidden = listed.length > 0;
  sessions.update(listed);
});

showLaunchers();

const chosen = new URL(location.href).searchParams.get(CHOSEN);
if (chosen !== null) showTerminal(chosen);

/** Draws a launcher for each job; until the jobs can be read, says why. */
async function showLaunchers() {
  try {
    const jobs = await client.jobs();
    launchers.replaceChildren(...jobs.map((job) => drawLauncher(job, client)));
  } catch (error) {
    launchers.textContent = `The jobs could not be read: ${explain(error)} Reload the page to try again.`;
  }
}

/**
 * Mounts the session's terminal, in place of the one shown before; the
 * session itself goes on. A key it cannot show (one in the address, say) is
 * shown with why, where its terminal would be.
 */
function showTerminal(key) {
  terminal?.dispose();
  terminal = undefined;
  const status = document.getElementById('terminal-status');
  document.getElementById('terminal-key').textContent = key;
  document.getElementById('terminal-section').hidden = false;
  try {
    terminal = mountTerminal(document.getElementById('terminal'), key, { baseUrl: BASE_URL });
  } catch (error) {
    status.textContent = explain(error);
    return;
  }
  terminal.on('status', (current) => {
    status.textContent = `(${current})`;
  });
  const address = new URL(location.href);
  address.searchParams.set(CHOSEN, key);
  history.replaceState(history.state, '', address);
  terminal.focus();
}
