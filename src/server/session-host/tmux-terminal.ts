import { execFile } from 'node:child_process';

/** tmux's own terminal type, with 256 colors: what the programs in a pane should take their terminal for. */
const TMUX_TERMINAL_TYPE = 'tmux-256color';

/** The terminal type every machine describes; a few of tmux's abilities are not in it (italics). */
const FALLBACK_TERMINAL_TYPE = 'screen-256color';

/**
 * Chooses the terminal type of the host's panes: `tmux-256color` when the
 * machine's terminal database describes it, else `screen-256color` — a
 * program told of a terminal type its machine does not describe refuses to
 * draw. (macOS's own database lacks `tmux-256color`.)
 *
 * @param infocmp - The program that prints a terminal's description and
 * fails when the machine has none.
 * @param timeoutMs - How long it may take; past that, the machine cannot tell.
 * @returns The terminal type. It never rejects.
 */
export function paneTerminalType(infocmp: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile(infocmp, [TMUX_TERMINAL_TYPE], { timeout: timeoutMs }, (error) => {
      resolve(error === null ? TMUX_TERMINAL_TYPE : FALLBACK_TERMINAL_TYPE);
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end();
  });
}
