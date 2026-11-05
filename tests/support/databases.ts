import { randomUUID } from 'node:crypto'
import { Client, type Pool } from 'pg'

export type Kind = 'test' | 'throwaway'

const NAME = /^mokosz_(?:test|throwaway)_(\d{14})_[0-9a-f]{8}$/
export const MAX_AGE_MS = 60 * 60 * 1000

export function stamp(at: Date): string {
  return at.toISOString().slice(0, 19).replace(/[-T:]/g, '')
}

export function databaseName(kind: Kind, now: Date): string {
  return `mokosz_${kind}_${stamp(now)}_${randomUUID().replaceAll('-', '').slice(0, 8)}`
}

export function createdAt(name: string): Date | null {
  const match = NAME.exec(name)
  if (match === null) return null
  const digits = match[1]!
  const field = (start: number, length: number): number =>
    Number(digits.slice(start, start + length))
  const at = new Date(
    Date.UTC(field(0, 4), field(4, 2) - 1, field(6, 2), field(8, 2), field(10, 2), field(12, 2)),
  )
  // strptime rejects out-of-range fields; Date.UTC would roll them over.
  return stamp(at) === digits ? at : null
}

export function isStale(name: string, now: Date): boolean {
  const created = createdAt(name)
  return created !== null && now.getTime() - created.getTime() > MAX_AGE_MS
}

export function withDatabase(url: string, name: string): string {
  const parsed = new URL(url)
  parsed.pathname = `/${name}`
  return parsed.toString()
}

export function databaseOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice(1))
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

async function admin<T>(serverUrl: string, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    connectionString: withDatabase(serverUrl, 'postgres'),
    connectionTimeoutMillis: 5000,
  })
  await client.connect()
  try {
    return await run(client)
  } finally {
    await client.end()
  }
}

export async function createDatabase(serverUrl: string, name: string): Promise<string> {
  await admin(serverUrl, (client) => client.query(`CREATE DATABASE ${quote(name)}`))
  return withDatabase(serverUrl, name)
}

export async function dropDatabase(serverUrl: string, name: string): Promise<void> {
  await admin(serverUrl, (client) =>
    client.query(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`),
  )
}

export async function listDatabases(serverUrl: string): Promise<string[]> {
  const result = await admin(serverUrl, (client) =>
    client.query<{ datname: string }>('SELECT datname FROM pg_database WHERE NOT datistemplate'),
  )
  return result.rows.map((row) => row.datname)
}

export async function sweepStale(serverUrl: string, now: Date): Promise<string[]> {
  const stale = (await listDatabases(serverUrl)).filter((name) => isStale(name, now)).toSorted()
  for (const name of stale) await dropDatabase(serverUrl, name)
  return stale
}

// Ends a pool, or fails the test when a client is still checked out instead of hanging.
export async function endWithin(pool: Pool, ms = 5000): Promise<void> {
  const timer = Promise.withResolvers<never>()
  const handle = setTimeout(
    () => timer.reject(new Error(`pool did not end within ${ms} ms: a client is checked out`)),
    ms,
  )
  try {
    await Promise.race([pool.end(), timer.promise])
  } finally {
    clearTimeout(handle)
  }
}
