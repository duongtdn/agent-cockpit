import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Reporter, TestModule } from 'vitest/node';
import { pinnedAgentVersion } from '../support/real-agent/binary.ts';
import { sandboxStatus } from '../support/real-agent/sandbox.ts';
import { contractResults } from './results.ts';

/** Where a run's results go: a folder git ignores, which CI keeps as an artifact. */
const RESULTS_FILE = fileURLToPath(new URL('../../test-results/contract.json', import.meta.url));

/**
 * A vitest reporter that writes what a run of the contract suite found: the
 * agent's version, read once from the pinned binary, and each behavior's
 * number, title and outcome, the Enters the agent lost, whether the
 * agent's sandbox could run, and what a sandboxed command reached in each
 * mode measured. A reporter, because it sees every test of every
 * file once the run has ended, in the one process that outlives them: a
 * failed, timed-out or crashed test is recorded like any other, and no two
 * files write the results at the same time.
 */
export default class ContractResultsReporter implements Reporter {
  onTestRunEnd(modules: readonly TestModule[]): void {
    const tests = modules.flatMap((module) =>
      Array.from(module.children.allTests(), (test) => {
        const { lostEnters, networkReach } = test.meta();
        return {
          name: test.name,
          state: test.result().state,
          lostEnters: lostEnters ?? [],
          ...(networkReach === undefined ? {} : { networkReach }),
        };
      }),
    );
    const results = contractResults(pinnedAgentVersion(), new Date(), tests, sandboxStatus());
    mkdirSync(dirname(RESULTS_FILE), { recursive: true });
    writeFileSync(RESULTS_FILE, `${JSON.stringify(results, null, 2)}\n`);
  }
}
