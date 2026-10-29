import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: process.env.E2E ? ['tests/e2e/**/*.test.ts'] : ['tests/*.test.ts'],
    testTimeout: process.env.E2E ? 120_000 : 20_000,
  },
});
