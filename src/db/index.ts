import { join } from 'node:path'
import { runner, type RunnerOption } from 'node-pg-migrate'
import { Pool } from 'pg'

export const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations')
export const MIGRATIONS_TABLE = 'pgmigrations'

const quiet = { debug: () => {}, info: () => {}, warn: console.warn, error: console.error }

export function migrationOptions(
  databaseUrl: string,
  direction: 'up' | 'down',
  count = Infinity,
): RunnerOption {
  return {
    databaseUrl,
    dir: MIGRATIONS_DIR,
    migrationsTable: MIGRATIONS_TABLE,
    direction,
    count,
    logger: quiet,
  }
}

export async function upgradeHead(databaseUrl: string): Promise<void> {
  await runner(migrationOptions(databaseUrl, 'up'))
}

export function createPool(databaseUrl: string, connectTimeoutMs: number): Pool {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: connectTimeoutMs,
  })
  // An idle client dropped by the server emits here; without a listener the process exits.
  pool.on('error', (error) => console.warn(`database pool: idle client error: ${error.message}`))
  return pool
}
