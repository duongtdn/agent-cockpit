import { defineConfig } from 'vitest/config';
import { PATIENCE } from './test/support/patience.ts';

/**
 * The contract suite's workers, the same on every machine: each runs the real
 * agent, and the load they make together, not the machine's core count, must
 * decide what a test meets. CI's runner gives vitest three by default.
 */
const CONTRACT_WORKERS = 3;

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['test/unit/**/*.test.ts'] } },
      {
        // Longer than the wait for what a real terminal shows, so that a
        // failed wait reports what it saw.
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/support/tmux-sockets-global.ts'],
          setupFiles: ['test/support/tmux-sockets-setup.ts', 'test/support/timeline-setup.ts'],
          testTimeout: PATIENCE.integrationTest,
          // A test's teardown waits for its processes to exit, under bounds of the same table.
          hookTimeout: PATIENCE.integrationTest,
        },
      },
      {
        // The contract suite drives the real agent: it runs only as its own
        // project, never along with another. Its waits fail by themselves,
        // saying what the agent showed, well before this timeout.
        test: {
          name: 'contract',
          include: ['test/contract/**/*.test.ts'],
          globalSetup: ['test/support/tmux-sockets-global.ts'],
          setupFiles: ['test/support/tmux-sockets-setup.ts', 'test/support/timeline-setup.ts'],
          testTimeout: PATIENCE.contractTest,
          // A test's teardown waits for its processes to exit, under bounds of the same table.
          hookTimeout: PATIENCE.contractTest,
          maxWorkers: CONTRACT_WORKERS,
        },
      },
      { test: { name: 'pack', include: ['test/pack/**/*.test.ts'] } },
      {
        // A real Chromium (Playwright's): what only a browser shows of the
        // terminal, its keys, its fit and its copy.
        test: {
          name: 'browser',
          include: ['test/browser/**/*.test.ts'],
          globalSetup: ['test/support/tmux-sockets-global.ts'],
          setupFiles: ['test/support/tmux-sockets-setup.ts', 'test/support/timeline-setup.ts'],
          testTimeout: PATIENCE.browserTest,
          // A test's teardown waits for its processes to exit, under bounds of the same table.
          hookTimeout: PATIENCE.browserTest,
        },
      },
      {
        // A browser through an example app, as a person uses it: the example
        // runs as its own process on the built package (after `pnpm build`).
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.test.ts'],
          testTimeout: PATIENCE.endToEndTest,
          hookTimeout: PATIENCE.endToEndTest,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'html'],
      thresholds: { lines: 90, branches: 90 },
    },
  },
});
