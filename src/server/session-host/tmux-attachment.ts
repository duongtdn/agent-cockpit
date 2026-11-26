import { spawn } from 'node-pty';
import type { Attachment, TerminalSize } from './session-host.js';
import type { TmuxClient } from './tmux-client.js';
import { attachArguments, CLIENT_TERMINAL_TYPE, ptySize } from './tmux-commands.js';

/** A terminal on its way to a session: the tmux client is started, not yet attached. */
export interface AttachingTerminal {
  /** The attachment, to hand out once the client is attached. */
  readonly attachment: Attachment;
  /** The process id of the tmux client: what tmux lists the client by. */
  readonly clientPid: number;
  /** Whether the client has exited. */
  hasEnded(): boolean;
}

/**
 * Starts a tmux client that attaches to a session, in a pty of its own. Its
 * output from the start, the screen tmux draws as it attaches included, goes
 * to the attachment's first listener; later listeners hear from then on. The
 * client is told its terminal is xterm's: the browser's terminal emulates
 * it, and tmux sends the clipboard, focus and color sequences only to a
 * terminal it knows to take them.
 *
 * What is written before tmux has attached the client is not input of the
 * session: the pty echoes it, and a Ctrl+C ends the client. The caller waits
 * until tmux lists the client before it hands the attachment out.
 *
 * @param tmux - The client of the app's tmux server.
 * @param name - The session's name.
 * @param size - The terminal's size.
 * @returns The terminal. Its attachment ends by itself when the session
 * does not live, or no longer.
 */
export function attachTerminal(
  tmux: TmuxClient,
  name: string,
  size: TerminalSize,
): AttachingTerminal {
  const pty = spawn(tmux.executable, [...tmux.connection, ...attachArguments(name)], {
    name: CLIENT_TERMINAL_TYPE,
    ...ptySize(size),
    env: tmux.environment(),
  });
  // tmux draws the whole screen as it attaches, before the attachment is
  // handed out: what comes before the first listener is held for it.
  const held: string[] = [];
  const listeners = new Set<(data: string) => void>();
  let heard = false;
  pty.onData((data) => {
    if (!heard) held.push(data);
    for (const listener of listeners) listener(data);
  });
  // A pty whose client has exited throws on a write or a resize.
  let ended = false;
  const end = new Promise<void>((resolve) => {
    pty.onExit(() => {
      ended = true;
      resolve();
    });
  });

  const attachment: Attachment = {
    onData(listener) {
      // A wrapper of its own, so that one listener given twice is two.
      const each = (data: string) => listener(data);
      if (!heard) {
        heard = true;
        for (const data of held.splice(0)) each(data);
      }
      listeners.add(each);
      return () => void listeners.delete(each);
    },
    onEnd(listener) {
      let listening = true;
      void end.then(() => {
        if (listening) listener();
      });
      return () => {
        listening = false;
      };
    },
    write(data) {
      if (!ended) pty.write(data);
    },
    resize(newSize) {
      const { cols, rows } = ptySize(newSize);
      if (!ended) pty.resize(cols, rows);
    },
    detach() {
      // The client takes the hang-up as its terminal closing and detaches.
      if (!ended) pty.kill();
      return end;
    },
  };
  return { attachment, clientPid: pty.pid, hasEnded: () => ended };
}
