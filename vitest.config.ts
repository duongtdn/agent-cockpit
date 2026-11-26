import { defineConfig } from 'vitest/config';

// The contract suite drives the real agent, so it runs only when asked for.
const contractTests = process.env.COCKPIT_CONTRACT === '1' ? ['test/contract/**/*.test.ts'] : [];

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['test/unit/**/*.test.ts'] } },
      { test: { name: 'integration', include: ['test/integration/**/*.test.ts'] } },
      { test: { name: 'contract', include: contractTests } },
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
