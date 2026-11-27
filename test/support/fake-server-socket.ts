import { EventEmitter } from 'node:events';

/** The server's side of a terminal's WebSocket, as the pty bridge uses it, driven by the test. */
export class FakeServerSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  /** The bytes the socket still holds to send: the test sets them, as a page that reads slowly would. */
  bufferedAmount = 0;
  /** The text messages the bridge sent, parsed. */
  readonly messages: unknown[] = [];
  /** The binary messages the bridge sent: what the session drew, as UTF-8. */
  readonly output: string[] = [];
  closedWith: number | undefined;

  send(data: string | Buffer): void {
    if (typeof data === 'string') this.messages.push(JSON.parse(data));
    else this.output.push(data.toString('utf8'));
  }

  close(code: number): void {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.closedWith = code;
    this.emit('close', code);
  }

  /** The browser sends its size. */
  resize(columns: number, rows: number): void {
    this.emit('message', Buffer.from(JSON.stringify({ type: 'resize', columns, rows })), false);
  }

  /** The person types. */
  type(text: string): void {
    this.emit('message', Buffer.from(text, 'utf8'), true);
  }

  /** The kinds of the hold's messages the bridge sent, in order. */
  holdMessages(): unknown[] {
    return this.messages
      .map((message) => (message as { type: string }).type)
      .filter((type) => type === 'held' || type === 'released');
  }
}
