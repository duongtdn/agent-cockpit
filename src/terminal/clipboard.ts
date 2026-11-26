/**
 * Reads the text an OSC 52 sequence asks the terminal to put in the
 * clipboard. Its data is `<targets>;<base64>`. tmux sends an empty target
 * (its `set-clipboard`, for its copy-mode and for a program's copy) and a
 * program may name `c`, the clipboard; other targets (`p`, `s`, the cut
 * buffers) have no place in a browser. A query (`?`) is never answered:
 * that would hand the person's clipboard to whatever runs in the session.
 *
 * @param data - The sequence's data, after `52;`.
 * @returns The text, UTF-8 decoded; `undefined` for a query, another target,
 * or data that is no base64.
 */
export function clipboardTextOf(data: string): string | undefined {
  const separator = data.indexOf(';');
  if (separator < 0) return undefined;
  const targets = data.slice(0, separator);
  const payload = data.slice(separator + 1);
  if (targets !== '' && !targets.includes('c')) return undefined;
  if (payload === '' || payload === '?') return undefined;
  let binary: string;
  try {
    binary = atob(payload);
  } catch {
    return undefined;
  }
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

/**
 * Puts a text in the clipboard. The browser may refuse (a page without the
 * permission, out of focus): nothing could be done about it from here, and
 * the person sees their paste is not the text, so the refusal is dropped.
 */
export function writeClipboard(text: string): void {
  navigator.clipboard?.writeText(text).catch(() => undefined);
}
