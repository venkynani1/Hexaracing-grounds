import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/server/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.perf.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
