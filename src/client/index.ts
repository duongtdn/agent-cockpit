/**
 * The entry `@duongtdn/agent-cockpit/client`: the framework-free client, for
 * the app's browser code. It imports no server module.
 *
 * @packageDocumentation
 */

export type { CockpitErrorCode, CockpitErrorFields, Issue } from '../shared/cockpit-error.js';
export { CockpitError, isCockpitError } from '../shared/cockpit-error.js';
export type { Pending, SessionState, StartupDialog } from '../shared/session.js';
