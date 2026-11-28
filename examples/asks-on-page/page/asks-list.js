// The agent's asks, as the page shows them: every pending ask of the
// sessions, drawn by its kind with the answers the page may give (or where
// to answer one only a person in the terminal can), and the asks settled
// since the page opened, with what settled them. A kind of ask is one entry
// of `KINDS`: the list itself knows none, so a new kind is a new entry.

import { explain } from './explain.js';

/** What settled an ask, in words, by the cockpit's `by`. */
const SETTLED_BY = {
  app: 'answered by the app',
  terminal: 'answered in the terminal',
  cancelled: 'its turn or its session ended first',
};

/**
 * How each kind of ask is drawn, by its `kind`: its title; its content; a
 * line that sums it up once it is settled; and the controls that answer it,
 * drawn from the ask, each calling `answer(value)` with an answer of the kind.
 */
const KINDS = {
  permission: {
    title: (ask) => `Permission to run ${ask.tool}`,
    content: permissionContent,
    summary: (ask) => ask.description ?? JSON.stringify(ask.input),
    answers: permissionAnswers,
  },
};

/**
 * A kind this page does not know, from a newer package: named, its content
 * left out, and never answered here, whoever may answer it.
 */
const UNKNOWN_KIND = {
  title: (ask) => `A ${ask.kind} ask this page cannot draw`,
  content: () => [],
  summary: () => 'answer it in the terminal',
};

/**
 * Makes the list of asks over the page's elements. The page gives it each
 * ask `client.asks.follow` delivers and each settlement
 * `client.asks.on('settled')` tells.
 *
 * @param elements - `pending` and `settled`, the lists; `noPending` and
 *   `noSettled`, what shows while each is empty.
 * @param client - The cockpit's client, to answer by.
 * @returns `show(ask)`, which draws an ask, in place of the one of its id
 *   drawn before (an ask whose `answerable` changed), and `settle(settled)`,
 *   which moves an ask to the settled ones.
 */
export function createAsksList({ pending, settled, noPending, noSettled }, client) {
  /** The asks pending, by id: each ask and its item. */
  const shown = new Map();

  function show(ask) {
    const item = pendingItem(ask, client);
    const before = shown.get(ask.id);
    if (before === undefined) pending.append(item);
    else before.item.replaceWith(item);
    shown.set(ask.id, { ask, item });
    noPending.hidden = shown.size > 0;
  }

  function settle({ id, key, by }) {
    const entry = shown.get(id);
    entry?.item.remove();
    shown.delete(id);
    noPending.hidden = shown.size > 0;
    settled.prepend(settledItem(entry?.ask, { id, key, by }));
    noSettled.hidden = true;
  }

  return { show, settle };
}

/** A pending ask: its key and title, its content, and its answers or where to answer it. */
function pendingItem(ask, client) {
  const kind = kindOf(ask);
  const item = element('li', { className: 'ask' });
  Object.assign(item.dataset, { id: ask.id, key: ask.key, answerable: ask.answerable });
  const status = element('p', { className: 'result', role: 'status' });
  const answer = async (value) => {
    setBusy(item, true);
    status.textContent = 'Answering…';
    try {
      await client.asks.answer(ask.id, value);
      status.textContent = 'Answered: the agent has it.';
    } catch (error) {
      status.textContent = explain(error);
      setBusy(item, false);
    }
  };
  item.append(
    element('h3', { textContent: `${ask.key} — ${kind.title(ask)}` }),
    ...kind.content(ask),
    element('p', { className: 'since', textContent: `Asked at ${timeOf(ask.since)}.` }),
    ...(ask.answerable === 'app' && kind.answers !== undefined
      ? kind.answers(ask, answer)
      : [inTheTerminal(ask)]),
    status,
  );
  return item;
}

function kindOf(ask) {
  return KINDS[ask.kind] ?? UNKNOWN_KIND;
}

/** What an ask only a person in its session's terminal can answer shows in place of answers. */
function inTheTerminal(ask) {
  return element('p', {
    className: 'terminal-only',
    textContent: `Answer in the terminal of ${ask.key}: the server printed how to reach it.`,
  });
}

/** A settled ask: what it was, when the page saw it, and what settled it. */
function settledItem(ask, { id, key, by }) {
  const item = element('li', { className: 'ask settled' });
  Object.assign(item.dataset, { id, key, by });
  const kind = ask === undefined ? undefined : kindOf(ask);
  const what = kind === undefined ? 'an ask' : `${kind.title(ask)}: ${kind.summary(ask)}`;
  item.append(
    element('span', { textContent: `${key} — ${what} — settled by ` }),
    element('strong', { className: 'by', textContent: by }),
    element('span', { textContent: ` (${SETTLED_BY[by]})` }),
  );
  return item;
}

/** A permission's content: the tool, its input as the agent gave it, and its description. */
function permissionContent(ask) {
  const list = element('dl');
  const row = (term, ...details) => list.append(element('dt', { textContent: term }), ...details);
  row('Tool', element('dd', { className: 'tool', textContent: ask.tool }));
  row(
    'Input',
    element('dd', {}, [
      element('pre', { className: 'input', textContent: JSON.stringify(ask.input, null, 2) }),
    ]),
  );
  if (ask.description !== undefined) {
    row('Description', element('dd', { className: 'description', textContent: ask.description }));
  }
  return [list];
}

/** A permission's answers: allow, allow for the rest of the session, or deny with a message. */
function permissionAnswers(_ask, answer) {
  const allow = button('Allow', () => answer({ allow: true }));
  const remember = button('Allow for the session', () =>
    answer({ allow: true, remember: 'session' }),
  );
  const deny = element('form', { className: 'deny' });
  const message = element('input', {
    name: 'message',
    placeholder: 'Why not (optional)',
    autocomplete: 'off',
  });
  message.setAttribute('aria-label', 'Message');
  deny.append(message, element('button', { type: 'submit', textContent: 'Deny' }));
  deny.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = message.value.trim();
    answer(text === '' ? { allow: false } : { allow: false, message: text });
  });
  return [element('p', { className: 'answers' }, [allow, remember]), deny];
}

/** Turns the item's controls off while an answer is on its way, and on again when it failed. */
function setBusy(item, busy) {
  for (const control of item.querySelectorAll('button, input')) control.disabled = busy;
}

function button(label, onClick) {
  const control = element('button', { type: 'button', textContent: label });
  control.addEventListener('click', onClick);
  return control;
}

function timeOf(iso) {
  return new Date(iso).toLocaleTimeString();
}

function element(tag, properties = {}, children = []) {
  const node = document.createElement(tag);
  const { role, ...rest } = properties;
  Object.assign(node, rest);
  if (role !== undefined) node.setAttribute('role', role);
  node.append(...children);
  return node;
}
