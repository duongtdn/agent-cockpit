/** A key as the fake agent takes it. `other` is a key it has no use for. */
export type Key =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'enter' }
  | { readonly kind: 'escape' }
  | { readonly kind: 'line-break' }
  | { readonly kind: 'backspace' }
  | { readonly kind: 'kill-line' }
  | { readonly kind: 'yank' }
  | { readonly kind: 'end-of-line' }
  | { readonly kind: 'yank-pop' }
  | { readonly kind: 'up' }
  | { readonly kind: 'down' }
  | { readonly kind: 'other' };

/** Reads keys from what a terminal sends, over as many writes as they take. */
export interface KeyDecoder {
  /**
   * Reads the keys in a piece of terminal input.
   *
   * @returns The keys that are complete; an ESC at the end waits for what follows.
   */
  decode(chunk: string): Key[];
  /** Tells whether an ESC waits to be told from the start of a longer key. */
  awaitsMore(): boolean;
  /**
   * Ends the wait: an ESC that nothing followed is the Escape key.
   *
   * @returns That key, or nothing when no ESC waited.
   */
  settle(): Key[];
}

const ESC = '\x1b';

/** The keys that are one control character. */
const CONTROL_KEYS: Readonly<Record<string, Key>> = {
  '\r': { kind: 'enter' },
  '\x7f': { kind: 'backspace' },
  '\b': { kind: 'backspace' },
  '\x15': { kind: 'kill-line' },
  '\x19': { kind: 'yank' },
  '\x05': { kind: 'end-of-line' },
};

/** Where the decoder is in a key of several characters. */
type Progress = 'none' | 'after-esc' | 'in-csi' | 'in-ss3';

/**
 * Creates a decoder of terminal input.
 *
 * @returns The decoder, with no key begun.
 */
export function createKeyDecoder(): KeyDecoder {
  let progress: Progress = 'none';
  let csiParameters = '';

  function decode(chunk: string): Key[] {
    const keys: Key[] = [];
    for (const character of chunk) {
      const key = read(character);
      if (key !== undefined) append(keys, key);
    }
    return keys;
  }

  function read(character: string): Key | undefined {
    const before = progress;
    progress = 'none';
    switch (before) {
      case 'after-esc':
        return readAfterEsc(character);
      case 'in-csi':
        return readInCsi(character);
      case 'in-ss3':
        return arrowKey(character);
      default:
        return readPlain(character);
    }
  }

  function readPlain(character: string): Key | undefined {
    if (character === ESC) {
      progress = 'after-esc';
      return undefined;
    }
    return CONTROL_KEYS[character] ?? (character < ' ' ? { kind: 'other' } : textKey(character));
  }

  function readAfterEsc(character: string): Key | undefined {
    if (character === '\r') return { kind: 'line-break' };
    if (character === 'y') return { kind: 'yank-pop' };
    if (character === ESC) {
      progress = 'after-esc';
      return { kind: 'escape' };
    }
    if (character === '[') {
      progress = 'in-csi';
      csiParameters = '';
    } else if (character === 'O') progress = 'in-ss3';
    return progress === 'none' ? { kind: 'other' } : undefined;
  }

  /** A control sequence ends with a character from `@` to `~`; the arrows with no parameter, at once. */
  function readInCsi(character: string): Key | undefined {
    if (character >= '@' && character <= '~')
      return csiParameters === '' ? arrowKey(character) : { kind: 'other' };
    csiParameters += character;
    progress = 'in-csi';
    return undefined;
  }

  function settle(): Key[] {
    const wasEsc = progress === 'after-esc';
    progress = 'none';
    return wasEsc ? [{ kind: 'escape' }] : [];
  }

  return { decode, awaitsMore: () => progress === 'after-esc', settle };
}

/** The arrow keys a terminal sends as `ESC [ A` or `ESC O A` (and `B`); any other ends as `other`. */
function arrowKey(final: string): Key {
  if (final === 'A') return { kind: 'up' };
  if (final === 'B') return { kind: 'down' };
  return { kind: 'other' };
}

function textKey(text: string): Key {
  return { kind: 'text', text };
}

/** Adds a key to the keys read so far, typed characters in a row as one text. */
function append(keys: Key[], key: Key): void {
  const last = keys.at(-1);
  if (key.kind === 'text' && last?.kind === 'text') {
    keys[keys.length - 1] = textKey(last.text + key.text);
  } else {
    keys.push(key);
  }
}
