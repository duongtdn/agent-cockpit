/**
 * Stand-ins for xterm.js and its fit addon, for the terminal's unit tests in
 * Node. xterm.js needs a browser's layout (it measures its glyphs to size
 * itself), which no DOM library for Node gives, and `@xterm/headless` has
 * neither selection nor custom key handling. These play only the part of
 * the API the cockpit uses, as xterm.js documents it; the browser test runs
 * the real xterm.js for what only a browser shows.
 *
 * A test replaces the modules with `vi.mock('@xterm/xterm', …)` and
 * `vi.mock('@xterm/addon-fit', …)` returning these classes.
 */

interface Disposable {
  dispose(): void;
}

/** A key as the cockpit's handler reads it, with what the handler did to it. */
export interface FakeKeyEvent {
  readonly type: 'keydown' | 'keypress' | 'keyup';
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
}

/** What xterm.js would do with a key: send its text (`true`) or not. */
export interface KeyOutcome {
  /** Whether the handler left the `keydown` to xterm.js. */
  readonly keydown: boolean;
  /** Whether the handler left the `keypress` to xterm.js. */
  readonly keypress: boolean;
  /** Whether the handler prevented the browser's default. */
  readonly prevented: boolean;
}

type Listener<T> = (value: T) => void;

function listeners<T>(): { add(listener: Listener<T>): Disposable; fire(value: T): void } {
  const all = new Set<Listener<T>>();
  return {
    add: (listener) => {
      all.add(listener);
      return { dispose: () => all.delete(listener) };
    },
    fire: (value) => {
      for (const listener of all) listener(value);
    },
  };
}

/** A stand-in for xterm.js's `Terminal`. */
export class FakeTerminal {
  /** Every terminal created, in order. */
  static readonly created: FakeTerminal[] = [];

  /** The last terminal created. */
  static last(): FakeTerminal {
    const terminal = FakeTerminal.created.at(-1);
    if (terminal === undefined) throw new Error('No terminal was created.');
    return terminal;
  }

  readonly options: Record<string, unknown>;
  /** The element it was opened in. */
  element: unknown;
  cols = 80;
  rows = 24;
  focused = false;
  disposed = false;
  /** The terminal's own selection: what a Shift+drag selected. */
  selection = '';
  /** Every output written, in order. */
  readonly written: Uint8Array[] = [];
  readonly addons: { activate(terminal: FakeTerminal): void }[] = [];

  readonly #data = listeners<string>();
  readonly #binary = listeners<string>();
  readonly #resize = listeners<{ cols: number; rows: number }>();
  readonly #sequences = new Map<number, ((data: string) => boolean)[]>();
  #keyHandler: ((event: FakeKeyEvent) => boolean) | undefined;

  readonly parser = {
    registerOscHandler: (identifier: number, handler: (data: string) => boolean): Disposable => {
      const handlers = this.#sequences.get(identifier) ?? [];
      handlers.push(handler);
      this.#sequences.set(identifier, handlers);
      return { dispose: () => handlers.splice(handlers.indexOf(handler), 1) };
    },
  };

  constructor(options: Record<string, unknown> = {}) {
    this.options = options;
    FakeTerminal.created.push(this);
  }

  loadAddon(addon: { activate(terminal: FakeTerminal): void }): void {
    this.addons.push(addon);
    addon.activate(this);
  }

  open(element: unknown): void {
    this.element = element;
  }

  write(data: Uint8Array): void {
    this.written.push(data);
  }

  onData(listener: Listener<string>): Disposable {
    return this.#data.add(listener);
  }

  onBinary(listener: Listener<string>): Disposable {
    return this.#binary.add(listener);
  }

  onResize(listener: Listener<{ cols: number; rows: number }>): Disposable {
    return this.#resize.add(listener);
  }

  attachCustomKeyEventHandler(handler: (event: FakeKeyEvent) => boolean): void {
    this.#keyHandler = handler;
  }

  hasSelection(): boolean {
    return this.selection !== '';
  }

  getSelection(): string {
    return this.selection;
  }

  clearSelection(): void {
    this.selection = '';
  }

  focus(): void {
    this.focused = true;
  }

  dispose(): void {
    this.disposed = true;
  }

  // What a test does to the terminal, as a person or the session would.

  /** All output written, decoded as UTF-8. */
  text(): string {
    return this.written.map((bytes) => new TextDecoder().decode(bytes)).join('');
  }

  /** The person types: xterm.js gives the text to its `onData` listeners. */
  type(text: string): void {
    this.#data.fire(text);
  }

  /** xterm.js gives raw bytes (a mouse report of the old encoding) to `onBinary`. */
  typeBinary(text: string): void {
    this.#binary.fire(text);
  }

  /** The terminal takes a new size, as fitting does. */
  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.#resize.fire({ cols, rows });
  }

  /**
   * The person presses a key: the browser's `keydown`, then its `keypress`,
   * each through the custom handler first, as xterm.js does.
   */
  press(
    key: string,
    modifiers: { shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean } = {},
  ): KeyOutcome {
    let prevented = false;
    const event = (type: FakeKeyEvent['type']): FakeKeyEvent => ({
      type,
      key,
      shiftKey: modifiers.shift ?? false,
      ctrlKey: modifiers.ctrl ?? false,
      altKey: modifiers.alt ?? false,
      metaKey: modifiers.meta ?? false,
      defaultPrevented: false,
      preventDefault() {
        prevented = true;
      },
    });
    const handle = (type: FakeKeyEvent['type']): boolean => this.#keyHandler?.(event(type)) ?? true;
    const keydown = handle('keydown');
    const keypress = handle('keypress');
    return { keydown, keypress, prevented };
  }

  /** The session sends an OSC sequence: the handlers run, the last registered first. */
  sequence(identifier: number, data: string): boolean {
    const handlers = [...(this.#sequences.get(identifier) ?? [])].reverse();
    return handlers.some((handler) => handler(data));
  }
}

/** A stand-in for `@xterm/addon-fit`: fitting gives the terminal the size the test set. */
export class FakeFitAddon {
  /** The size the element's box holds, in cells: what the next fit gives. */
  static proposed = { cols: 100, rows: 30 };

  #terminal: FakeTerminal | undefined;

  activate(terminal: FakeTerminal): void {
    this.#terminal = terminal;
  }

  fit(): void {
    this.#terminal?.resize(FakeFitAddon.proposed.cols, FakeFitAddon.proposed.rows);
  }

  dispose(): void {}
}

/** A stand-in for the browser's `ResizeObserver`: the test says when the element changed size. */
export class FakeResizeObserver {
  static readonly observers: FakeResizeObserver[] = [];

  readonly #callback: () => void;
  observed: unknown[] = [];

  constructor(callback: () => void) {
    this.#callback = callback;
    FakeResizeObserver.observers.push(this);
  }

  observe(element: unknown): void {
    this.observed.push(element);
  }

  disconnect(): void {
    this.observed = [];
  }

  /** The element's box changed size: an observer still observing it is told. */
  static elementResized(element: unknown): void {
    for (const observer of FakeResizeObserver.observers) {
      if (observer.observed.includes(element)) observer.#callback();
    }
  }
}
