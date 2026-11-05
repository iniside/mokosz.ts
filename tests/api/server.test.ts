import { connect } from 'node:net'
import { once } from 'node:events'
import { startApp } from '../../src/api/app.ts'
import { listen } from '../../src/api/server.ts'
import type { Settings } from '../../src/settings.ts'
import { describe, expect, test } from '../support/harness.ts'

describe('server shutdown', () => {
  test('a request still in flight is cut after the graceful timeout', async ({
    testSettings: _,
    unreachableOllama: __,
  }) => {
    const listening = await listen(await startApp(), '127.0.0.1', 0)
    const { port } = new URL(listening.url)
    const socket = connect(Number(port), '127.0.0.1')
    await once(socket, 'connect')
    socket.write('GET /api/health HTTP/1.1\r\nHost: test\r\n')
    const ended = once(socket, 'close')
    await new Promise((done) => setTimeout(done, 100))

    const started = performance.now()
    await listening.close(300)
    const elapsed = performance.now() - started
    await ended

    expect(elapsed).toBeGreaterThanOrEqual(250)
    expect(elapsed).toBeLessThan(3000)
    expect(listening.app.state.pool.ended).toBe(true)
  })
})

const FOREIGN = 'evil.example'
const DEV_PROXY = 'localhost:5173'

async function respond(
  settings: Settings,
  boundHost: string | undefined,
  headers: Record<string, string>,
  path = '/api/health',
  init: RequestInit = {},
): Promise<Response> {
  const app = await startApp({ settings, ...(boundHost === undefined ? {} : { host: boundHost }) })
  try {
    return await app.hono.request('http://test' + path, { ...init, headers })
  } finally {
    await app.close()
  }
}

describe('Host check', () => {
  const cases: [string, number][] = [
    [DEV_PROXY, 200],
    ['localhost', 200],
    ['LOCALHOST:8000', 200],
    ['127.0.0.1:8000', 200],
    ['[::1]:8000', 200],
    ['[::1]', 200],
    [FOREIGN, 403],
    ['evil.example:8000', 403],
    ['localhost.evil.example', 403],
    ['127.0.0.1.evil.example:8000', 403],
    ['evil@localhost', 403],
    ['localhost@evil.example', 403],
    ['[::2]:8000', 403],
    ['192.168.1.5:8000', 403],
    ['localhost:80x', 403],
    ['', 403],
  ]
  for (const [header, expected] of cases) {
    test(
      'bound to 127.0.0.1, Host ' + JSON.stringify(header) + ' gives ' + expected,
      async ({ testSettings, unreachableOllama: _ }) => {
        const response = await respond(testSettings, '127.0.0.1', { host: header })
        expect(response.status).toBe(expected)
        if (expected === 403) {
          expect(response.headers.get('content-type')).toContain('application/json')
          expect(await response.json()).toEqual({ detail: 'Host not allowed' })
        }
      },
    )
  }

  test('a missing Host header is refused when bound to loopback', async ({
    testSettings,
    unreachableOllama: _,
  }) => {
    const response = await respond(testSettings, '127.0.0.1', {})
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ detail: 'Host not allowed' })
  })

  for (const bound of ['localhost', '::1']) {
    test(
      'bound to ' + bound + ' the check is on',
      async ({ testSettings, unreachableOllama: _ }) => {
        expect((await respond(testSettings, bound, { host: FOREIGN })).status).toBe(403)
        expect((await respond(testSettings, bound, { host: DEV_PROXY })).status).toBe(200)
      },
    )
  }

  for (const bound of ['LOCALHOST', '127.0.0.2', '0:0:0:0:0:0:0:1', '[::1]']) {
    test(
      'bound to ' + bound + ' the check is on',
      async ({ testSettings, unreachableOllama: _ }) => {
        expect((await respond(testSettings, bound, { host: FOREIGN })).status).toBe(403)
        expect((await respond(testSettings, bound, {})).status).toBe(403)
        expect((await respond(testSettings, bound, { host: DEV_PROXY })).status).toBe(200)
      },
    )
  }

  test('bound to 127.0.0.2 its own literal is accepted, another loopback address is not', async ({
    testSettings,
    unreachableOllama: _,
  }) => {
    expect((await respond(testSettings, '127.0.0.2', { host: '127.0.0.2:8000' })).status).toBe(200)
    expect((await respond(testSettings, '127.0.0.2', { host: '127.0.0.3:8000' })).status).toBe(403)
    expect((await respond(testSettings, '127.0.0.2', { host: FOREIGN })).status).toBe(403)
  })

  test('bound to a long-form IPv6 loopback its bracketed literal is accepted', async ({
    testSettings,
    unreachableOllama: _,
  }) => {
    const bound = '0:0:0:0:0:0:0:1'
    expect((await respond(testSettings, bound, { host: '[0:0:0:0:0:0:0:1]:8000' })).status).toBe(
      200,
    )
  })

  for (const bound of ['0.0.0.0', '192.168.1.5']) {
    test(
      'bound to ' + bound + ' the check is off',
      async ({ testSettings, unreachableOllama: _ }) => {
        expect((await respond(testSettings, bound, { host: '192.168.1.5:8000' })).status).toBe(200)
        expect((await respond(testSettings, bound, { host: FOREIGN })).status).toBe(200)
        expect((await respond(testSettings, bound, {})).status).toBe(200)
      },
    )
  }

  test('the check is off when no host is given', async ({ testSettings, unreachableOllama: _ }) => {
    expect((await respond(testSettings, undefined, { host: FOREIGN })).status).toBe(200)
  })

  test('a foreign Host is refused on every path, a loopback one reaches the 404', async ({
    testSettings,
    unreachableOllama: _,
  }) => {
    const refused = await respond(testSettings, '127.0.0.1', { host: FOREIGN }, '/nope')
    expect(refused.status).toBe(403)
    const missing = await respond(testSettings, '127.0.0.1', { host: 'localhost' }, '/nope')
    expect(missing.status).toBe(404)
  })
})

function post(settings: Settings, size: number): Promise<Response> {
  return respond(
    settings,
    '127.0.0.1',
    { host: DEV_PROXY, 'content-type': 'application/json' },
    '/api/conversations',
    { method: 'POST', body: JSON.stringify({ filler: 'x'.repeat(size) }) },
  )
}

describe('body limit', () => {
  const LIMIT = 64 * 1024
  const OVERHEAD = JSON.stringify({ filler: '' }).length

  test('a 70 KB body is refused with 413 and a JSON detail', async ({
    testSettings,
    unreachableOllama: _,
  }) => {
    const response = await post(testSettings, 70 * 1024)
    expect(response.status).toBe(413)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({ detail: 'Request body too large' })
  })

  test('one byte over the limit is refused, the limit itself is not', async ({
    testSettings,
    unreachableOllama: _,
  }) => {
    expect((await post(testSettings, LIMIT - OVERHEAD + 1)).status).toBe(413)
    expect((await post(testSettings, LIMIT - OVERHEAD)).status).not.toBe(413)
  })

  test('an oversized body over a real socket is refused', async ({
    testSettings,
    unreachableOllama: _,
  }) => {
    const app = await startApp({ settings: testSettings, host: '127.0.0.1' })
    const listening = await listen(app, '127.0.0.1', 0)
    try {
      const response = await fetch(listening.url + '/api/conversations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filler: 'x'.repeat(70 * 1024) }),
      })
      expect(response.status).toBe(413)
      expect(await response.json()).toEqual({ detail: 'Request body too large' })
    } finally {
      await listening.close(1000)
    }
  })
})
