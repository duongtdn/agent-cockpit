// The sessions, as the cockpit lists them: one card per unit of work, with
// its state, the states the page saw it in, its last answer, its record's
// history, and what the person can do with it — show its terminal, open it
// (fresh or not), send it a prompt, stop its turn, end its session, remove
// it. A card is kept from one list to the next, so that a prompt being
// typed, an open history, a removal being confirmed or a result stays.

import { showError, showPending, showResult, tasksNamed } from './results.js';

/** The states a turn runs in, which Stop interrupts. */
const STOPPABLE = new Set(['busy', 'waiting']);

/**
 * Makes the list of sessions in a container.
 *
 * @param container - The element that holds the cards.
 * @param client - The cockpit client, for open, send, interrupt, end and remove.
 * @param showTerminal - Shows the terminal of a key.
 * @param removals - The status element that says what a remove did, or why it failed: its card may be gone.
 * @returns `update(sessions)`, called with every list the cockpit gives.
 */
export function createSessionsList(container, client, showTerminal, removals) {
  const cards = new Map();
  /** Every state the page has seen each session in, in order: a fast `busy` stays visible. */
  const statesSeen = new Map();
  /** Says what a remove did, or why it failed, above the cards: its card may be gone. */
  const removalStatus = {
    showResult(key, removed) {
      showResult(removals, removed, key);
      removals.dataset.key = key;
    },
    showError(key, error) {
      showError(removals, error, key);
      removals.dataset.key = key;
    },
    /** Clears what it says of a key that has a session again: the removal is past. */
    forget(key) {
      if (removals.dataset.key !== key) return;
      showPending(removals, '');
      delete removals.dataset.key;
    },
  };

  function update(sessions) {
    for (const session of sessions) {
      const seen = statesSeen.get(session.key) ?? [];
      if (seen.at(-1) !== stateOf(session)) seen.push(stateOf(session));
      statesSeen.set(session.key, seen);
      if (!cards.has(session.key)) {
        removalStatus.forget(session.key);
        cards.set(session.key, drawCard(session.key, client, showTerminal, removalStatus));
      }
      cards.get(session.key).show(session, seen);
    }
    const listed = new Set(sessions.map((session) => session.key));
    for (const key of cards.keys()) {
      if (listed.has(key)) continue;
      cards.delete(key);
      // A key run again after a remove is a new unit of work: its states start afresh.
      statesSeen.delete(key);
    }
    container.replaceChildren(...sessions.map((session) => cards.get(session.key).card));
  }

  return { update };
}

/** A session's state as the person reads it: why it ended, with `ended`. */
function stateOf(session) {
  return session.state === 'ended' ? `ended · ${session.reason}` : session.state;
}

function drawCard(key, client, showTerminal, removalStatus) {
  const card = element('li', { className: 'session' });
  card.dataset.key = key;
  const state = element('span', { className: 'state' });
  const since = element('time', { className: 'since' });
  const seen = element('p', { className: 'states-seen' });
  const lastAnswer = element('p', { className: 'last-answer' });
  const result = element('p', { className: 'result' });
  result.setAttribute('role', 'status');
  const history = element('details', { className: 'history' });

  const terminal = button('Terminal', `Show the terminal of ${key}`);
  terminal.addEventListener('click', () => showTerminal(key));
  const open = button('Open', `Open ${key}`);
  const fresh = button('Open fresh', `Open ${key} in a fresh conversation`);
  const stop = button('Stop', `Stop the turn of ${key}`);
  const end = button('End', `End the session of ${key}`);
  const remove = button('Remove', `Remove ${key}`);
  const actions = element('div', { className: 'actions' });
  actions.append(terminal, open, fresh, stop, end, remove);
  const removal = drawRemovalConfirmation(key, remove);

  const sendForm = element('form', { className: 'send' });
  const prompt = element('textarea', { rows: 2, required: true });
  prompt.setAttribute('aria-label', `Prompt for ${key}`);
  const send = element('button', { type: 'submit', textContent: 'Send' });
  send.setAttribute('aria-label', `Send to ${key}`);
  sendForm.append(prompt, send);

  /** Runs one operation of the card, its buttons held until it settles. */
  async function operate(pending, operation) {
    const buttons = [open, fresh, send, stop, end, remove, removal.confirm];
    for (const each of buttons) each.disabled = true;
    showPending(result, pending);
    try {
      showResult(result, await operation());
    } catch (error) {
      showError(result, error);
    } finally {
      for (const each of buttons) each.disabled = false;
    }
  }

  open.addEventListener('click', () => operate(`Opening ${key}…`, () => client.open(key)));
  fresh.addEventListener('click', () =>
    operate(`Opening ${key} in a fresh conversation…`, () => client.open(key, { fresh: true })),
  );
  stop.addEventListener('click', () =>
    operate(`Stopping the turn of ${key}…`, () => client.interrupt(key)),
  );
  end.addEventListener('click', () =>
    operate(`Ending the session of ${key}…`, () => client.end(key)),
  );
  remove.addEventListener('click', () => removal.ask());
  removal.confirm.addEventListener('click', () => {
    removal.close();
    operate(`Removing ${key}…`, async () => {
      // The card leaves the list once the cockpit lists the sessions again: the list says it too.
      try {
        const removed = await client.remove(key);
        removalStatus.showResult(key, removed);
        return removed;
      } catch (error) {
        removalStatus.showError(key, error);
        throw error;
      }
    });
  });
  sendForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = prompt.value;
    await operate(`Sending to ${key}…`, async () => {
      const sent = await client.send(key, text);
      prompt.value = '';
      return sent;
    });
  });

  const head = element('div', { className: 'session-head' });
  head.append(element('h3', { textContent: key }), state, since);
  card.append(head, seen, lastAnswer, actions, removal.element, sendForm, result, history);

  return {
    card,
    show(session, statesSeen) {
      state.textContent = stateOf(session);
      state.dataset.state = session.state;
      stop.hidden = !STOPPABLE.has(session.state);
      end.hidden = session.state === 'ended';
      removal.showTasks(session.backgroundTasks ?? []);
      since.dateTime = session.since;
      since.textContent = `since ${new Date(session.since).toLocaleTimeString()}`;
      seen.textContent = `States seen: ${statesSeen.join(' → ')}`;
      const answer = session.state === 'idle' ? (session.lastMessage ?? '') : '';
      lastAnswer.textContent = answer;
      lastAnswer.title = answer;
      showHistory(history, session.record);
    },
  };
}

/**
 * The confirmation a remove asks for, in the card: what removing deletes,
 * and the background tasks it would stop, kept current while it shows.
 *
 * @param key - The unit of work's key.
 * @param remove - The card's Remove button, which the keyboard goes back to once it closes.
 * @returns Its element; `ask()` and `close()`, which show and hide it
 * (Escape closes it too); `showTasks(tasks)`, the session's tasks as
 * listed; `confirm`, the button that confirms.
 */
function drawRemovalConfirmation(key, remove) {
  const confirmation = element('div', { className: 'confirm-removal', hidden: true });
  confirmation.setAttribute('role', 'group');
  confirmation.setAttribute('aria-label', `Confirm the removal of ${key}`);
  const question = element('p', {
    textContent: `Remove ${key}? Its session ends if it is live, and its record and history are deleted; the agent’s transcripts are kept.`,
  });
  const tasks = element('p', { className: 'tasks-stopped', hidden: true });
  const confirm = button('Remove for good', `Confirm: remove ${key}`);
  const keep = button('Keep it', `Keep ${key}`);
  const choices = element('div', { className: 'actions' });
  choices.append(confirm, keep);
  confirmation.append(question, tasks, choices);

  const close = () => {
    confirmation.hidden = true;
    remove.focus();
  };
  keep.addEventListener('click', close);
  confirmation.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
  return {
    element: confirmation,
    confirm,
    ask() {
      confirmation.hidden = false;
      keep.focus();
    },
    close,
    showTasks(listed) {
      tasks.hidden = listed.length === 0;
      tasks.textContent = `It would stop the background tasks: ${tasksNamed(listed)}.`;
    },
  };
}

/** The record's history, newest first, and the conversations it worked in before. */
function showHistory(details, record) {
  const entries = record?.history ?? [];
  const wasOpen = details.open;
  const list = element('ol', { reversed: true });
  list.append(
    ...[...entries].reverse().map((entry) => {
      const terms = [entry.action, entry.reason].filter(Boolean).join(' · ');
      return element('li', {
        textContent: `${new Date(entry.at).toLocaleTimeString()} — ${entry.operation} of ${entry.jobId} ${JSON.stringify(entry.args)}: ${terms}, in conversation ${short(entry.conversationId)}`,
      });
    }),
  );
  const earlier = record?.earlierConversations ?? [];
  details.replaceChildren(
    element('summary', { textContent: `History (${entries.length})` }),
    list,
    element('p', {
      className: 'conversations',
      textContent: record
        ? `Conversation ${short(record.conversationId)}; before it: ${earlier.map(short).join(', ') || 'none'}.`
        : 'No record yet.',
    }),
  );
  details.open = wasOpen;
}

/** A conversation's id, shortened as a person tells them apart. */
function short(conversationId) {
  return conversationId.slice(0, 8);
}

function button(text, label) {
  const made = element('button', { type: 'button', textContent: text });
  made.setAttribute('aria-label', label);
  return made;
}

function element(tag, properties = {}) {
  return Object.assign(document.createElement(tag), properties);
}
