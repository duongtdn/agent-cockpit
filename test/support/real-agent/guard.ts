import { isIP } from 'node:net';
import { isAbsolute, relative, resolve } from 'node:path';

/** The variables that name where the agent keeps and reads the person's own files. */
const PERSONAL_FOLDERS = ['HOME', 'CLAUDE_CONFIG_DIR'] as const;

/**
 * Refuses an environment in which the agent could reach Anthropic or the
 * person's own configuration. The runner calls it before every launch: no
 * mistake in a test may cost a real request or touch a real login.
 *
 * @param environment - Every variable the agent would start with.
 * @param root - The temporary folder the run owns.
 * @throws Error naming the variable when `ANTHROPIC_BASE_URL` is not an
 * address of the loopback interface, or when `HOME` or `CLAUDE_CONFIG_DIR`
 * is not a folder inside the root.
 */
export function assertStaysLocal(
  environment: Readonly<Record<string, string>>,
  root: string,
): void {
  const baseUrl = environment.ANTHROPIC_BASE_URL;
  if (baseUrl === undefined || !isLoopbackUrl(baseUrl)) {
    throw new Error(
      `The real agent is not started: ANTHROPIC_BASE_URL is ${describe(baseUrl)}, not an address of the loopback interface.`,
    );
  }
  for (const name of PERSONAL_FOLDERS) {
    const folder = environment[name];
    if (folder === undefined || !isInside(folder, root)) {
      throw new Error(
        `The real agent is not started: ${name} is ${describe(folder)}, not a folder inside ${root}.`,
      );
    }
  }
}

function describe(value: string | undefined): string {
  return value === undefined ? 'not set' : JSON.stringify(value);
}

/**
 * Tells whether a URL names the loopback interface by address. A name is
 * refused, `localhost` too: what it resolves to is the machine's to say.
 */
function isLoopbackUrl(text: string): boolean {
  if (!URL.canParse(text)) return false;
  const { protocol, hostname } = new URL(text);
  if (protocol !== 'http:') return false;
  return hostname === '[::1]' || (isIP(hostname) === 4 && hostname.startsWith('127.'));
}

function isInside(folder: string, root: string): boolean {
  if (!isAbsolute(folder)) return false;
  const fromRoot = relative(resolve(root), resolve(folder));
  return fromRoot !== '' && !fromRoot.startsWith('..') && !isAbsolute(fromRoot);
}
