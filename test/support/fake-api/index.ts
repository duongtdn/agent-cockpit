/**
 * A scripted double of Anthropic's Messages API, for pointing the real agent
 * at (`ANTHROPIC_BASE_URL`) in tests. A test scripts the answers as plain
 * data, in order; the double logs what the agent sent.
 */
export * from './fake-api.ts';
export type {
  LoggedRequest,
  MessagesRequestBody,
  RequestKind,
  RequestMessage,
  SideRequestRule,
} from './requests.ts';
export { offersNoTools } from './requests.ts';
export * from './script.ts';
