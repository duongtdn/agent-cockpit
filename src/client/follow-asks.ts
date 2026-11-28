import type { Ask, AskSettled } from '../shared/ask.js';
import type { CockpitError } from '../shared/cockpit-error.js';
import { type AsksServerMessage, followAsksPath } from '../shared/wire.js';
import { callEach } from './app-handlers.js';
import type { Connection } from './connection.js';
import { followStream, typedMessageOf } from './follow-stream.js';

/** The client's follows of the asks and the settled event they feed. */
export interface AsksFollowing {
  /**
   * Follows the asks of a scope over the wire's WebSocket, reconnecting as
   * the sessions' follow does; each ask given to the handler once, and
   * again when its `answerable` changes.
   *
   * @param scope - A session's key, or `'*'` for every session.
   * @returns A function that stops following and closes the socket.
   * @throws `TypeError` for a scope that is neither `'*'` nor a session key.
   */
  follow(scope: string, handler: (ask: Ask) => void): () => void;
  /**
   * Tells each settlement of an ask a follow gave, once.
   *
   * @returns A function that removes the handler.
   * @throws `TypeError` for an event the asks do not have.
   */
  on(event: 'settled', handler: (settled: AskSettled) => void): () => void;
}

/**
 * What one follow gave its handler: each pending ask's id, with the
 * `answerable` it was given with.
 */
type GivenAsks = Map<string, Ask['answerable']>;

/**
 * Creates the client's follows of the asks. A settlement is told only of an
 * ask a follow gave and still holds pending, so that it is told once
 * however many follows cover its key, and whether it comes as its own
 * message or, after a reconnection, in the snapshot's settlements; a past
 * settlement of the snapshot, of an ask the page never saw, is not told.
 *
 * @param report - Told why a follow's connection could not be made.
 */
export function createAsksFollowing(
  connection: Connection,
  report: (error: CockpitError) => void,
): AsksFollowing {
  const follows = new Set<GivenAsks>();
  const settledHandlers = new Set<(settled: AskSettled) => void>();

  const tellSettled = ({ id, key, by }: AskSettled): void => {
    let given = false;
    for (const asks of follows) given = asks.delete(id) || given;
    if (given) callEach(settledHandlers, { id, key, by });
  };

  const follow: AsksFollowing['follow'] = (scope, handler) => {
    const path = followAsksPath(scope);
    const given: GivenAsks = new Map();
    const offer = (ask: Ask): void => {
      if (given.get(ask.id) === ask.answerable) return;
      given.set(ask.id, ask.answerable);
      callEach([handler], ask);
    };
    const receive = (message: AsksServerMessage): void => {
      switch (message.type) {
        case 'asks':
          for (const ask of message.pending) offer(ask);
          for (const settled of message.settled) tellSettled(settled);
          forgetAllBut(given, message.pending);
          return;
        case 'ask':
          offer(message.ask);
          return;
        case 'settled':
          tellSettled(message);
          return;
      }
    };
    follows.add(given);
    const stop = followStream(connection, path, { read: asksMessageOf, deliver: receive }, report);
    return () => {
      follows.delete(given);
      stop();
    };
  };

  return {
    follow,
    on: (event, handler) => {
      if (event !== 'settled') {
        throw new TypeError(`The asks have no event ${JSON.stringify(event)}.`);
      }
      // A handler given twice is two subscriptions, each removed by its own function.
      const subscription = (settled: AskSettled): void => handler(settled);
      settledHandlers.add(subscription);
      return () => {
        settledHandlers.delete(subscription);
      };
    },
  };
}

/**
 * Forgets each ask given that a snapshot no longer holds pending: one gone
 * unsettled while the socket was down (its key removed), whose settlement
 * will never come.
 */
function forgetAllBut(given: GivenAsks, pending: readonly Ask[]): void {
  const pendingIds = new Set(pending.map((ask) => ask.id));
  for (const id of given.keys()) if (!pendingIds.has(id)) given.delete(id);
}

/** A message of the asks' socket; `undefined` for anything else, which is skipped. */
function asksMessageOf(data: unknown): AsksServerMessage | undefined {
  const message = typedMessageOf(data);
  switch (message?.type) {
    case 'asks':
      return Array.isArray(message.pending) && Array.isArray(message.settled)
        ? (message as unknown as AsksServerMessage)
        : undefined;
    case 'ask':
      return isObject(message.ask) ? (message as unknown as AsksServerMessage) : undefined;
    case 'settled':
      return typeof message.id === 'string' ? (message as unknown as AsksServerMessage) : undefined;
    default:
      return undefined;
  }
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}
