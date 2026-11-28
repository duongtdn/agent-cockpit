import { randomUUID } from 'node:crypto';
import type { Ask, AskAnswer, AskSettled } from '../../shared/ask.js';
import { CockpitError } from '../../shared/cockpit-error.js';
import type { AskContent } from '../driver.js';
import { checkAnswer } from './answers.js';

/**
 * Hands the app's answer to the connection the agent waits on: `'written'`
 * once the reply is written and the response ended, `'closed'` when the
 * connection was found closed (the agent let the ask go), nothing written.
 * The core builds it from the driver's reply and the held hook.
 */
export type AnswerHandOff = (answer: AskAnswer) => 'written' | 'closed';

/**
 * Who can answer an ask: the app, through the connection its answer is
 * handed to, or only a person in the session's terminal.
 */
export type Answering =
  | { readonly answerable: 'app'; readonly handOff: AnswerHandOff }
  | { readonly answerable: 'terminal' };

/** What settles an ask other than the app's answer, which the core reads from the agent. */
export type SettledByAgent = Exclude<AskSettled['by'], 'app'>;

/** What the asks need of the cockpit. */
export interface AsksOptions {
  /** The time now: an ask's `since`. */
  readonly clock: () => Date;
  /**
   * Receives what a follower or a `settled` handler throws: the console, by
   * default, as what the sessions' followers throw.
   */
  readonly handlerThrew?: (thrown: unknown) => void;
}

/**
 * Why an answer was refused: the cockpit was closed first. It carries no
 * code, since no request of an app's can mend it — on the wire it is a 500
 * with no body — and the agent keeps its dialog in the terminal.
 */
export class AsksClosedError extends Error {
  override readonly name = 'AsksClosedError';

  /** @param id - The id of the ask answered. */
  constructor(id: string) {
    super(
      `The cockpit was closed before the answer to the ask ${id}: the agent keeps its dialog in the terminal.`,
    );
  }
}

/** How many settled asks a key keeps, to refuse a late answer `already-settled` rather than `unknown-id`. */
const SETTLED_KEPT_PER_KEY = 1_000;

interface PendingAsk {
  readonly ask: Ask;
  readonly answering: Answering;
}

interface Follower {
  readonly scope: string;
  readonly handler: (ask: Ask) => void;
}

/**
 * The asks of every session: those pending, in the order they opened, and
 * the settled ones each key remembers. The core opens an ask when the agent
 * waits on a person, settles it from what the agent tells (`terminal`,
 * `cancelled`), and lets a removed key's asks go; the app follows them,
 * answers them, and is told each settlement. Knows neither the driver nor
 * HTTP: an answer goes to the connection through the ask's
 * {@link AnswerHandOff}.
 */
export class Asks {
  readonly #clock: () => Date;
  readonly #handlerThrew: (thrown: unknown) => void;
  /** In the order the asks opened: a Map keeps its insertion order, and a replaced value its place. */
  readonly #pending = new Map<string, PendingAsk>();
  /** In the order the asks settled. */
  readonly #settled = new Map<string, AskSettled>();
  /** Each key's settled ids, oldest first. */
  readonly #settledOfKey = new Map<string, Set<string>>();
  readonly #followers = new Set<Follower>();
  readonly #settledHandlers = new Set<(settled: AskSettled) => void>();
  #closed = false;

  /** @param options - The clock and the sink of what handlers throw. */
  constructor(options: AsksOptions) {
    this.#clock = options.clock;
    this.#handlerThrew = options.handlerThrew ?? ((thrown) => console.error(thrown));
  }

  /**
   * Opens an ask, pending until settled, and gives it to the followers of
   * its key.
   *
   * @param key - The key of the unit of work whose session asks.
   * @param content - What the agent asks, as the driver read it.
   * @param answering - Who can answer it.
   * @returns The ask, with its new id.
   */
  open(key: string, content: AskContent, answering: Answering): Ask {
    const ask: Ask = {
      id: randomUUID(),
      key,
      ...content,
      answerable: answering.answerable,
      since: this.#clock().toISOString(),
    };
    this.#pending.set(ask.id, { ask, answering });
    this.#tellFollowers(ask);
    return ask;
  }

  /**
   * Settles a pending ask from what the agent told, and tells it to the
   * `settled` handlers. The held connection is the core's to let go.
   *
   * @param id - The ask's id.
   * @param by - What settled it.
   * @returns Whether it settled the ask now: false for one settled before,
   * or unknown.
   */
  settle(id: string, by: SettledByAgent): boolean {
    const pending = this.#pending.get(id);
    if (pending === undefined) return false;
    this.#settle(pending.ask, by);
    return true;
  }

  /**
   * The pending asks of a key, or of every key.
   *
   * @param scope - The unit of work's key, or `'*'` for every one.
   * @returns The scope's pending asks, in the order they opened.
   */
  pending(scope: string): readonly Ask[] {
    return this.#pendingIn(scope);
  }

  /**
   * The settlements remembered of a key, or of every key: each key's 1,000
   * most recent, until the key is removed. A follower that connects learns
   * from them which asks were settled while it was away, and by whom.
   *
   * @param scope - The unit of work's key, or `'*'` for every one.
   * @returns The scope's settlements, oldest first.
   */
  settled(scope: string): readonly AskSettled[] {
    return [...this.#settled.values()].filter((settled) => inScope(scope, settled));
  }

  /**
   * Forgets the settled asks of a removed key: a later answer to one of
   * them is refused `unknown-id`. Its pending asks, which its session's end
   * settled before, are not its to settle.
   *
   * @param key - The removed unit of work's key.
   */
  forget(key: string): void {
    for (const id of this.#settledOfKey.get(key) ?? []) this.#settled.delete(id);
    this.#settledOfKey.delete(key);
  }

  /**
   * Follows the asks of a key, or of every key: the handler gets each
   * pending ask of the scope at once, in the order they opened, then each
   * new one; never a settled one. Whether anyone follows never changes what the agent is
   * answered.
   *
   * @param key - The unit of work's key, or `'*'` for every one.
   * @param handler - Receives each ask; what it throws goes to the error
   * sink, and it stays subscribed.
   * @returns A function that stops following.
   */
  follow(key: string, handler: (ask: Ask) => void): () => void {
    if (this.#closed) return () => {};
    const follower: Follower = { scope: key, handler };
    this.#followers.add(follower);
    for (const ask of this.#pendingIn(key)) {
      // A handler may stop, or settle an ask the snapshot still holds.
      if (!this.#followers.has(follower)) break;
      if (this.#pending.has(ask.id)) this.#tellOne(handler, ask);
    }
    return () => void this.#followers.delete(follower);
  }

  /**
   * Answers an ask, in one synchronous step: checked, handed to its
   * connection, settled `app` and told.
   *
   * @param id - The ask's id.
   * @param answer - The answer, of the ask's kind: any value, checked here.
   * @returns A promise fulfilled, with nothing, once the reply is handed to
   * the connection.
   * @throws `CockpitError`, checked in this order: `unknown-id` for an id
   * never opened, or forgotten; `already-settled` with `by` for an ask
   * settled before, or whose connection was found closed (`cancelled`);
   * `terminal-only` for an ask answerable in the terminal only;
   * `invalid-answer` with `issues` for an answer that does not fit its kind.
   * @throws {@link AsksClosedError} once the asks are closed, before any check.
   */
  async answer(id: string, answer: unknown): Promise<void> {
    if (this.#closed) throw new AsksClosedError(id);
    const { ask, handOff } = this.#answerable(id);
    const checked = checkAnswer(ask.kind, answer);
    if ('issues' in checked) {
      throw new CockpitError('invalid-answer', `The answer does not fit the ask ${id}.`, {
        id,
        issues: checked.issues,
      });
    }
    if (handOff(checked.answer) === 'written') {
      this.#settle(ask, 'app');
      return;
    }
    this.#settle(ask, 'cancelled');
    throw alreadySettled(id, 'cancelled');
  }

  /**
   * Tells each ask settled, once, the app's own answers included.
   *
   * @param event - `'settled'`.
   * @param handler - Receives the ask's id, its key and what settled it;
   * what it throws goes to the error sink.
   * @returns A function that removes the handler.
   * @throws `TypeError` for an event the asks do not have.
   */
  on(event: 'settled', handler: (settled: AskSettled) => void): () => void {
    if (event !== 'settled')
      throw new TypeError(`The asks have no event ${JSON.stringify(event)}.`);
    if (this.#closed) return () => {};
    // Wrapped, so that a handler given twice is told twice and removed once per unsubscribe.
    const settledHandler = (settled: AskSettled) => handler(settled);
    this.#settledHandlers.add(settledHandler);
    return () => void this.#settledHandlers.delete(settledHandler);
  }

  /**
   * Closes the asks with the cockpit: nobody is told anything from now on —
   * no follower, no `settled` handler, those added later included — and
   * every answer is refused. No ask is settled: the held hooks are the
   * listener's to drop.
   */
  close(): void {
    this.#closed = true;
    this.#followers.clear();
    this.#settledHandlers.clear();
  }

  /** The pending ask of an id the app may answer, or the refusal of its answer. */
  #answerable(id: string): { ask: Ask; handOff: AnswerHandOff } {
    const settled = this.#settled.get(id);
    if (settled !== undefined) throw alreadySettled(id, settled.by);
    const pending = this.#pending.get(id);
    if (pending === undefined) {
      throw new CockpitError('unknown-id', `No ask has the id ${JSON.stringify(id)}.`, { id });
    }
    if (pending.answering.answerable === 'terminal') {
      throw new CockpitError(
        'terminal-only',
        `The ask ${id} can only be answered in the terminal.`,
        {
          id,
        },
      );
    }
    return { ask: pending.ask, handOff: pending.answering.handOff };
  }

  #settle(ask: Ask, by: AskSettled['by']): void {
    const settled: AskSettled = { id: ask.id, key: ask.key, by };
    this.#pending.delete(ask.id);
    this.#remember(settled);
    for (const handler of [...this.#settledHandlers]) this.#tellOne(handler, settled);
  }

  #remember(settled: AskSettled): void {
    const ids = this.#settledOfKey.get(settled.key) ?? new Set<string>();
    this.#settledOfKey.set(settled.key, ids);
    ids.add(settled.id);
    this.#settled.set(settled.id, settled);
    if (ids.size <= SETTLED_KEPT_PER_KEY) return;
    const [oldest] = ids;
    if (oldest === undefined) return;
    ids.delete(oldest);
    this.#settled.delete(oldest);
  }

  #pendingIn(scope: string): Ask[] {
    return [...this.#pending.values()].map(({ ask }) => ask).filter((ask) => inScope(scope, ask));
  }

  #tellFollowers(ask: Ask): void {
    for (const follower of [...this.#followers]) {
      if (!this.#followers.has(follower) || !inScope(follower.scope, ask)) continue;
      this.#tellOne(follower.handler, ask);
    }
  }

  #tellOne<T>(handler: (value: T) => void, value: T): void {
    try {
      handler(value);
    } catch (thrown) {
      this.#handlerThrew(thrown);
    }
  }
}

function inScope(scope: string, of: { readonly key: string }): boolean {
  return scope === '*' || of.key === scope;
}

function alreadySettled(id: string, by: AskSettled['by']): CockpitError<'already-settled'> {
  return new CockpitError('already-settled', `The ask ${id} was settled before this answer.`, {
    id,
    by,
  });
}
