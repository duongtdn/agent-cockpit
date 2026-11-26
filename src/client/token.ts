import { isWireToken } from '../shared/wire.js';

/** The key of the fragment that carries the token in the app's link. */
const FRAGMENT_KEY = 'cockpit';

/**
 * Where the token is kept in the origin's local storage. Storage is kept per
 * origin, port included, so another app on the same host keeps its own.
 */
const STORAGE_KEY = 'agent-cockpit.token';

/** Where a page keeps the app's token and finds it again. */
export interface TokenKeeper {
  /** The token to send now; `undefined` when the page has none. */
  current(): string | undefined;
  /**
   * Tells when a link gives the page a token while it is open: a link
   * pasted into its tab changes only the fragment, which loads nothing
   * again. The token is taken by then: {@link current} gives it.
   *
   * @param listener - Called once per such link.
   * @returns A function that stops telling it.
   */
  onLinked(listener: () => void): () => void;
}

/**
 * The token this page knows: the one its link carried, or the last one read
 * from the storage. It is the page's, not a caller's: the first caller takes
 * the token from the address bar and leaves none there for the next (the
 * client and the terminal both take it), and with the storage refused to
 * the page this is where every caller finds it.
 */
let pageToken: string | undefined;

/** Who wants to know of a token a link gives while the page is open. */
const linkedListeners = new Set<() => void>();

/** Whether the page's fragment changes are watched: once per page, for its whole life. */
let watchingLinks = false;

/**
 * Takes the app's token from the page's link, when it carries one: removes
 * it from the address bar, so a bookmark, a screenshot or a shared address
 * never holds it, and keeps it in the origin's local storage, so a reload or
 * another tab of the app needs no link. The token is read from the storage
 * at every call, so a link opened in another tab serves this one too. Every
 * caller on a page gets the token the first one took. A link opened later in
 * the page's own tab (`hashchange`) is taken the same way.
 *
 * @returns The keeper of the token for this page.
 */
export function takeTokenFromLink(): TokenKeeper {
  takeLinkedToken();
  watchLinks();
  return {
    current: () => {
      // The storage may be refused to the page (a private window, a policy):
      // the page then keeps the token it knows for its own life.
      pageToken = readStorage() ?? pageToken;
      return pageToken;
    },
    onLinked: (listener) => {
      // A listener given twice is two subscriptions, each removed by its own function.
      const subscription = (): void => listener();
      linkedListeners.add(subscription);
      return () => {
        linkedListeners.delete(subscription);
      };
    },
  };
}

/**
 * Takes the token the page's address carries, when it carries one.
 *
 * @returns Whether it carried a valid one.
 */
function takeLinkedToken(): boolean {
  const linked = removeTokenFromAddress();
  if (linked === undefined) return false;
  pageToken = linked;
  writeStorage(linked);
  return true;
}

function watchLinks(): void {
  if (watchingLinks) return;
  watchingLinks = true;
  addEventListener('hashchange', () => {
    if (!takeLinkedToken()) return;
    for (const listener of linkedListeners) listener();
  });
}

/** Removes the token from the address bar, leaving the rest of the fragment. */
function removeTokenFromAddress(): string | undefined {
  const address = new URL(location.href);
  const parts = address.hash.slice(1).split('&');
  const carrier = parts.find((part) => part.startsWith(`${FRAGMENT_KEY}=`));
  if (carrier === undefined) return undefined;
  const others = parts.filter((part) => part !== carrier);
  address.hash = others.join('&');
  // An empty `hash` still leaves a `#` behind.
  const cleaned = others.length === 0 ? address.href.replace(/#$/, '') : address.href;
  history.replaceState(history.state, '', cleaned);
  const token = carrier.slice(FRAGMENT_KEY.length + 1);
  return isWireToken(token) ? token : undefined;
}

function readStorage(): string | undefined {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored !== null && isWireToken(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

function writeStorage(token: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Refused storage: the keeper holds the token in memory instead.
  }
}
