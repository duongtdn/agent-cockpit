import { defineConfig } from 'vitest/config';

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
          testTimeout: 15_000,
        },
      },
      {
        // The contract suite drives the real agent: it runs only as its own
        // project, never along with another. Its waits fail by themselves,
        // saying what the agent showed, well before this timeout.
        test: {
          name: 'contract',
          include: ['test/contract/**/*.test.ts'],
          testTimeout: 60_000,
        },
      },
      { test: { name: 'pack', include: ['test/pack/**/*.test.ts'] } },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'html'],
      thresholds: { lines: 90, branches: 90 },
    },
  },
});
