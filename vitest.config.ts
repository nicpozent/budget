import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The suite runs against a real PostgreSQL, so a single worker keeps the
    // fixture deterministic rather than racing on a shared schema.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 60_000,
    hookTimeout: 180_000,
    setupFiles: [],
  },
});
