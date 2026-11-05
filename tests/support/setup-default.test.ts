import { spawnSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { Client } from 'pg'
import { onTestFinished, vi } from 'vitest'
import { main } from '../../src/cli.ts'
import { MIGRATIONS_DIR } from '../../src/db/index.ts'
import { clearSettingsCache } from '../../src/settings.ts'
import { portOf } from './network.ts'
import { describe, expect, test } from './harness.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawnSync: vi.fn((command: string, args: string[], options: object) => {
      if (command === 'git' && args[0] === 'rev-parse') {
        return actual.spawnSync(command, args, options)
      }
      return { status: 0, stdout: '', stderr: '', error: undefined }
    }),
  }
})

const ROOT = resolve(import.meta.dirname, '..', '..')

describe('mokosz setup with the default commands', () => {
  test('pulls the profile models, migrates to head and seeds the settings database', async ({
    throwawayDatabaseUrl: url,
  }) => {
    vi.mocked(spawnSync).mockClear()
    const pulls: unknown[] = []
    const server = createServer((request, response) => {
      let text = ''
      request.on('data', (chunk: Buffer) => (text += chunk.toString()))
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        if (request.method === 'POST') pulls.push(JSON.parse(text))
        response.end('{"status":"success"}')
      })
    })
    await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening))
    onTestFinished(async () => {
      server.closeAllConnections()
      await new Promise<void>((closed) => server.close(() => closed()))
    })
    vi.stubEnv('DATABASE_URL', url)
    vi.stubEnv('OLLAMA_BASE_URL', `http://127.0.0.1:${portOf(server)}`)
    clearSettingsCache()
    let stdout = ''
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk)
      return true
    })

    let code: number
    try {
      code = await main(['setup', '--profile', 'local-gemma'])
    } finally {
      out.mockRestore()
      vi.unstubAllEnvs()
      clearSettingsCache()
    }

    expect(code).toBe(0)
    expect(pulls).toEqual([
      { model: 'gemma4:26b', stream: false },
      { model: 'bge-m3', stream: false },
    ])
    const commands = vi.mocked(spawnSync).mock.calls.map(([command, args]) => [command, ...args!])
    expect(commands.slice(1)).toEqual([
      ['docker', 'info'],
      ['docker', 'compose', 'up', '-d', '--wait', 'db'],
    ])
    for (const [, , options] of vi.mocked(spawnSync).mock.calls.slice(1)) {
      expect(resolve(String(Reflect.get(options ?? {}, 'cwd')))).toBe(ROOT)
    }
    const names = (await readdir(MIGRATIONS_DIR)).map((file) => file.replace(/\.sql$/, ''))
    const client = new Client({ connectionString: url })
    await client.connect()
    try {
      const migrated = await client.query<{ name: string }>(
        'SELECT name FROM pgmigrations ORDER BY id',
      )
      expect(migrated.rows.map((row) => row.name)).toEqual(names.toSorted())
      const chunks = await client.query<{ n: string }>('SELECT count(*) AS n FROM chunks')
      const count = Number(chunks.rows[0]!.n)
      expect(count).toBeGreaterThan(0)
      expect(stdout).toContain(`Seed: ${count} chunks\n`)
    } finally {
      await client.end()
    }
  })
})
