import type { Mastra } from '@mastra/core'
import type { Pool } from 'pg'
import { createPool } from '../db/index.ts'
import { createMastra } from '../mastra/index.ts'
import type { Settings } from '../settings.ts'
import { Executor } from './executor.ts'

export const DB_CONNECT_TIMEOUT_MS = 2000

export class DatabaseUnreachable extends Error {
  override name = 'DatabaseUnreachable'
}

export interface Runtime {
  readonly pool: Pool
  readonly mastra: Mastra
  readonly executor: Executor
  close(): Promise<void>
}

export async function openRuntime(settings: Settings): Promise<Runtime> {
  // Mastra's storage gets its own pool, so its queries cannot take the connections run writes need.
  const pool = createPool(settings.databaseUrl, DB_CONNECT_TIMEOUT_MS)
  const mastraPool = createPool(settings.databaseUrl, DB_CONNECT_TIMEOUT_MS)
  let mastra: Mastra | undefined
  try {
    try {
      await pool.query('SELECT 1')
    } catch (error) {
      throw new DatabaseUnreachable('database unreachable', { cause: error })
    }
    mastra = createMastra(mastraPool)
    await mastra.getStorage()?.init()
    const executor = new Executor(mastra, pool)
    const opened = mastra
    return {
      pool,
      mastra: opened,
      executor,
      async close() {
        try {
          await executor.shutdown()
          await opened.shutdown()
        } finally {
          await mastraPool.end()
          await pool.end()
        }
      },
    }
  } catch (error) {
    try {
      await mastra?.shutdown()
    } finally {
      await mastraPool.end()
      await pool.end()
    }
    throw error
  }
}
