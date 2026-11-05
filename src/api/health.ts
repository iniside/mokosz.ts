import { Hono } from 'hono'
import { DatabaseError, type Pool } from 'pg'
import type { AppState, Fetch } from './state.ts'

export interface HealthChecks {
  timeoutMs: number
  dbSql: string
}

export const HEALTH_CHECKS: HealthChecks = { timeoutMs: 2000, dbSql: 'SELECT 1' }

type Status = 'ok' | 'unreachable'

export interface Health {
  status: 'ok' | 'degraded'
  db: Status
  ollama: Status
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')
  )
}

// pg rejects with DatabaseError for server errors, and with a Node system error or a plain Error
// for connection failures; anything else is a bug and propagates.
function isDatabaseError(error: unknown): boolean {
  return (
    error instanceof DatabaseError ||
    error instanceof AggregateError ||
    (error instanceof Error && typeof Reflect.get(error, 'syscall') === 'string') ||
    (error instanceof Error && Object.getPrototypeOf(error) === Error.prototype)
  )
}

// fetch rejects with a TypeError for network and URL failures.
function isHttpError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    (error.message === 'fetch failed' || error.message.startsWith('Failed to parse URL'))
  )
}

async function within<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const signal = AbortSignal.timeout(ms)
  const timedOut = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  return await Promise.race([run(signal), timedOut])
}

async function query(pool: Pool, sql: string, signal: AbortSignal): Promise<void> {
  const client = await pool.connect()
  let released = false
  const release = (error?: Error): void => {
    if (!released) {
      released = true
      client.release(error)
    }
  }
  if (signal.aborted) {
    release()
    return
  }
  // A timed-out query leaves its connection busy, so the connection is discarded, not reused.
  const discard = (): void => release(new Error('health check timed out'))
  signal.addEventListener('abort', discard, { once: true })
  try {
    await client.query(sql)
  } finally {
    signal.removeEventListener('abort', discard)
    release()
  }
}

async function dbOk(pool: Pool, checks: HealthChecks): Promise<boolean> {
  try {
    await within(checks.timeoutMs, (signal) => query(pool, checks.dbSql, signal))
  } catch (error) {
    if (!isDatabaseError(error) && !isTimeout(error)) throw error
    console.warn(`health: database check failed: ${errorName(error)}`)
    return false
  }
  return true
}

async function ollamaOk(fetchFn: Fetch, baseUrl: string, checks: HealthChecks): Promise<boolean> {
  let status: number
  try {
    status = await within(checks.timeoutMs, async (signal) => {
      const response = await fetchFn(`${baseUrl.replace(/\/+$/, '')}/api/version`, { signal })
      await response.arrayBuffer()
      return response.status
    })
  } catch (error) {
    if (!isHttpError(error) && !isTimeout(error)) throw error
    console.warn(`health: Ollama check failed: ${errorName(error)}`)
    return false
  }
  return status === 200
}

export function healthRoutes(state: AppState, checks: HealthChecks): Hono {
  const routes = new Hono()
  routes.get('/health', async (c) => {
    const [db, ollama] = await Promise.all([
      dbOk(state.pool, checks),
      ollamaOk(state.fetch, state.settings.ollamaBaseUrl, checks),
    ])
    const body: Health = {
      status: db && ollama ? 'ok' : 'degraded',
      db: db ? 'ok' : 'unreachable',
      ollama: ollama ? 'ok' : 'unreachable',
    }
    return c.json(body, db ? 200 : 503)
  })
  return routes
}
