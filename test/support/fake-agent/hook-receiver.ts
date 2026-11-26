import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

/** A hook a session sent, as a test's receiver got it. */
export interface ReceivedHook {
  /** The event's name. */
  readonly event: string;
  /** How it came: posted by the agent, or reported by a command hook. */
  readonly via: 'http' | 'command';
  /** The headers of the request. */
  readonly headers: IncomingHttpHeaders;
  /** The hook's payload. */
  readonly payload: Record<string, unknown>;
  /** Fulfilled when the sender closes the connection before any answer. */
  readonly closedBySender: Promise<void>;
  /** Tells whether the connection is still open, an answer still possible. */
  isOpen(): boolean;
  /** Answers a held hook. */
  answer(output: unknown): void;
}

/** An HTTP server that receives a session's hooks, for a test to read and answer. */
export interface HookReceiver {
  /** Every hook received so far, in the order of arrival. */
  readonly received: readonly ReceivedHook[];
  /** Gives the names of the events received so far, in the order of arrival. */
  events(): string[];
  /**
   * Gives settings that send a session's hooks here: HTTP hooks for every
   * event the fake agent plays, `SessionStart` included, with an
   * `Authorization` header; command hooks for `SessionStart` and `SessionEnd`.
   */
  settings(): object;
  /** Holds, from now on, the hooks of an event until the test answers them; the others get `{}` at once. */
  hold(event: string): void;
  /**
   * Waits for the next hook of an event that no earlier call was given.
   *
   * @returns The hook; a held one still waits for its answer.
   */
  next(event: string): Promise<ReceivedHook>;
  /** Closes the server and every connection it holds. */
  close(): Promise<void>;
}

/** The header the receiver's settings give every HTTP hook. */
export const RECEIVER_AUTHORIZATION = 'Bearer fake-agent-test-token';

const HTTP_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Stop',
  'SessionEnd',
];
const COMMAND_EVENTS = ['SessionStart', 'SessionEnd'];

const REPORT_HOOK = fileURLToPath(new URL('./report-hook.mjs', import.meta.url));

/**
 * Starts a hook receiver on a free port of the loopback interface.
 *
 * @returns The receiver, listening.
 */
export async function startHookReceiver(): Promise<HookReceiver> {
  const received: ReceivedHook[] = [];
  const held = new Set<string>();
  const untaken = new Map<string, ReceivedHook[]>();
  const waiting = new Map<string, ((hook: ReceivedHook) => void)[]>();

  function deliver(hook: ReceivedHook): void {
    received.push(hook);
    const waiter = waiting.get(hook.event)?.shift();
    if (waiter) waiter(hook);
    else untaken.set(hook.event, [...(untaken.get(hook.event) ?? []), hook]);
    if (!held.has(hook.event)) hook.answer({});
  }

  const server = createServer((request, response) => {
    void readHook(request, response).then(deliver);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    received,
    events: () => received.map((hook) => hook.event),
    settings: () => settingsFor(address),
    hold: (event) => void held.add(event),
    next(event) {
      const arrived = untaken.get(event)?.shift();
      if (arrived) return Promise.resolve(arrived);
      return new Promise((resolve) => {
        waiting.set(event, [...(waiting.get(event) ?? []), resolve]);
      });
    },
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** Reads a request of `/<via>/<event>` as the hook it carries. */
async function readHook(request: IncomingMessage, response: ServerResponse): Promise<ReceivedHook> {
  const [via, event] = (request.url ?? '').split('/').slice(1) as ['http' | 'command', string];
  let body = '';
  for await (const chunk of request.setEncoding('utf8')) body += chunk;
  const closedBySender = new Promise<void>((resolve) => {
    response.on('close', () => {
      if (!response.writableEnded) resolve();
    });
  });
  return {
    event,
    via,
    headers: request.headers,
    payload: JSON.parse(body) as Record<string, unknown>,
    closedBySender,
    isOpen: () => !response.writableEnded && !response.destroyed,
    answer: (output) =>
      void response.setHeader('content-type', 'application/json').end(JSON.stringify(output)),
  };
}

function settingsFor(address: string): object {
  const groups = new Map<string, object[]>();
  const add = (event: string, hook: object) =>
    groups.set(event, [...(groups.get(event) ?? []), { matcher: '*', hooks: [hook] }]);
  for (const event of HTTP_EVENTS) {
    add(event, {
      type: 'http',
      url: `${address}/http/${event}`,
      headers: { Authorization: RECEIVER_AUTHORIZATION },
      timeout: 300,
    });
  }
  for (const event of COMMAND_EVENTS) {
    add(event, { type: 'command', command: reportCommand(`${address}/command/${event}`) });
  }
  return { hooks: Object.fromEntries(groups) };
}

/** The command line of a hook that reports to an address, each word quoted for the shell. */
function reportCommand(url: string): string {
  return [process.execPath, REPORT_HOOK, url].map((word) => `'${word}'`).join(' ');
}
