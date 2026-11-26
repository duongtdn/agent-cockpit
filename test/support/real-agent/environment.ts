import type { SessionEnvironment } from '../../../src/server/session-host/session-host.ts';

/** The folders one run of the real agent owns, all under a temporary root. */
export interface AgentFolders {
  /** The temporary folder that holds the others, removed when the run ends. */
  readonly root: string;
  /** The agent's `HOME`: it registers a URL handler there, whatever its configuration folder. */
  readonly home: string;
  /** The agent's `CLAUDE_CONFIG_DIR`: its configuration, its transcripts. */
  readonly configFolder: string;
  /** The folder sessions work in, trusted in the configuration. */
  readonly workFolder: string;
}

/**
 * The API key the agent is given. It opens nothing: the only API a run
 * reaches is the test's double, which reads no key.
 */
export const FAKE_API_KEY =
  'sk-ant-api03-fake-key-for-tests-only-0000000000000000000000000000-FAKEFAKEAA';

/** How many of a key's last characters the agent's configuration names an approved key by. */
const KEY_SUFFIX_LENGTH = 20;

/**
 * Gives the whole environment the real agent starts with: enough to reach
 * its input prompt with no login and no dialog, and to call nothing but the
 * API named. Nothing of the calling process is in it. The terminal's own
 * variables (`TERM`, `SHELL`) are the session host's to give.
 *
 * @param folders - The run's folders.
 * @param apiBaseUrl - Where the API's double listens.
 * @returns The variables, by name.
 */
export function agentEnvironment(
  folders: AgentFolders,
  apiBaseUrl: string,
): Record<string, string> {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: folders.home,
    CLAUDE_CONFIG_DIR: folders.configFolder,
    LANG: 'C.UTF-8',
    ANTHROPIC_BASE_URL: apiBaseUrl,
    ANTHROPIC_API_KEY: FAKE_API_KEY,
    // Without these two the agent calls Anthropic's hosts and GitHub, whatever its base URL.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
    // The suite tests the version it pinned.
    DISABLE_AUTOUPDATER: '1',
  };
}

/**
 * Gives the content of the agent's `.claude.json` with which it starts at
 * its input prompt: each key spares one dialog (the onboarding, the question
 * about the API key, the trust in the folder), and no dialog fires a hook.
 *
 * @param folders - The run's folders; the work folder must be given resolved,
 * as the agent looks its trust up by the resolved path.
 * @returns The configuration, to write as JSON.
 */
export function agentConfiguration(folders: AgentFolders): object {
  return {
    hasCompletedOnboarding: true,
    customApiKeyResponses: { approved: [FAKE_API_KEY.slice(-KEY_SUFFIX_LENGTH)] },
    projects: { [folders.workFolder]: { hasTrustDialogAccepted: true } },
  };
}

/**
 * Tells a session host to give a session the variables named and no other: a
 * host starts from the calling process's environment, so every variable of
 * it that is not named is removed — the `CLAUDE_CODE_*`, `CLAUDECODE` and
 * `ANTHROPIC_*` ones of a suite run from an agent's terminal among them.
 *
 * @param variables - The session's whole environment.
 * @param inherited - The calling process's environment.
 * @returns The changes that leave the session with `variables` alone.
 */
export function onlyTheseVariables(
  variables: Readonly<Record<string, string>>,
  inherited: Readonly<Record<string, string | undefined>>,
): SessionEnvironment {
  return {
    set: variables,
    remove: Object.keys(inherited).filter((name) => !Object.hasOwn(variables, name)),
  };
}
