import { resolve } from 'node:path'
import { vi } from 'vitest'
import { main } from '../../src/cli.ts'
import { seedChunks } from '../../src/ingest/seed.ts'
import { describe, expect, test } from '../support/harness.ts'

vi.mock('../../src/ingest/seed.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/ingest/seed.ts')>()),
  seedChunks: vi.fn(async () => 42),
}))

const ROOT = resolve(import.meta.dirname, '..', '..')

describe('mokosz seed with the default commands', () => {
  test('seeds the settings database from the git toplevel', async ({ testSettings }) => {
    vi.mocked(seedChunks).mockClear()
    let stdout = ''
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk)
      return true
    })
    let code: number
    let database = ''
    vi.mocked(seedChunks).mockImplementationOnce(async (client) => {
      const { rows } = await client.query<{ current_database: string }>('SELECT current_database()')
      database = rows[0]!.current_database
      return 42
    })
    try {
      code = await main(['seed'])
    } finally {
      write.mockRestore()
    }

    expect(code).toBe(0)
    expect(stdout).toBe('Seed: 42 chunks\n')
    expect(vi.mocked(seedChunks).mock.calls).toHaveLength(1)
    expect(resolve(vi.mocked(seedChunks).mock.calls[0]![1])).toBe(ROOT)
    expect(database).toBe(new URL(testSettings.databaseUrl).pathname.slice(1))
  })
})
