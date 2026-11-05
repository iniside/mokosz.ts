import { once } from 'node:events'
import { connect as connectSocket, createServer, type Socket } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { PostgresStore } from '@mastra/pg'
import { Mastra } from '@mastra/core'
import { Pool } from 'pg'
import { vi } from 'vitest'
import { DatabaseTimeout, startApp, type App } from '../../src/api/app.ts'
import type { HealthChecks } from '../../src/api/health.ts'
import type { Fetch } from '../../src/api/state.ts'
import { createPool, upgradeHead } from '../../src/db/index.ts'
import { DB_CONNECT_TIMEOUT_MS } from '../../src/runs/runtime.ts'
import { loadSettings, type Settings } from '../../src/settings.ts'
import { describe, expect, test } from '../support/harness.ts'
import { closedPort } from '../support/network.ts'

const OLLAMA = 'http://ollama.test'
const CLOSED_DB = 'postgresql://mokosz:mokosz@127.0.0.1:1/mokosz'

type Handler = (url: string, init?: RequestInit) => Promise<Response>

const ollamaUp: Handler = async (url) => {
  expect(url).toBe(`${OLLAMA}/api/version`)
  return Response.json({ version: '0.12.0' })
}
const ollamaRefused: Handler = async () => {
  throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') })
}
const ollamaErrorStatus: Handler = async () => new Response(null, { status: 500 })
const ollamaNotFound: Handler = async () => new Response(null, { status: 404 })
const ollamaDelayed: Handler = async () => {
  await sleep(800)
  return new Response(null, { status: 200 })
}
const ollamaSlow: Handler = async () => {
  await sleep(5000)
  return new Response(null, { status: 200 })
}

function fetchOf(handler: Handler): Fetch {
  return (input, init) => handler(input instanceof Request ? input.url : String(input), init)
}

const dbUp = (settings: Settings): Settings => ({ ...settings, ollamaBaseUrl: OLLAMA })

async function withApi<T>(
  settings: Settings,
  handler: Handler,
  run: (get: (path: string, init?: RequestInit) => Promise<Response>, app: App) => Promise<T>,
  {
    dbReachable = true,
    checks = {},
  }: { dbReachable?: boolean; checks?: Partial<HealthChecks> } = {},
): Promise<T> {
  const app = await startApp({ settings, fetch: fetchOf(handler), healthChecks: checks })
  const get = (path: string, init?: RequestInit): Promise<Response> =>
    Promise.resolve(app.hono.request(`http://test${path}`, init))
  try {
    if (dbReachable) return await run(get, app)
    // Startup needs the database; it goes away afterwards, as when Postgres stops.
    const closed = createPool(CLOSED_DB, DB_CONNECT_TIMEOUT_MS)
    const started = app.state.pool
    app.state.pool = closed
    try {
      return await run(get, app)
    } finally {
      app.state.pool = started
      await closed.end()
    }
  } finally {
    await app.close()
  }
}

async function timed<T>(run: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now()
  const result = await run()
  return [result, (performance.now() - started) / 1000]
}

describe('/api/health', () => {
  test('db and ollama up is ok', async ({ testSettings }) => {
    const response = await withApi(dbUp(testSettings), ollamaUp, (get) => get('/api/health'))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok', db: 'ok', ollama: 'ok' })
  })

  test.for([
    ['refused', ollamaRefused],
    ['error status', ollamaErrorStatus],
    ['not found', ollamaNotFound],
  ] as const)('ollama %s is degraded 200', async ([, handler], { testSettings }) => {
    const response = await withApi(dbUp(testSettings), handler, (get) => get('/api/health'))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'degraded', db: 'ok', ollama: 'unreachable' })
  })

  test('ollama timeout is degraded 200', async ({ testSettings }) => {
    const response = await withApi(dbUp(testSettings), ollamaSlow, (get) => get('/api/health'), {
      checks: { timeoutMs: 300 },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'degraded', db: 'ok', ollama: 'unreachable' })
  })

  test('db down, ollama up is 503', async ({ testSettings }) => {
    const [response, elapsed] = await withApi(
      dbUp(testSettings),
      ollamaUp,
      (get) => timed(() => get('/api/health')),
      { dbReachable: false, checks: { timeoutMs: 500 } },
    )

    expect(elapsed).toBeLessThan(4)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ status: 'degraded', db: 'unreachable', ollama: 'ok' })
  })

  test('db and ollama down is 503', async ({ testSettings }) => {
    const response = await withApi(dbUp(testSettings), ollamaRefused, (get) => get('/api/health'), {
      dbReachable: false,
      checks: { timeoutMs: 500 },
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      status: 'degraded',
      db: 'unreachable',
      ollama: 'unreachable',
    })
  })

  test('db query hang is 503', async ({ testSettings }) => {
    const [[response, elapsed], pool] = await withApi(
      dbUp(testSettings),
      ollamaUp,
      async (get, app) =>
        [
          await timed(() => get('/api/health')),
          { total: app.state.pool.totalCount, idle: app.state.pool.idleCount },
        ] as const,
      { checks: { timeoutMs: 500, dbSql: 'SELECT pg_sleep(5)' } },
    )

    expect(elapsed).toBeLessThan(2)
    expect(pool).toEqual({ total: 0, idle: 0 })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ status: 'degraded', db: 'unreachable', ollama: 'ok' })
  })

  test('checks run concurrently', async ({ testSettings }) => {
    const [response, elapsed] = await withApi(
      dbUp(testSettings),
      ollamaDelayed,
      (get) => timed(() => get('/api/health')),
      { checks: { timeoutMs: 1000, dbSql: 'SELECT pg_sleep(0.8)' } },
    )

    expect(await response.json()).toEqual({ status: 'ok', db: 'ok', ollama: 'ok' })
    expect(elapsed).toBeLessThan(1.4)
  })
})

describe('lifespan', () => {
  test('shutdown closes both pools', async ({ testSettings }) => {
    const app: App = await startApp({ settings: dbUp(testSettings) })
    const { pool } = app.state
    const storage = app.state.mastra.getStorage()
    if (!(storage instanceof PostgresStore))
      throw new Error('Mastra storage is not a PostgresStore')
    expect([pool.ended, storage.pool.ended]).toEqual([false, false])

    await app.close()

    expect([pool.ended, storage.pool.ended]).toEqual([true, true])
  })

  test('startup creates the Mastra tables in the mastra schema', async ({
    throwawayDatabaseUrl,
  }) => {
    const settings = loadSettings({
      env: { DATABASE_URL: throwawayDatabaseUrl, OLLAMA_BASE_URL: OLLAMA },
      envFile: null,
    })
    const count = async (): Promise<number> => {
      const pool = new Pool({ connectionString: throwawayDatabaseUrl })
      try {
        const { rows } = await pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'mastra'",
        )
        return rows[0]!.n
      } finally {
        await pool.end()
      }
    }
    // Startup fails the interrupted runs, so the app tables must exist.
    await upgradeHead(throwawayDatabaseUrl)
    expect(await count()).toBe(0)

    const app = await startApp({ settings })
    try {
      expect(await count()).toBeGreaterThan(0)
    } finally {
      await app.close()
    }
  })

  test('the injected fetch is the one the checks use', async ({ testSettings }) => {
    const calls: string[] = []
    const response = await withApi(
      dbUp(testSettings),
      async (url) => {
        calls.push(url)
        return new Response(null, { status: 200 })
      },
      (get) => get('/api/health'),
    )

    expect(response.status).toBe(200)
    expect(calls).toEqual([`${OLLAMA}/api/version`])
  })

  test('trailing slashes of the Ollama url are stripped', async ({ testSettings }) => {
    const calls: string[] = []
    await withApi(
      { ...testSettings, ollamaBaseUrl: `${OLLAMA}///` },
      async (url) => {
        calls.push(url)
        return new Response(null, { status: 200 })
      },
      (get) => get('/api/health'),
    )

    expect(calls).toEqual([`${OLLAMA}/api/version`])
  })

  test('startup fails with DatabaseTimeout when the database refuses', async () => {
    const [error, elapsed] = await timed(() => startupError(CLOSED_DB))

    expect(error).toBeInstanceOf(DatabaseTimeout)
    expect(error).toMatchObject({ message: 'database not reachable within 2 s' })
    expect(elapsed).toBeGreaterThanOrEqual(DB_CONNECT_TIMEOUT_MS / 1000 - 0.1)
    expect(elapsed).toBeLessThan(DB_CONNECT_TIMEOUT_MS / 1000 + 3)
  })

  test('startup waits for a database that starts accepting within the timeout', async ({
    testSettings,
  }) => {
    const target = new URL(testSettings.databaseUrl)
    const port = await closedPort()
    const sockets: Socket[] = []
    const proxy = createServer((socket) => {
      const upstream = connectSocket(Number(target.port || 5432), target.hostname)
      sockets.push(socket, upstream)
      socket.pipe(upstream).pipe(socket)
      socket.on('error', () => upstream.destroy())
      upstream.on('error', () => socket.destroy())
    })
    const late = setTimeout(() => proxy.listen(port, '127.0.0.1'), 500)
    const url = new URL(testSettings.databaseUrl)
    url.hostname = '127.0.0.1'
    url.port = String(port)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const [app, elapsed] = await timed(() =>
        startApp({ settings: { ...dbUp(testSettings), databaseUrl: url.toString() } }),
      )
      await app.close()

      expect(warn).toHaveBeenCalled()
      expect(elapsed).toBeGreaterThanOrEqual(0.5)
      expect(elapsed).toBeLessThan(DB_CONNECT_TIMEOUT_MS / 1000 + 3)
    } finally {
      clearTimeout(late)
      warn.mockRestore()
      for (const socket of sockets) socket.destroy()
      proxy.close()
    }
  })

  test('a failed startup shuts Mastra down, then ends the pools it opened', async ({
    testSettings,
  }) => {
    const init = vi
      .spyOn(PostgresStore.prototype, 'init')
      .mockRejectedValueOnce(new Error('init failed'))
    const shutdown = vi.spyOn(Mastra.prototype, 'shutdown')
    const end = vi.spyOn(Pool.prototype, 'end')
    try {
      await expect(startApp({ settings: dbUp(testSettings) })).rejects.toThrow('init failed')

      expect(shutdown).toHaveBeenCalledTimes(1)
      expect(end).toHaveBeenCalledTimes(2)
      const [shutdownOrder] = shutdown.mock.invocationCallOrder
      expect(end.mock.invocationCallOrder.every((order) => order > shutdownOrder!)).toBe(true)
    } finally {
      init.mockRestore()
      shutdown.mockRestore()
      end.mockRestore()
    }
  })

  test('a startup that fails after Mastra is up shuts it down', async ({ testSettings }) => {
    const connect = vi.spyOn(Pool.prototype, 'connect')
    const init = vi.spyOn(PostgresStore.prototype, 'init').mockImplementationOnce(async () => {
      connect.mockRejectedValueOnce(new Error('marking interrupted runs failed'))
    })
    const shutdown = vi.spyOn(Mastra.prototype, 'shutdown')
    try {
      await expect(startApp({ settings: dbUp(testSettings) })).rejects.toThrow(
        'marking interrupted runs failed',
      )

      expect(init).toHaveBeenCalledTimes(1)
      expect(shutdown).toHaveBeenCalledTimes(1)
    } finally {
      init.mockRestore()
      connect.mockRestore()
      shutdown.mockRestore()
    }
  })

  test('a failed startup whose Mastra shutdown also fails reports the startup error', async ({
    testSettings,
  }) => {
    const connect = vi.spyOn(Pool.prototype, 'connect')
    const init = vi.spyOn(PostgresStore.prototype, 'init').mockImplementationOnce(async () => {
      connect.mockRejectedValueOnce(new Error('marking interrupted runs failed'))
    })
    const closeError = new Error('mastra shutdown failed')
    const shutdown = vi.spyOn(Mastra.prototype, 'shutdown').mockRejectedValueOnce(closeError)
    const end = vi.spyOn(Pool.prototype, 'end')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(startApp({ settings: dbUp(testSettings) })).rejects.toThrow(
        'marking interrupted runs failed',
      )

      expect(shutdown).toHaveBeenCalledTimes(1)
      const pools = new Set(end.mock.contexts)
      expect(pools.size).toBe(2)
      expect([...pools].every((pool) => pool instanceof Pool && pool.ended)).toBe(true)
      expect(logged).toHaveBeenCalledWith(
        'closing the runtime after a failed startup failed',
        closeError,
      )
    } finally {
      init.mockRestore()
      connect.mockRestore()
      shutdown.mockRestore()
      end.mockRestore()
      logged.mockRestore()
    }
  })

  test('startup fails with DatabaseTimeout when the server never answers', async () => {
    const sockets: Socket[] = []
    const silent = createServer((socket) => sockets.push(socket))
    silent.listen(0, '127.0.0.1')
    await once(silent, 'listening')
    const address = silent.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    try {
      const [error, elapsed] = await timed(() =>
        startupError(`postgresql://mokosz:mokosz@127.0.0.1:${port}/mokosz`),
      )

      expect(error).toBeInstanceOf(DatabaseTimeout)
      expect(sockets.length).toBeGreaterThan(0)
      expect(elapsed).toBeGreaterThanOrEqual(DB_CONNECT_TIMEOUT_MS / 1000 - 0.1)
      expect(elapsed).toBeLessThan(DB_CONNECT_TIMEOUT_MS / 1000 + 1)
    } finally {
      for (const socket of sockets) socket.destroy()
      silent.close()
    }
  })
})

async function startupError(databaseUrl: string): Promise<unknown> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    await startApp({
      settings: loadSettings({
        env: { DATABASE_URL: databaseUrl, OLLAMA_BASE_URL: OLLAMA },
        envFile: null,
      }),
    })
  } catch (error) {
    return error
  } finally {
    warn.mockRestore()
  }
  throw new Error('startup did not fail')
}

describe('errors', () => {
  test('a non-HTTP error in the Ollama check is a 500', async ({ testSettings }) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const response = await withApi(
        dbUp(testSettings),
        async () => {
          throw new RangeError('bug')
        },
        (get) => get('/api/health'),
      )

      expect(response.status).toBe(500)
      expect(await response.text()).toBe('Internal Server Error')
    } finally {
      logged.mockRestore()
    }
  })

  test('a non-database error in the database check is a 500', async ({ testSettings }) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const response = await withApi(dbUp(testSettings), ollamaUp, async (get, app) => {
        const started = app.state.pool
        const broken = new Pool()
        broken.connect = () => Promise.reject(new RangeError('bug'))
        app.state.pool = broken
        try {
          return await get('/api/health')
        } finally {
          app.state.pool = started
          await broken.end()
        }
      })

      expect(response.status).toBe(500)
    } finally {
      logged.mockRestore()
    }
  })
})
