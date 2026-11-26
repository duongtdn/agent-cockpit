/**
 * The entry `@duongtdn/agent-cockpit`: the server library and its handler,
 * for the app's Node server.
 *
 * @packageDocumentation
 */

export type { CockpitErrorCode, CockpitErrorFields, Issue } from '../shared/cockpit-error.js';
export { CockpitError, isCockpitError } from '../shared/cockpit-error.js';
export type { Pending, SessionState, StartupDialog } from '../shared/session.js';
