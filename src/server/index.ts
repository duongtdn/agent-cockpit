/**
 * The entry `@duongtdn/agent-cockpit`: the server library and its handler,
 * for the app's Node server.
 *
 * @packageDocumentation
 */

export type { CockpitErrorCode, CockpitErrorFields, Issue } from '../shared/cockpit-error.js';
export { CockpitError, isCockpitError } from '../shared/cockpit-error.js';
export type {
  EndReason,
  Pending,
  RunResult,
  Session,
  SessionState,
  StartupDialog,
} from '../shared/session.js';
export type { CockpitOptions } from './cockpit-options.js';
export type { Cockpit } from './create-cockpit.js';
export { createCockpit } from './create-cockpit.js';
export type { Job } from './jobs.js';
