import type { TestedRange } from '../server/agent-status.js';

/**
 * The versions of Claude Code the driver's contract tests ran on: the
 * pinned one, until a release reads its range from the contract results.
 */
export const TESTED_RANGE: TestedRange = { oldest: '2.1.332', newest: '2.1.332' };
