import { defineConfig } from 'vitest/config';

/** Timing benchmarks run alone, one file at a time. */
export default defineConfig({
  test: {
    include: ['apps/server/test/**/*.perf.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
