import { readFile, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { Client } from 'pg'
import { onTestFinished, vi } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { main } from '../src/cli.ts'
import { type CommandResult } from '../src/command.ts'
import { MIGRATIONS_DIR } from '../src/db/index.ts'
import { SeedError } from '../src/ingest/seed.ts'
import { PullError, pullModel } from '../src/llm/pull.ts'
import { loadSettings } from '../src/settings.ts'
import { setup, type SetupDeps } from '../src/setup.ts'
import { withDatabase } from './support/databases.ts'
import { closedPort, portOf } from './support/network.ts'
import { capturing, type Captured } from './support/capture.ts'
import { describe, expect, test } from './support/harness.ts'

const ROOT = resolve(import.meta.dirname, '..')

const DOCKER_INFO = ['docker', 'info']
const COMPOSE_UP = ['docker', 'compose', 'up', '-d', '--wait', 'db']
const GIT_HOOKS = ['git', 'config', 'core.hooksPath', '.githooks']
const SEED = ['seed']

type Call = [string[], string | undefined]

class FakeRunner {
  readonly calls: Call[] = []
  private readonly failing: Record<string, number>
  private readonly stderr: Record<string, string>

  constructor(failing: Record<string, number> = {}, stderr: Record<string, string> = {}) {
    this.failing = failing
    this.stderr = stderr
  }

  readonly run = (args: string[], cwd?: string): CommandResult => {
    this.calls.push([args, cwd])
    const key = args.join(' ')
    return { status: this.failing[key] ?? 0, stdout: '', stderr: this.stderr[key] ?? '' }
  }

  get commands(): string[][] {
    return this.calls.map(([args]) => args)
  }
}

interface FakeOllama {
  url: string
  hits: string[]
  pulls: unknown[]
  pullErrors: Record<string, [number, string]>
  dropPulls: boolean
  pullDelayMs: number
  bodyDelayMs: number
  flushedBeforeBody: string[]
}

async function startOllama(status = 200): Promise<FakeOllama> {
  const fake: FakeOllama = {
    url: '',
    hits: [],
    pulls: [],
    pullErrors: {},
    dropPulls: false,
    pullDelayMs: 0,
    bodyDelayMs: 0,
    flushedBeforeBody: [],
  }
  const server = createServer((request, response) => {
    const send = (code: number, body: string): void => {
      const redirect = code >= 300 && code < 400 ? { location: '/api/elsewhere' } : {}
      response.writeHead(code, { 'content-type': 'application/json', ...redirect })
      response.end(body)
    }
    let text = ''
    request.on('data', (chunk: Buffer) => (text += chunk.toString()))
    request.on('end', () => {
      fake.hits.push(request.url ?? '')
      if (request.method === 'GET') {
        send(request.url === '/api/version' ? status : 404, '{"version":"test"}')
        return
      }
      if (request.url !== '/api/pull') {
        send(404, '{"error":"not found"}')
        return
      }
      const body: { model: string } = JSON.parse(text)
      fake.pulls.push(body)
      if (fake.dropPulls) {
        request.socket.destroy()
        return
      }
      const [code, answer] = fake.pullErrors[body.model] ?? [200, '{"status":"success"}']
      if (fake.bodyDelayMs > 0) {
        response.writeHead(code, { 'content-type': 'application/json' })
        response.flushHeaders()
        fake.flushedBeforeBody.push(body.model)
        setTimeout(() => response.end(answer), fake.bodyDelayMs)
        return
      }
      setTimeout(() => send(code, answer), fake.pullDelayMs)
    })
  })
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening))
  fake.url = `http://127.0.0.1:${portOf(server)}`
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((closed) => server.close(() => closed()))
  })
  return fake
}

describe('pulling a model', () => {
  test('success resolves', async () => {
    const ollama = await startOllama()

    await expect(pullModel(ollama.url, 'bge-m3')).resolves.toBeUndefined()
    expect(ollama.pulls).toEqual([{ model: 'bge-m3', stream: false }])
  })

  test.for([
    [
      500,
      '{"error":"pull model manifest: file does not exist"}',
      'pull model manifest: file does not exist',
    ],
    [200, '{"error":"x"}', 'x'],
    [500, '{}', 'HTTP 500'],
    [200, '{"error":""}', 'empty error'],
    [404, '{"error":{"code":1}}', '{"code":1}'],
    [301, '{"status":"success"}', 'HTTP 301'],
    [404, 'not json', 'HTTP 404'],
    [200, 'not json', 'the answer is not JSON'],
  ] as const)('%i %s fails with %j', async ([status, body, reason]) => {
    const ollama = await startOllama()
    ollama.pullErrors['missing:1b'] = [status, body]

    await expect(pullModel(ollama.url, 'missing:1b')).rejects.toThrow(new PullError(reason))
  })

  test('a server that is down fails with the connection error', async () => {
    const down = `http://127.0.0.1:${await closedPort()}`

    await expect(pullModel(down, 'bge-m3')).rejects.toThrow(/ECONNREFUSED/)
    await expect(pullModel(down, 'bge-m3')).rejects.toBeInstanceOf(PullError)
  })
})

async function hasVector(url: string): Promise<boolean> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    const { rows } = await client.query<{ n: string }>(
      "SELECT count(*) AS n FROM pg_extension WHERE extname = 'vector'",
    )
    return rows[0]!.n !== '0'
  } finally {
    await client.end()
  }
}

async function migrationHead(url: string): Promise<string | null> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    const { rows } = await client.query<{ found: boolean }>(
      "SELECT to_regclass('pgmigrations') IS NOT NULL AS found",
    )
    if (!rows[0]!.found) return null
    const last = await client.query<{ name: string }>(
      'SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1',
    )
    return last.rows[0]?.name ?? null
  } finally {
    await client.end()
  }
}

function fakeSetup(runner: FakeRunner, seedError?: string) {
  const urls: string[] = []
  const revisions: (string | null)[] = []
  const deps: SetupDeps = {
    run: runner.run,
    seedDatabase: async (databaseUrl, root) => {
      runner.calls.push([SEED, root])
      urls.push(databaseUrl)
      revisions.push(await migrationHead(databaseUrl))
      if (seedError !== undefined) throw new SeedError(seedError)
      return 42
    },
  }
  return { deps, urls, revisions }
}

async function runSetup(
  deps: SetupDeps,
  databaseUrl: string,
  ollamaUrl: string,
  ...profiles: string[]
): Promise<Captured> {
  const settings = loadSettings({
    env: { DATABASE_URL: databaseUrl, OLLAMA_BASE_URL: ollamaUrl },
    envFile: null,
  })
  return capturing(() =>
    main(['setup', ...profiles.flatMap((profile) => ['--profile', profile])], {
      setup: (given) => setup('/fake/root', settings, given, deps),
    }),
  )
}

describe('mokosz setup', () => {
  test('setup stops when docker is not running', async ({ throwawayDatabaseUrl: url }) => {
    const runner = new FakeRunner({ 'docker info': 1 })
    const ollama = await startOllama()

    const result = await runSetup(fakeSetup(runner).deps, url, ollama.url)

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'Docker is not running: start Docker Desktop\n',
    })
    expect(ollama.hits).toEqual([])
    expect(runner.commands).toEqual([DOCKER_INFO])
    expect(await hasVector(url)).toBe(false)
  })

  test('setup runs the steps in order and migrates', async ({ throwawayDatabaseUrl: url }) => {
    const runner = new FakeRunner()
    const seed = fakeSetup(runner)
    const ollama = await startOllama()
    expect(await hasVector(url)).toBe(false)
    expect(await migrationHead(url)).toBeNull()

    const result = await runSetup(seed.deps, url, ollama.url)

    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    expect(runner.calls).toEqual([
      [DOCKER_INFO, '/fake/root'],
      [COMPOSE_UP, '/fake/root'],
      [SEED, '/fake/root'],
      [GIT_HOOKS, '/fake/root'],
    ])
    const head = (await readdir(MIGRATIONS_DIR))
      .map((file) => file.replace(/\.sql$/, ''))
      .toSorted()
    expect(seed.revisions).toEqual([head.at(-1)])
    expect(seed.urls).toEqual([url])
    expect(await migrationHead(url)).toBe(head.at(-1))
    expect(await hasVector(url)).toBe(true)
    expect(ollama.hits).toEqual(['/api/version', '/api/pull', '/api/pull'])
    expect(ollama.pulls).toEqual([
      { model: 'qwen3.6:27b', stream: false },
      { model: 'bge-m3', stream: false },
    ])
    expect(result.stdout.split('\n')).toEqual([
      'Docker: ok',
      `Ollama: ok (${ollama.url})`,
      'Pulled qwen3.6:27b',
      'Pulled bge-m3',
      'Database: up',
      'Migrations: at head',
      'Seed: 42 chunks',
      'Git hooks: core.hooksPath = .githooks',
      '',
    ])
  })

  test('setup stops when the seed fails', async ({ throwawayDatabaseUrl: url }) => {
    const runner = new FakeRunner()
    const ollama = await startOllama()

    const result = await runSetup(
      fakeSetup(runner, 'chunks.json does not list the corpus keys').deps,
      url,
      ollama.url,
    )

    expect(result.code).toBe(1)
    expect(result.stderr).toBe('Seeding failed: chunks.json does not list the corpus keys\n')
    expect(result.stdout).not.toContain('Git hooks')
    expect(runner.commands).toEqual([DOCKER_INFO, COMPOSE_UP, SEED])
  })

  test('setup with Ollama down only warns', async ({ throwawayDatabaseUrl: url }) => {
    const runner = new FakeRunner()
    const closed = `http://127.0.0.1:${await closedPort()}`

    const result = await runSetup(fakeSetup(runner).deps, url, closed)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain(
      `Warning: Ollama is not reachable at ${closed}; models not pulled\n`,
    )
    expect(result.stdout).not.toContain('Pulled')
    expect(runner.commands).toEqual([DOCKER_INFO, COMPOSE_UP, SEED, GIT_HOOKS])
    expect(await hasVector(url)).toBe(true)
  })

  test.for([204, 301, 404, 500])(
    'setup with Ollama answering %i to /api/version only warns',
    async (status, { throwawayDatabaseUrl: url }) => {
      const ollama = await startOllama(status)

      const result = await runSetup(fakeSetup(new FakeRunner()).deps, url, ollama.url)

      expect(result.code).toBe(0)
      expect(result.stdout).toContain(`Warning: Ollama is not reachable at ${ollama.url}`)
      expect(result.stdout).not.toContain('Ollama: ok')
      expect(ollama.hits).toEqual(['/api/version'])
      expect(ollama.pulls).toEqual([])
    },
  )

  test('setup with an Ollama that never answers /api/version warns within the timeout', async ({
    throwawayDatabaseUrl: url,
  }) => {
    const server = createServer(() => {})
    await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening))
    onTestFinished(async () => {
      server.closeAllConnections()
      await new Promise<void>((closed) => server.close(() => closed()))
    })
    const base = `http://127.0.0.1:${portOf(server)}`
    const started = performance.now()

    const result = await runSetup(fakeSetup(new FakeRunner()).deps, url, base)

    expect(performance.now() - started).toBeLessThan(5000)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(
      `Warning: Ollama is not reachable at ${base}; models not pulled`,
    )
  }, 15_000)

  test('setup without --profile pulls the settings default profile', async ({
    throwawayDatabaseUrl: url,
  }) => {
    const ollama = await startOllama()
    const settings = loadSettings({
      env: { DATABASE_URL: url, OLLAMA_BASE_URL: ollama.url, DEFAULT_PROFILE: 'local-gemma' },
      envFile: null,
    })
    const profile: { nodes: Record<string, { model: string }> } = parseYaml(
      await readFile(join(ROOT, 'profiles', 'local-gemma.yaml'), 'utf8'),
    )
    const models = [
      ...new Set(
        Object.values(profile.nodes).map(({ model }) => model.replace(/^ollama_chat\//, '')),
      ),
    ]

    const result = await capturing(() =>
      main(['setup'], {
        setup: (given) => setup('/fake/root', settings, given, fakeSetup(new FakeRunner()).deps),
      }),
    )

    expect(result.code).toBe(0)
    expect(models).toEqual(['gemma4:26b'])
    expect(ollama.pulls).toEqual([...models, 'bge-m3'].map((model) => ({ model, stream: false })))
  })

  test('setup pulls the chosen profiles models in order, then the embedder', async ({
    throwawayDatabaseUrl: url,
  }) => {
    const ollama = await startOllama()

    const result = await runSetup(
      fakeSetup(new FakeRunner()).deps,
      url,
      ollama.url,
      'local-gemma',
      'cloud-claude',
      'local-qwen',
      'local-gemma',
    )

    expect(result.code).toBe(0)
    expect(ollama.pulls).toEqual([
      { model: 'gemma4:26b', stream: false },
      { model: 'qwen3.6:27b', stream: false },
      { model: 'bge-m3', stream: false },
    ])
    const lines = result.stdout.split('\n')
    expect(lines.filter((line) => line.startsWith('Pulled '))).toEqual([
      'Pulled gemma4:26b',
      'Pulled qwen3.6:27b',
      'Pulled bge-m3',
    ])
    expect(lines.indexOf('Pulled bge-m3')).toBeLessThan(lines.indexOf('Seed: 42 chunks'))
  })

  test('setup with an unknown profile stops before docker', async ({
    throwawayDatabaseUrl: url,
  }) => {
    const runner = new FakeRunner()
    const ollama = await startOllama()

    const result = await runSetup(fakeSetup(runner).deps, url, ollama.url, 'local-nope')

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'Profile error: unknown profile: local-nope\n',
    })
    expect(runner.commands).toEqual([])
    expect(ollama.hits).toEqual([])
  })

  test('setup stops when the model is missing', async ({ throwawayDatabaseUrl: url }) => {
    const runner = new FakeRunner()
    const ollama = await startOllama()
    ollama.pullErrors['qwen3.6:27b'] = [500, '{"error":"pull model manifest: file does not exist"}']

    const result = await runSetup(fakeSetup(runner).deps, url, ollama.url)

    expect(result).toEqual({
      code: 1,
      stdout: `Docker: ok\nOllama: ok (${ollama.url})\n`,
      stderr: 'Pulling qwen3.6:27b failed: pull model manifest: file does not exist\n',
    })
    expect(ollama.pulls).toEqual([{ model: 'qwen3.6:27b', stream: false }])
    expect(runner.commands).toEqual([DOCKER_INFO])
    expect(await hasVector(url)).toBe(false)
  })

  test.for(['stalls', 'is cut'] as const)(
    'setup with Ollama whose /api/version body %s only warns',
    async (mode, { throwawayDatabaseUrl: url }) => {
      const hits: string[] = []
      const server = createServer((request, response) => {
        hits.push(request.url ?? '')
        response.writeHead(200, { 'content-length': 100 })
        response.write('{"vers')
        if (mode === 'is cut') setTimeout(() => response.destroy(), 50)
      })
      await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening))
      onTestFinished(async () => {
        server.closeAllConnections()
        await new Promise<void>((closed) => server.close(() => closed()))
      })
      const base = `http://127.0.0.1:${portOf(server)}`

      const result = await runSetup(fakeSetup(new FakeRunner()).deps, url, base)

      expect(result.code).toBe(0)
      expect(result.stdout).toContain(
        `Warning: Ollama is not reachable at ${base}; models not pulled\n`,
      )
      expect(result.stdout).not.toContain('Ollama: ok')
      expect(hits).toEqual(['/api/version'])
    },
  )

  test('setup stops when the pull socket is closed mid-request', async ({
    throwawayDatabaseUrl: url,
  }) => {
    const runner = new FakeRunner()
    const ollama = await startOllama()
    ollama.dropPulls = true

    const result = await runSetup(fakeSetup(runner).deps, url, ollama.url)

    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^Pulling qwen3\.6:27b failed: [^\n]+\n$/)
    expect(result.stdout).not.toContain('Pulled')
    expect(ollama.hits).toEqual(['/api/version', '/api/pull'])
    expect(runner.commands).toEqual([DOCKER_INFO])
  })

  test('setup waits for a pull that takes longer than the version timeout', async ({
    throwawayDatabaseUrl: url,
  }) => {
    const ollama = await startOllama()
    ollama.pullDelayMs = 4500

    const result = await runSetup(fakeSetup(new FakeRunner()).deps, url, ollama.url)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Pulled qwen3.6:27b\n')
  }, 30_000)

  test('setup waits for a pull body that arrives after the version timeout', async ({
    throwawayDatabaseUrl: url,
  }) => {
    const ollama = await startOllama()
    ollama.bodyDelayMs = 2500
    const started = performance.now()

    const result = await runSetup(fakeSetup(new FakeRunner()).deps, url, ollama.url)

    expect(performance.now() - started).toBeGreaterThanOrEqual(ollama.bodyDelayMs)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Pulled qwen3.6:27b\n')
    expect(ollama.flushedBeforeBody).toEqual(['qwen3.6:27b', 'bge-m3'])
  }, 30_000)

  test.for([
    ['port 5433 in use', 'Starting the database failed\nport 5433 in use\n'],
    ['\n  port 5433 in use \n', 'Starting the database failed\nport 5433 in use\n'],
    [' \n', 'Starting the database failed\n'],
  ] as const)(
    'setup stops when compose fails (stderr %j)',
    async ([stderr, message], { throwawayDatabaseUrl: url }) => {
      const key = COMPOSE_UP.join(' ')
      const runner = new FakeRunner({ [key]: 1 }, { [key]: stderr })
      const ollama = await startOllama()

      const result = await runSetup(fakeSetup(runner).deps, url, ollama.url)

      expect(result.code).toBe(1)
      expect(result.stderr).toBe(message)
      expect(runner.commands).toEqual([DOCKER_INFO, COMPOSE_UP])
      expect(await hasVector(url)).toBe(false)
    },
  )

  test('setup stops when the migration fails', async ({ throwawayDatabaseUrl: url }) => {
    const runner = new FakeRunner()
    const ollama = await startOllama()
    const missing = withDatabase(
      url,
      `mokosz_missing_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    )
    let stdout = ''
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk)
      return true
    })

    try {
      await expect(runSetup(fakeSetup(runner).deps, missing, ollama.url)).rejects.toThrow()
    } finally {
      out.mockRestore()
    }

    expect(stdout).not.toContain('Migrations: at head')
    expect(stdout).not.toContain('Seed')
    expect(stdout).not.toContain('Git hooks')
    expect(runner.commands).toEqual([DOCKER_INFO, COMPOSE_UP])
  })

  test('setup stops when enabling the hook fails', async ({ throwawayDatabaseUrl: url }) => {
    const runner = new FakeRunner(
      { [GIT_HOOKS.join(' ')]: 1 },
      { [GIT_HOOKS.join(' ')]: 'fatal: bad config' },
    )
    const ollama = await startOllama()

    const result = await runSetup(fakeSetup(runner).deps, url, ollama.url)

    expect(result.code).toBe(1)
    expect(result.stderr).toBe('Enabling the commit-msg hook failed\nfatal: bad config\n')
    expect(result.stdout).toBe(
      [
        'Docker: ok',
        `Ollama: ok (${ollama.url})`,
        'Pulled qwen3.6:27b',
        'Pulled bge-m3',
        'Database: up',
        'Migrations: at head',
        'Seed: 42 chunks',
        '',
      ].join('\n'),
    )
    expect(runner.commands).toEqual([DOCKER_INFO, COMPOSE_UP, SEED, GIT_HOOKS])
  })
})
