/**
 * The entry `@duongtdn/agent-cockpit/client`: the framework-free client, for
 * the app's browser code. It imports no server module.
 *
 * @packageDocumentation
 */

export type { CockpitErrorCode, CockpitErrorFields, Issue } from '../shared/cockpit-error.js';
export { CockpitError, isCockpitError } from '../shared/cockpit-error.js';
export type {
  BackgroundTask,
  EndReason,
  Pending,
  RunResult,
  Session,
  SessionState,
  StartupDialog,
  TurnError,
} from '../shared/session.js';
export { cockpitHeaders } from './cockpit-headers.js';
export type { CockpitClient, CockpitClientOptions } from './create-cockpit-client.js';
export { createCockpitClient } from './create-cockpit-client.js';
