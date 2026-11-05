import type { MastraMemory } from '@mastra/core/memory'
import { Client, Pool, type PoolClient, type QueryResult } from 'pg'
import { createMastra } from '../../src/mastra/index.ts'
import type { Database } from '../../src/runs/transaction.ts'
import { expect } from '../support/harness.ts'

export interface Mastra {
  memory: MastraMemory
  close(): Promise<void>
}

export async function openMastra(url: string): Promise<Mastra> {
  const pool = new Pool({ connectionString: url })
  const mastra = createMastra(pool)
  await mastra.getStorage()!.init()
  return {
    memory: mastra.getMemory('mokosz'),
    async close() {
      await mastra.shutdown()
      await pool.end()
    },
  }
}

export async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url })
  await client.connect()
  return client
}

// Nothing is checked out, and the pool's connection is not left inside a transaction.
export async function expectIdle(pool: Pool, observer: Client): Promise<void> {
  expect(pool.totalCount - pool.idleCount).toBe(0)
  const {
    rows: [own],
  } = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
  const { rows } = await observer.query<{ state: string }>(
    'SELECT state FROM pg_stat_activity WHERE pid = $1',
    [own!.pid],
  )
  expect(rows).toEqual([{ state: 'idle' }])
}

export type Hook = (
  sql: string,
  execute: (params?: unknown[]) => Promise<QueryResult>,
  params: unknown[] | undefined,
) => Promise<QueryResult>

export function intercepted(pool: Pool, hook: Hook, connects = { count: 0 }): Database {
  return {
    async connect(): Promise<PoolClient> {
      connects.count += 1
      const client = await pool.connect()
      return new Proxy(client, {
        get(target, property) {
          if (property === 'query') {
            return (sql: string, params?: unknown[]) =>
              hook(sql, (replaced = params) => target.query(sql, replaced), params)
          }
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
  }
}
