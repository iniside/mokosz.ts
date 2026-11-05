import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'tests/ingest/chunker.test.ts',
      'tests/invoices/validator.test.ts',
      'tests/invoices/taxid.test.ts',
      'tests/citations.test.ts',
      'tests/settings.test.ts',
      'tests/decimal.test.ts',
    ],
    setupFiles: ['tests/support/network-guard.ts'],
    testTimeout: 30_000,
  },
})
