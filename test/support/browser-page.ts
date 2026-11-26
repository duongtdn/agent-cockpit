import { vi } from 'vitest';

/** The key under which the client keeps the app's token in the page's storage. */
export const STORED_TOKEN_KEY = 'agent-cockpit.token';

/** A browser page as the client sees it: its address and what it keeps. */
export interface BrowserPage {
  /** The address bar, as it reads now. */
  readonly address: () => string;
  /** The state the page's current history entry holds. */
  readonly historyState: () => unknown;
  /** The page origin's local storage. */
  readonly storage: Storage;
}

/** Local storage that keeps its items in memory. */
export class MemoryStorage implements Storage {
  readonly #items = new Map<string, string>();

  get length(): number {
    return this.#items.size;
  }

  clear(): void {
    this.#items.clear();
  }

  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#items.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#items.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#items.set(key, value);
  }
}

/** Local storage the browser refuses to the page, as a private window may. */
export class RefusedStorage extends MemoryStorage {
  override getItem(): string | null {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  }

  override setItem(): void {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  }
}

/**
 * Opens a page at an address: stubs the globals `location`, `history` and
 * `localStorage` that the client reads, as a browser gives them to a page.
 * `vi.unstubAllGlobals()` closes it.
 *
 * @param address - The page's URL, fragment included.
 * @param options - `storage`, the origin's local storage: empty by default;
 * `state`, what the current history entry holds.
 */
export function openPage(
  address: string,
  { storage = new MemoryStorage(), state = null }: { storage?: Storage; state?: unknown } = {},
): BrowserPage {
  let current = new URL(address);
  let currentState = state;
  vi.stubGlobal('location', {
    get href() {
      return current.href;
    },
  });
  vi.stubGlobal('history', {
    get state() {
      return currentState;
    },
    replaceState(nextState: unknown, _unused: string, url?: string | URL | null) {
      currentState = nextState;
      if (url !== undefined && url !== null) current = new URL(url, current);
    },
  });
  vi.stubGlobal('localStorage', storage);
  return { address: () => current.href, historyState: () => currentState, storage };
}
