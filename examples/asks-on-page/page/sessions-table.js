// The sessions, a row each: the state, what a waiting session waits for,
// and the last answer of an idle one.

/** What a session's pending entry waits for, in words, by its kind. */
const WAITS_FOR = {
  ask: 'an ask, below',
  terminal: 'a person in its terminal',
  request: 'the app',
};

/**
 * Shows the sessions in a table, each row keyed by its session
 * (`data-key`), its state kept as data (`data-state`).
 *
 * @param table - The table, its body filled at each change.
 * @param empty - What shows while there is no session.
 * @param sessions - The sessions, as `client.sessions.follow` gives them.
 */
export function showSessions(table, empty, sessions) {
  empty.hidden = sessions.length > 0;
  table.hidden = sessions.length === 0;
  table.tBodies[0].replaceChildren(...sessions.map(sessionRow));
}

function sessionRow(session) {
  const row = document.createElement('tr');
  row.dataset.key = session.key;
  row.dataset.state = session.state;
  row.append(
    cell(session.key),
    cell(stateOf(session), 'state'),
    cell(waitsFor(session), 'waits-for'),
    cell(session.state === 'idle' ? (session.lastMessage ?? '') : '', 'last-answer'),
  );
  return row;
}

/** The state, with why an ended session ended. */
function stateOf(session) {
  return session.state === 'ended' ? `ended · ${session.reason}` : session.state;
}

function waitsFor(session) {
  if (session.state !== 'waiting') return '';
  return session.pending.map((entry) => WAITS_FOR[entry.kind]).join('; ');
}

function cell(text, name) {
  const td = document.createElement('td');
  if (name !== undefined) td.className = name;
  td.textContent = text;
  return td;
}
