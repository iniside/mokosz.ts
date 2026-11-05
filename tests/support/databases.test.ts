import { Pool } from 'pg'
import {
  MAX_AGE_MS,
  createDatabase,
  databaseName,
  databaseOf,
  dropDatabase,
  endWithin,
  isStale,
  listDatabases,
  stamp,
  sweepStale,
  type Kind,
} from './databases.ts'
import { describe, expect, test } from './harness.ts'

const NOW = new Date(Date.UTC(2026, 10, 3, 12, 0, 0))
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const KINDS: Kind[] = ['test', 'throwaway']

const at = (ms: number): Date => new Date(ms)
const named = (kind: string, when: Date): string => `mokosz_${kind}_${stamp(when)}_0123abcd`

describe('database names', () => {
  test.each(KINDS)('new %s names carry their creation time', (kind) => {
    const name = databaseName(kind, NOW)

    expect(name.startsWith(`mokosz_${kind}_20261103120000_`)).toBe(true)
    expect(isStale(name, at(NOW.getTime() + MAX_AGE_MS))).toBe(false)
    expect(isStale(name, at(NOW.getTime() + MAX_AGE_MS + SECOND))).toBe(true)
  })

  test('two names at the same second differ', () => {
    expect(databaseName('test', NOW)).not.toBe(databaseName('test', NOW))
  })

  test.each(KINDS)('old %s names are stale', (kind) => {
    expect(isStale(named(kind, at(NOW.getTime() - HOUR - SECOND)), NOW)).toBe(true)
    expect(isStale(named(kind, at(NOW.getTime() - 30 * DAY)), NOW)).toBe(true)
  })

  const ages = [0, 59 * MINUTE, MAX_AGE_MS, -5 * HOUR]
  test.each(KINDS.flatMap((kind) => ages.map((age) => [kind, age] as const)))(
    'fresh %s names are kept (age %d ms)',
    (kind, age) => {
      expect(isStale(named(kind, at(NOW.getTime() - age)), NOW)).toBe(false)
    },
  )

  test.each([
    'mokosz',
    'postgres',
    'template0',
    'template1',
    'mokosz_test',
    'mokosz_testing',
    'mokosz_test_rev6',
    'mokosz_throwaway_0123456789ab',
    'mokosz_testing_20200101000000_0123abcd',
    'mokosz_other_20200101000000_0123abcd',
    'mokosz_test_20200101000000_0123abcd_x',
    'x_mokosz_test_20200101000000_0123abcd',
    'mokosz_test_2020010100000_0123abcd',
    'mokosz_test_20201399000000_0123abcd',
    'mokosz_test_20200101000000_0123ABCD',
  ])('%s is outside the pattern and never stale', (name) => {
    expect(isStale(name, at(NOW.getTime() + 365 * 100 * DAY))).toBe(false)
  })
})

describe('per-run databases', () => {
  test('the session database is a fresh per-run database', ({ serverUrl, testSettings }) => {
    const name = databaseOf(testSettings.databaseUrl)

    expect(name).not.toBe(databaseOf(serverUrl))
    expect(name.startsWith('mokosz_test_')).toBe(true)
    expect(isStale(name, new Date())).toBe(false)
    expect(isStale(name, at(Date.now() + MAX_AGE_MS + MINUTE))).toBe(true)
  })

  test('sweep drops stale databases and keeps fresh ones', async ({ serverUrl }) => {
    const now = new Date()
    const stale = databaseName('throwaway', at(now.getTime() - 2 * HOUR))
    const fresh = databaseName('throwaway', now)
    await createDatabase(serverUrl, stale)
    await createDatabase(serverUrl, fresh)
    try {
      const before = new Set(await listDatabases(serverUrl))
      expect(before.has(stale) && before.has(fresh)).toBe(true)

      const dropped = await sweepStale(serverUrl, now)

      const remaining = new Set(await listDatabases(serverUrl))
      expect(dropped).not.toContain(fresh)
      expect(remaining.has(stale)).toBe(false)
      expect(remaining.has(fresh)).toBe(true)
      expect(remaining.has(databaseOf(serverUrl))).toBe(true)
    } finally {
      await dropDatabase(serverUrl, stale)
      await dropDatabase(serverUrl, fresh)
    }
  })
})

describe('endWithin', () => {
  test('a pool with a client checked out fails within the bound instead of hanging', async ({
    testSettings,
  }) => {
    const pool = new Pool({ connectionString: testSettings.databaseUrl })
    const leaked = await pool.connect()
    const started = performance.now()

    await expect(endWithin(pool, 300)).rejects.toThrow(
      'pool did not end within 300 ms: a client is checked out',
    )

    expect(performance.now() - started).toBeLessThan(2000)
    leaked.release()
    await expect.poll(() => pool.ended).toBe(true)
    expect(pool.totalCount).toBe(0)
  })
})
