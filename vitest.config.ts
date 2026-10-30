import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    // All test files share one database, so they run one at a time.
    fileParallelism: false,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54331/carecloud_test',
      VAPI_WEBHOOK_SECRET: 'test-secret',
    },
    testTimeout: 15000,
    hookTimeout: 60000,
  },
});
