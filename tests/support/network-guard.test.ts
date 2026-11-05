import { createServer } from 'node:http'
import { connect } from 'node:net'
import { portOf } from './network.ts'
import { describe, expect, test } from './harness.ts'

describe('the network guard', () => {
  test('a socket to another host is refused', () => {
    expect(() => connect(80, 'publications.europa.eu')).toThrow(
      'network access in tests: publications.europa.eu',
    )
    expect(() => connect({ host: 'example.com', port: 80 })).toThrow('network access in tests')
  })

  test('fetch to another host fails with the guard error', async () => {
    const error = await fetch('http://publications.europa.eu/').catch((e: unknown) => e)

    if (!(error instanceof TypeError)) throw new Error('fetch did not fail')
    expect(String(error.cause)).toContain('network access in tests')
  })

  test('loopback stays reachable', async () => {
    const server = createServer((_, response) => response.end('ok'))
    await new Promise<void>((done) => server.listen(0, '127.0.0.2', done))
    try {
      const port = portOf(server)

      expect(await (await fetch(`http://127.0.0.2:${port}/`)).text()).toBe('ok')
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })
})
