import { Mastra } from '@mastra/core'
import { PostgresStore } from '@mastra/pg'
import { Pool } from 'pg'
import { vi } from 'vitest'
import { Executor } from '../../src/runs/executor.ts'
import { DatabaseUnreachable, openRuntime } from '../../src/runs/runtime.ts'
import { describe, expect, test } from '../support/harness.ts'
import { closedPort } from '../support/network.ts'

function spies() {
  const shutdown = vi.spyOn(Executor.prototype, 'shutdown')
  const mastraShutdown = vi.spyOn(Mastra.prototype, 'shutdown')
  const end = vi.spyOn(Pool.prototype, 'end')
  return {
    shutdown,
    mastraShutdown,
    end,
    restore() {
      for (const spy of [shutdown, mastraShutdown, end]) spy.mockRestore()
    },
  }
}

describe('runtime', () => {
  test('close shuts the executor, then Mastra, then ends both pools', async ({ testSettings }) => {
    const runtime = await openRuntime(testSettings)
    const storage = runtime.mastra.getStorage()
    if (!(storage instanceof PostgresStore))
      throw new Error('Mastra storage is not a PostgresStore')
    expect(storage.pool).not.toBe(runtime.pool)
    expect([runtime.pool.ended, storage.pool.ended]).toEqual([false, false])
    const spied = spies()
    try {
      await runtime.close()

      expect([runtime.pool.ended, storage.pool.ended]).toEqual([true, true])
      expect(spied.shutdown).toHaveBeenCalledOnce()
      expect(spied.mastraShutdown).toHaveBeenCalledOnce()
      expect(new Set(spied.end.mock.contexts)).toEqual(new Set([runtime.pool, storage.pool]))
      const [executorOrder] = spied.shutdown.mock.invocationCallOrder
      const [mastraOrder] = spied.mastraShutdown.mock.invocationCallOrder
      expect(executorOrder!).toBeLessThan(mastraOrder!)
      expect(Math.min(...spied.end.mock.invocationCallOrder)).toBeGreaterThan(mastraOrder!)
    } finally {
      spied.restore()
    }
  })

  test('close ends both pools when the Mastra shutdown rejects', async ({ testSettings }) => {
    const runtime = await openRuntime(testSettings)
    const storage = runtime.mastra.getStorage()
    if (!(storage instanceof PostgresStore))
      throw new Error('Mastra storage is not a PostgresStore')
    const spied = spies()
    spied.mastraShutdown.mockRejectedValueOnce(new Error('mastra shutdown failed'))
    try {
      await expect(runtime.close()).rejects.toThrow('mastra shutdown failed')

      expect([runtime.pool.ended, storage.pool.ended]).toEqual([true, true])
    } finally {
      spied.restore()
    }
  })

  test('an unreachable database fails the open and ends both pools', async ({ testSettings }) => {
    const port = await closedPort()
    const spied = spies()
    try {
      const opening = openRuntime({
        ...testSettings,
        databaseUrl: `postgresql://mokosz:mokosz@127.0.0.1:${port}/mokosz`,
      })

      await expect(opening).rejects.toThrow(DatabaseUnreachable)
      await expect(opening).rejects.toMatchObject({ cause: { code: 'ECONNREFUSED' } })
      const pools = new Set(spied.end.mock.contexts)
      expect(pools.size).toBe(2)
      expect([...pools].every((pool) => pool instanceof Pool && pool.ended)).toBe(true)
    } finally {
      spied.restore()
    }
  })
})
