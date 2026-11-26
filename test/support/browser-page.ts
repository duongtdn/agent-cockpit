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
  /**
   * Opens a link to this page in its own tab, as a person pastes one in the
   * address bar: only the fragment changes, so the page is not loaded again;
   * the browser fires `hashchange`.
   *
   * @param fragment - The new fragment, without its `#`.
   */
  readonly followFragment: (fragment: string) => void;
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
 * Opens a page at an address: stubs the globals `location`, `history`,
 * `localStorage` and the window's `addEventListener` and
 * `removeEventListener` that the client uses, as a browser gives them to a
 * page. `vi.unstubAllGlobals()` closes it. A module that listens to the
 * window listens to the page it was loaded for: a test of the page's events
 * loads the client afresh ({@link loadAfresh}).
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
  const window = new EventTarget();
  vi.stubGlobal('addEventListener', window.addEventListener.bind(window));
  vi.stubGlobal('removeEventListener', window.removeEventListener.bind(window));
  return {
    address: () => current.href,
    historyState: () => currentState,
    storage,
    followFragment: (fragment) => {
      const next = new URL(current);
      next.hash = fragment;
      if (next.href === current.href) return;
      current = next;
      window.dispatchEvent(new Event('hashchange'));
    },
  };
}

/**
 * Loads the module a page's script imports, as a page newly opened loads it:
 * afresh, holding nothing an earlier page's modules kept (the token a page
 * took from its link lives in the client's module). A test file's static
 * imports are loaded once, for all its pages.
 *
 * @param load - Imports the module, such as `() => import('…/client/index.ts')`.
 * @returns The module, loaded afresh.
 */
export async function loadAfresh<Module>(load: () => Promise<Module>): Promise<Module> {
  vi.resetModules();
  return load();
}
