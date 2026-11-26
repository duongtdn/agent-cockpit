/** The package's name, which its own code could import an entry by. */
export const PACKAGE_NAME = '@duongtdn/agent-cockpit';

/** The source folder behind each entry of the package, by its key in the manifest's `exports`. */
export const ENTRY_FOLDERS: Readonly<Record<string, string>> = {
  '.': 'server',
  './fastify': 'fastify',
  './claude-code': 'claude-code',
  './channel': 'channel',
  './client': 'client',
  './terminal': 'terminal',
};
