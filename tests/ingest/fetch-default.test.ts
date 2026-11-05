import { resolve, join } from 'node:path'
import { vi } from 'vitest'
import { main } from '../../src/cli.ts'
import { fetchActs } from '../../src/ingest/fetch.ts'
import { describe, expect, test } from '../support/harness.ts'

vi.mock('../../src/ingest/fetch.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/ingest/fetch.ts')>()),
  fetchActs: vi.fn(async () => {}),
}))

const ROOT = resolve(import.meta.dirname, '..', '..')

describe('mokosz fetch with the default commands', () => {
  test.for([
    [['fetch', '--force'], true],
    [['fetch'], false],
  ] as const)('%j passes force %s and data/raw of the git toplevel', async ([args, force]) => {
    vi.mocked(fetchActs).mockClear()

    const code = await main([...args])

    expect(code).toBe(0)
    expect(vi.mocked(fetchActs).mock.calls).toHaveLength(1)
    const [rawDir, options] = vi.mocked(fetchActs).mock.calls[0]!
    expect(resolve(rawDir)).toBe(join(ROOT, 'data', 'raw'))
    expect(options?.force).toBe(force)
    expect(typeof options?.report).toBe('function')
  })
})
