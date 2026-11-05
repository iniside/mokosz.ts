import { BlockList, isIP } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { createMiddleware } from 'hono/factory'
import { Client } from 'pg'
import { DB_CONNECT_TIMEOUT_MS, openRuntime } from '../runs/runtime.ts'
import { failInterruptedRuns } from '../runs/conversations.ts'
import { getSettings, type Settings } from '../settings.ts'
import { citationRoutes } from './citations.ts'
import { conversationRoutes } from './conversations.ts'
import { HEALTH_CHECKS, healthRoutes, type HealthChecks } from './health.ts'
import { PING_INTERVAL_MS, runRoutes } from './runs.ts'
import type { AppState, Fetch } from './state.ts'

const RECONNECT_MS = 1000

export interface AppOptions {
  settings?: Settings
  fetch?: Fetch
  pingIntervalMs?: number
  healthChecks?: Partial<HealthChecks>
  host?: string
}

export interface App {
  hono: Hono
  state: AppState
  close(): Promise<void>
}

const MAX_BODY_BYTES = 64 * 1024
const LOOPBACK = new BlockList()
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4')
LOOPBACK.addAddress('::1', 'ipv6')
const ALLOWED_HOST_NAMES = ['localhost', '127.0.0.1', '[::1]']
const HOST_HEADER = /^(\[[^\]]*\]|[^:]*)(?::\d*)?$/

function hostName(header: string | undefined): string | null {
  const match = header === undefined ? null : HOST_HEADER.exec(header)
  return match === null ? null : match[1]!.toLowerCase()
}

function isLoopback(bound: string): boolean {
  if (bound === 'localhost') return true
  const version = isIP(bound)
  return version !== 0 && LOOPBACK.check(bound, version === 4 ? 'ipv4' : 'ipv6')
}

function hostCheck(boundHost: string | undefined) {
  const bound = boundHost?.toLowerCase().replace(/^\[(.*)\]$/, '$1')
  if (bound === undefined || !isLoopback(bound)) return createMiddleware((_, next) => next())
  const allowed = new Set([...ALLOWED_HOST_NAMES, isIP(bound) === 6 ? `[${bound}]` : bound])
  return createMiddleware(async (c, next) => {
    const name = hostName(c.req.header('host'))
    if (name === null || !allowed.has(name)) return c.json({ detail: 'Host not allowed' }, 403)
    return await next()
  })
}

export class DatabaseTimeout extends Error {
  override name = 'DatabaseTimeout'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function waitForDatabase(databaseUrl: string): Promise<void> {
  const deadline = performance.now() + DB_CONNECT_TIMEOUT_MS
  let last: unknown = null
  for (;;) {
    const remaining = Math.ceil(deadline - performance.now())
    if (remaining <= 0) break
    const client = new Client({
      connectionString: databaseUrl,
      connectionTimeoutMillis: remaining,
    })
    try {
      await client.connect()
      await client.end()
      return
    } catch (error) {
      last = error
      console.warn(`database not reachable yet: ${messageOf(error)}`)
    }
    await sleep(Math.max(0, Math.min(RECONNECT_MS, deadline - performance.now())))
  }
  throw new DatabaseTimeout(`database not reachable within ${DB_CONNECT_TIMEOUT_MS / 1000} s`, {
    cause: last,
  })
}

export async function startApp(options: AppOptions = {}): Promise<App> {
  const settings = options.settings ?? getSettings()
  await waitForDatabase(settings.databaseUrl)
  const runtime = await openRuntime(settings)
  try {
    const interrupted = await failInterruptedRuns(runtime.pool)
    if (interrupted.length > 0) {
      console.warn(`marked ${interrupted.length} interrupted runs as failed`)
    }
    const state: AppState = {
      settings,
      pool: runtime.pool,
      fetch: options.fetch ?? fetch,
      mastra: runtime.mastra,
      executor: runtime.executor,
    }
    const hono = new Hono()
    hono.use(hostCheck(options.host))
    hono.use(
      '/api/*',
      bodyLimit({
        maxSize: MAX_BODY_BYTES,
        onError: (c) => c.json({ detail: 'Request body too large' }, 413),
      }),
    )
    hono.route('/api', healthRoutes(state, { ...HEALTH_CHECKS, ...options.healthChecks }))
    hono.route('/api', conversationRoutes(state))
    hono.route('/api', runRoutes(state, options.pingIntervalMs ?? PING_INTERVAL_MS))
    hono.route('/api', citationRoutes(state))
    hono.notFound((c) => c.json({ detail: 'Not Found' }, 404))
    return { hono, state, close: () => runtime.close() }
  } catch (error) {
    try {
      await runtime.close()
    } catch (closeError) {
      console.error('closing the runtime after a failed startup failed', closeError)
    }
    throw error
  }
}
