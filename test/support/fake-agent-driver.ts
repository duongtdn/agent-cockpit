import { existsSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Driver, DriverEvent, HookRequest } from '../../src/server/driver.ts';
import type { HookAccess } from '../../src/server/sessions/sessions.ts';
import { fakeAgentCommand } from './fake-agent/launching.ts';
import { transcriptPathFor } from './fake-agent/transcript.ts';

const REPORT_HOOK = fileURLToPath(new URL('./hooks/report-hook.mjs', import.meta.url));

/** The HTTP hooks the driver gives a session: those the cockpit reads. */
const HTTP_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd'];

/**
 * A driver of the fake agent, for the sessions core's integration tests: it
 * launches the fake agent with Claude Code's command line and reads the
 * hooks Claude Code's way. It stands in for the Claude Code driver, which is
 * tested on its own; this one keeps only what the sessions core needs.
 *
 * @param configFolder - The fake agent's configuration folder, where its
 * transcripts go.
 */
export function fakeAgentDriver(configFolder: string): Driver {
  return {
    terminalKeys: [],
    silentStartCause: 'The fake agent sent no SessionStart.',
    async launch(launch) {
      const settingsFile = join(launch.files, 'settings.json');
      writeFileSync(settingsFile, JSON.stringify(settingsFor(launch.hooks)), { mode: 0o600 });
      const agent = fakeAgentCommand();
      return {
        command: agent.command,
        args: [
          ...agent.args,
          '--session-id',
          launch.conversationId,
          '--settings',
          settingsFile,
          '--permission-mode',
          'default',
          ...(launch.prompt === undefined ? [] : ['--', launch.prompt]),
        ],
        environment: { ...launch.environment, CLAUDE_CONFIG_DIR: configFolder },
      };
    },
    readHook: ({ path, body }: HookRequest) => ({ events: eventsOf(path.slice(1), body) }),
    canResume: async ({ conversationId, directory }) =>
      existsSync(transcriptPathFor(configFolder, directory, conversationId)),
  };
}

function eventsOf(event: string, body: unknown): DriverEvent[] {
  const payload = body as Record<string, unknown>;
  switch (event) {
    case 'SessionStart':
      return [{ type: 'ready' }];
    case 'UserPromptSubmit':
      return [{ type: 'prompt-taken' }];
    case 'PreToolUse':
    case 'PostToolUse':
      return [{ type: 'working' }];
    case 'Stop':
      return [{ type: 'turn-ended', lastMessage: payload.last_assistant_message as string }];
    case 'SessionEnd':
      return [
        { type: 'ending', reason: payload.reason === 'prompt_input_exit' ? 'agent-exit' : 'lost' },
      ];
    default:
      return [];
  }
}

function settingsFor({ url, token }: { url: string; token: string }): object {
  const http = (event: string) => ({
    hooks: [
      { type: 'http', url: `${url}/${event}`, headers: { Authorization: `Bearer ${token}` } },
    ],
  });
  const reported = [process.execPath, REPORT_HOOK, `${url}/SessionStart`];
  return {
    hooks: {
      SessionStart: [
        { hooks: [{ type: 'command', command: reported.map((word) => `'${word}'`).join(' ') }] },
      ],
      ...Object.fromEntries(HTTP_EVENTS.map((event) => [event, [http(event)]])),
    },
  };
}

/** A stand-in for the agent-facing listener: it hands out tokens and passes hooks on. */
export interface HookForwarder extends HookAccess {
  /** Closes the server. */
  close(): Promise<void>;
}

/**
 * Starts a server on loopback that takes the hooks of each session at
 * `/<key>/<event>` and passes them to a receiver. The command hook of
 * `SessionStart` posts without a token, as the test's report hook does; an
 * HTTP hook without its session's token is refused.
 *
 * @param receive - Where the hooks go; set once the sessions core exists.
 */
export async function startHookForwarder(
  receive: (request: HookRequest) => void,
): Promise<HookForwarder> {
  const tokens = new Map<string, string>();
  let minted = 0;
  const server: Server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request.setEncoding('utf8')) body += chunk;
    const [key = '', event = ''] = (request.url ?? '').split('/').slice(1);
    const authorized =
      event === 'SessionStart' || request.headers.authorization === `Bearer ${tokens.get(key)}`;
    if (authorized && tokens.has(key)) receive({ key, path: `/${event}`, body: JSON.parse(body) });
    response.writeHead(authorized ? 200 : 401).end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    grant(key) {
      minted += 1;
      const token = `token-${minted}`;
      tokens.set(key, token);
      return { url: `${base}/${key}`, token };
    },
    revoke: (key) => void tokens.delete(key),
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
