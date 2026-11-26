/**
 * The entry `@duongtdn/agent-cockpit/terminal`: the mounted terminal, for the
 * app's browser code. It imports no server module.
 *
 * @packageDocumentation
 */

export type { CockpitErrorCode, CockpitErrorFields, Issue } from '../shared/cockpit-error.js';
export { CockpitError, isCockpitError } from '../shared/cockpit-error.js';
export type { MountedTerminal, MountTerminalOptions } from './mount-terminal.js';
export { mountTerminal } from './mount-terminal.js';
export type { TerminalStatus } from './terminal-link.js';
