import { createServer } from 'node:http'
import { once } from 'node:events'
import { clearSettingsCache, getSettings } from '../../src/settings.ts'
import { useUnreachableOllama } from './network.ts'
import { describe, expect, test } from './harness.ts'

describe('network fixtures', () => {
  test('socket peers record connected ports, minus listeners opened in the test', async ({
    socketPeers,
    unreachableOllama: _,
  }) => {
    const server = createServer((_request, response) => response.end('ok'))
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    const own = typeof address === 'object' && address !== null ? address.port : 0
    try {
      expect(await (await fetch(`http://127.0.0.1:${own}/`)).text()).toBe('ok')
      const ollama = Number(new URL(getSettings().ollamaBaseUrl).port)
      await expect(fetch(`http://127.0.0.1:${ollama}/api/version`)).rejects.toThrow()

      expect(socketPeers.connected.map((peer) => peer.port)).toEqual([own, ollama])
      expect(socketPeers.ports()).toEqual(new Set([ollama]))
    } finally {
      server.close()
      server.closeAllConnections()
    }
  })

  test('unreachable ollama points the settings at a closed port and drops the api key', async () => {
    const before = { ollama: process.env.OLLAMA_BASE_URL, key: process.env.ANTHROPIC_API_KEY }
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    process.env.OLLAMA_BASE_URL = 'http://ollama.example:11434'
    clearSettingsCache()
    try {
      expect(getSettings().anthropicApiKey?.reveal()).toBe('sk-test')
      const restore = await useUnreachableOllama()
      const settings = getSettings()

      expect(settings.ollamaBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      expect(settings.anthropicApiKey).toBeNull()
      await expect(fetch(`${settings.ollamaBaseUrl}/api/version`)).rejects.toThrow('fetch failed')

      restore()

      expect(getSettings().anthropicApiKey?.reveal()).toBe('sk-test')
      expect(getSettings().ollamaBaseUrl).toBe('http://ollama.example:11434')
    } finally {
      for (const [name, value] of [
        ['OLLAMA_BASE_URL', before.ollama],
        ['ANTHROPIC_API_KEY', before.key],
      ] as const) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      clearSettingsCache()
    }
  })
})
