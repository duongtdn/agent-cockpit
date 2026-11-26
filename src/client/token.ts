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
}

/**
 * Takes the app's token from the page's link, when it carries one: removes
 * it from the address bar, so a bookmark, a screenshot or a shared address
 * never holds it, and keeps it in the origin's local storage, so a reload or
 * another tab of the app needs no link. The token is read from the storage
 * at every call, so a link opened in another tab serves this one too.
 *
 * @returns The keeper of the token for this page.
 */
export function takeTokenFromLink(): TokenKeeper {
  const linked = removeTokenFromAddress();
  // The storage may be refused to the page (a private window, a policy): the
  // page then keeps the link's token for its own life.
  let kept = linked;
  if (linked !== undefined) writeStorage(linked);
  return {
    current: () => {
      const stored = readStorage();
      if (stored !== undefined) kept = stored;
      return kept;
    },
  };
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
