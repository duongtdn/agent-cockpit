import type { Attachment, TerminalSize } from '../../src/server/session-host/session-host.ts';

/** A terminal attached to a session, as the host would give it, that records what it is told. */
export class FakeAttachment implements Attachment {
  readonly written: string[] = [];
  readonly sizes: TerminalSize[] = [];
  detached = false;
  #data = new Set<(data: string) => void>();
  #end = new Set<() => void>();
  onData(listener: (data: string) => void) {
    this.#data.add(listener);
    return () => void this.#data.delete(listener);
  }
  onEnd(listener: () => void) {
    this.#end.add(listener);
    return () => void this.#end.delete(listener);
  }
  write(data: string) {
    this.written.push(data);
  }
  resize(size: TerminalSize) {
    this.sizes.push(size);
  }
  async detach() {
    this.detached = true;
  }
  /** The session draws. */
  draw(data: string) {
    for (const listener of this.#data) listener(data);
  }
  /** The attachment ends, as when the session does. */
  end() {
    for (const listener of this.#end) listener();
  }
}
