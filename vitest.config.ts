import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'hooks', include: ['tests/hooks/**/*.test.ts'] } },
      {
        test: {
          name: 'app',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/hooks/**'],
          globalSetup: ['tests/support/global-setup.ts'],
          setupFiles: ['tests/support/network-guard.ts'],
          // The files share the per-run database.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
})
