import type { MastraMemory } from '@mastra/core/memory'
import type { PoolClient, QueryResultRow } from 'pg'

export interface Database {
  connect(): Promise<PoolClient>
}

export interface Options {
  signal?: AbortSignal
}

export type Query = <R extends QueryResultRow>(sql: string, params?: unknown[]) => Promise<R[]>

export const isoUtc = (column: string): string =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

export async function abortable<T>(
  start: () => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  signal?.throwIfAborted()
  const pending = start()
  if (signal === undefined) return pending
  pending.catch(() => {})
  const aborted = Promise.withResolvers<never>()
  const onAbort = (): void => aborted.reject(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([pending, aborted.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

export async function transaction<T>(
  db: Database,
  signal: AbortSignal | undefined,
  work: (query: Query) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted()
  const connecting = db.connect()
  let client: PoolClient
  try {
    client = await abortable(() => connecting, signal)
  } catch (error) {
    connecting.then(
      (late) => late.release(),
      () => {},
    )
    throw error
  }
  const query: Query = async (sql, params) =>
    (await abortable(() => client.query(sql, params), signal)).rows
  try {
    await query('BEGIN')
    const result = await work(query)
    await query('COMMIT')
    client.release()
    return result
  } catch (error) {
    // An abandoned statement leaves the connection busy; closing it rolls the transaction back.
    if (signal?.aborted) {
      client.release(true)
      throw error
    }
    try {
      await client.query('ROLLBACK')
      client.release()
    } catch (rollback) {
      client.release(rollback instanceof Error ? rollback : true)
    }
    throw error
  }
}

export async function conversationExists(
  memory: MastraMemory,
  conversationId: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const thread = await abortable(() => memory.getThreadById({ threadId: conversationId }), signal)
  return thread !== null
}
