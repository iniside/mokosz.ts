import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { utimesSync } from 'node:fs'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { connect } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { Client } from 'pg'
import { GIF_QUESTION, GRACEFUL_SHUTDOWN_MS, devModule, main, type Commands } from '../src/cli.ts'
import { CommandError, repoRoot, runCommand } from '../src/command.ts'
import { upgradeHead } from '../src/db/index.ts'
import { seedCommand, seedDatabase } from '../src/ingest/commands.ts'
import { SeedError } from '../src/ingest/seed.ts'
import { databaseOf } from './support/databases.ts'
import { closedPort } from './support/network.ts'
import { capturing, type Captured } from './support/capture.ts'
import { describe, expect, test } from './support/harness.ts'

const ROOT = resolve(import.meta.dirname, '..')
const CLI = join(ROOT, 'src', 'cli.ts')
const WATCHED = join(ROOT, 'src', 'api', 'health.ts')
const CLOSED_DB = 'postgresql://mokosz:mokosz@127.0.0.1:1/mokosz'
const UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

type Name = keyof Commands

/** Runs main with every command recorded instead of run; a given command replaces its recorder. */
async function invoke(
  args: string[],
  overrides: Partial<Commands> = {},
): Promise<Captured & { calls: [Name, unknown][] }> {
  const calls: [Name, unknown][] = []
  const record =
    (name: Name) =>
    async (options?: unknown): Promise<void> => {
      calls.push([name, options])
    }
  const commands: Commands = {
    serve: async (options) => {
      calls.push(['serve', options])
      return 0
    },
    setup: record('setup'),
    fetch: record('fetch'),
    embed: record('embed'),
    seed: record('seed'),
    generateInvoices: record('generateInvoices'),
    screenshots: record('screenshots'),
    evaluate: record('evaluate'),
    ...overrides,
  }
  const result = await capturing(() => main(args, commands))
  return { ...result, calls }
}

describe('each command receives its options and defaults', () => {
  test.for<[string[], [Name, unknown]]>([
    [
      ['serve'],
      ['serve', { host: '127.0.0.1', port: 8000, reload: false, timeoutGracefulShutdownMs: 5000 }],
    ],
    [
      ['serve', '--host', '0.0.0.0', '--port', '9000', '--reload'],
      ['serve', { host: '0.0.0.0', port: 9000, reload: true, timeoutGracefulShutdownMs: 5000 }],
    ],
    [['setup'], ['setup', []]],
    [
      ['setup', '--profile', 'local-gemma', '--profile', 'cloud-claude'],
      ['setup', ['local-gemma', 'cloud-claude']],
    ],
    [['fetch'], ['fetch', false]],
    [
      ['fetch', '--force'],
      ['fetch', true],
    ],
    [['embed'], ['embed', []]],
    [
      ['embed', '--model', 'bge-m3', '--model', 'nomic'],
      ['embed', ['bge-m3', 'nomic']],
    ],
    [['seed'], ['seed', undefined]],
    [['generate-invoices'], ['generateInvoices', {}]],
    [
      ['generate-invoices', '--out', 'some/dir', '--seed', '7'],
      ['generateInvoices', { out: resolve('some/dir'), seed: 7 }],
    ],
    [
      ['generate-invoices', '--seed', '-3'],
      ['generateInvoices', { seed: -3 }],
    ],
    [['screenshots'], ['screenshots', { url: 'http://localhost:4173', question: GIF_QUESTION }]],
    [
      ['screenshots', '--url', 'http://ui', '--conversation', UUID, '--question', 'Why?'],
      ['screenshots', { url: 'http://ui', conversation: UUID, question: 'Why?' }],
    ],
    [['eval'], ['evaluate', { repeat: 1 }]],
  ])('mokosz %j', async ([args, call]) => {
    const { code, stderr, calls } = await invoke(args)

    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    expect(calls).toEqual([call])
  })

  test('the default question is the AI Act deployer question', () => {
    expect(GIF_QUESTION).toBe(
      'Which obligations does the AI Act place on deployers of high-risk AI systems?',
    )
    expect(GRACEFUL_SHUTDOWN_MS).toBe(5000)
  })
})

describe('usage errors are commander errors with exit code 1', () => {
  test.for<[string[], string]>([
    [['nope'], "unknown command 'nope'"],
    [['serv'], 'Did you mean serve?'],
    [['fetch', '--forse'], 'Did you mean --force?'],
    [['fetch', '--force=yes'], "unknown option '--force=yes'"],
    [['serve', '--no-reload'], "unknown option '--no-reload'"],
    [['serve', '--port', 'x'], "'--port <port>' argument 'x' is invalid"],
    [['serve', '--port', '80.5'], "'--port <port>' argument '80.5' is invalid"],
    [['serve', 'extra'], "too many arguments for 'serve'"],
    [['seed', 'extra'], "too many arguments for 'seed'"],
    [['setup', '--profile'], "option '--profile <profile>' argument missing"],
    [['generate-invoices', '--seed', 'abc'], "'--seed <seed>' argument 'abc' is invalid"],
    [['screenshots', '--conversation'], "'--conversation <conversation>' argument missing"],
  ])('mokosz %j', async ([args, message]) => {
    const { code, stdout, stderr, calls } = await invoke(args)

    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain(message)
    expect(calls).toEqual([])
  })

  test('without a command the help goes to stderr with exit code 1', async () => {
    const { code, stdout, stderr, calls } = await invoke([])

    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('Usage: mokosz')
    expect(calls).toEqual([])
  })
})

describe('help', () => {
  test('--help lists every command on stdout and exits 0', async () => {
    const { code, stdout, stderr } = await invoke(['--help'])

    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    for (const name of [
      'serve',
      'setup',
      'fetch',
      'embed',
      'seed',
      'generate-invoices',
      'screenshots',
      'eval',
    ]) {
      expect(stdout).toMatch(new RegExp(`^  ${name}\\b`, 'm'))
    }
  })

  test('a command help shows its options and exits 0', async () => {
    const { code, stdout, calls } = await invoke(['setup', '--help'])

    expect(code).toBe(0)
    expect(stdout).toContain('--profile <profile>')
    expect(calls).toEqual([])
  })
})

describe('exit codes of a command', () => {
  test('a CommandError is its message on stderr and exit code 1', async () => {
    const { code, stdout, stderr } = await invoke(['seed'], {
      seed: async () => {
        throw new CommandError('Seeding failed: no chunks')
      },
    })

    expect({ code, stdout, stderr }).toEqual({
      code: 1,
      stdout: '',
      stderr: 'Seeding failed: no chunks\n',
    })
  })

  test('serve exits with the code the server returns', async () => {
    expect((await invoke(['serve'], { serve: async () => 3 })).code).toBe(3)
  })

  test('any other error propagates', async () => {
    const bug = new TypeError('x is undefined')

    await expect(
      invoke(['fetch'], {
        fetch: () => Promise.reject(bug),
      }),
    ).rejects.toBe(bug)
  })
})

describe('dev modules', () => {
  test('a missing module is the install hint', async () => {
    const missing: string = 'mokosz-no-such-package'

    await expect(devModule(() => import(missing), 'run npm install')).rejects.toThrow(
      new CommandError('run npm install'),
    )
  })

  test('another load error propagates', async () => {
    const broken = Object.assign(new Error('Could not load the "sharp" module'), {
      code: 'ERR_DLOPEN_FAILED',
    })

    await expect(devModule(() => Promise.reject(broken), 'hint')).rejects.toBe(broken)
  })
})

describe('the repository root', () => {
  test('is the git toplevel', () => {
    expect(resolve(repoRoot('fetch'))).toBe(ROOT)
  })

  test('outside a clone it is a CommandError naming the command', () => {
    expect(() => repoRoot('seed', () => ({ status: 128, stdout: '', stderr: 'fatal' }))).toThrow(
      new CommandError('Not inside a git clone: run mokosz seed from the repository'),
    )
  })

  test('a missing executable is status 127', () => {
    const result = runCommand(['mokosz-no-such-executable'])

    expect(result.status).toBe(127)
    expect(result.stderr.startsWith('mokosz-no-such-executable: ')).toBe(true)
  })

  test('a command keeps its exit status and stderr', () => {
    const result = runCommand([
      process.execPath,
      '-e',
      'process.stdout.write("o");process.stderr.write("x");process.exit(3)',
    ])

    expect(result).toEqual({ status: 3, stdout: 'o', stderr: 'x' })
  })
})

async function migrationsTableExists(url: string): Promise<boolean> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    const { rows } = await client.query<{ found: boolean }>(
      "SELECT to_regclass('pgmigrations') IS NOT NULL AS found",
    )
    return rows[0]!.found
  } finally {
    await client.end()
  }
}

const seedThrough = (command: Commands['seed']) =>
  capturing(() => main(['seed'], { seed: command }))

describe('mokosz seed', () => {
  test('seed seeds the given database from the given root', async ({
    throwawayDatabaseUrl: url,
  }) => {
    const calls: [string, string][] = []

    const result = await seedThrough(() =>
      seedCommand('/fake/root', url, async (databaseUrl, root) => {
        calls.push([databaseUrl, root])
        return 42
      }),
    )

    expect(result).toEqual({ code: 0, stdout: 'Seed: 42 chunks\n', stderr: '' })
    expect(calls).toEqual([[url, '/fake/root']])
  })

  test('seed reports a seed error', async ({ throwawayDatabaseUrl: url }) => {
    const result = await seedThrough(() =>
      seedCommand(ROOT, url, async () => {
        throw new SeedError('chunks.npy has shape (1, 2)')
      }),
    )

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'Seeding failed: chunks.npy has shape (1, 2)\n',
    })
  })

  test('seed lets an error that is not a SeedError propagate', async () => {
    const bug = new TypeError('x is undefined')

    await expect(seedCommand(ROOT, CLOSED_DB, () => Promise.reject(bug))).rejects.toBe(bug)
  })

  test('seed on an unmigrated database asks for setup', async ({ throwawayDatabaseUrl: url }) => {
    const result = await seedThrough(() => seedCommand(ROOT, url))

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'Seeding failed: chunks table missing; run mokosz setup\n',
    })
    expect(await migrationsTableExists(url)).toBe(false)
  })

  test('seed database hands a connection to the url to seed chunks', async ({
    throwawayDatabaseUrl: url,
  }) => {
    await upgradeHead(url)
    const seen: [string, string][] = []

    const count = await seedDatabase(url, '/some/root', async (client, root) => {
      const { rows } = await client.query<{ current_database: string }>('SELECT current_database()')
      seen.push([rows[0]!.current_database, root])
      return 7
    })

    expect(count).toBe(7)
    expect(seen).toEqual([[databaseOf(url), '/some/root']])
  })
})

async function healthy(url: string, deadline: number): Promise<unknown> {
  for (;;) {
    try {
      const response = await fetch(`${url}/api/health`)
      return await response.json()
    } catch (error) {
      if (Date.now() > deadline) throw error
      await sleep(200)
    }
  }
}

interface Served {
  child: ChildProcessWithoutNullStreams
  output: () => string
  exited: Promise<number | null>
  stop: () => Promise<void>
}

function serve(args: string[], env: Record<string, string | undefined>): Served {
  const child = spawn(process.execPath, [CLI, 'serve', ...args], {
    env: { ...process.env, ...env },
  })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
  const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)))
  return {
    child,
    output: () => output,
    exited,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return
      // The reloader's watcher and server are grandchildren; Windows kills only what it is told.
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'])
      } else {
        child.kill('SIGTERM')
      }
      await exited
    },
  }
}

async function answering(served: Served, url: string): Promise<unknown> {
  return await healthy(url, Date.now() + 20_000).catch((error: unknown) => {
    throw new Error(`the server did not answer; its output:\n${served.output()}`, { cause: error })
  })
}

async function requestWithHost(
  port: number,
  host: string,
): Promise<{ status: number; body: unknown }> {
  const response = await new Promise<IncomingMessage>((done, reject) => {
    httpRequest({ host: '127.0.0.1', port, path: '/api/health', headers: { host } }, done)
      .on('error', reject)
      .end()
  })
  let text = ''
  for await (const chunk of response) text += String(chunk)
  return { status: response.statusCode ?? 0, body: JSON.parse(text) }
}

async function waitFor(served: Served, text: string, times: number): Promise<void> {
  const deadline = Date.now() + 20_000
  while (served.output().split(text).length - 1 < times) {
    if (Date.now() > deadline) throw new Error(`no "${text}" x${times} in:\n${served.output()}`)
    await sleep(100)
  }
}

describe('mokosz serve process', () => {
  test('a failed startup prints the error and exits 3', async () => {
    const served = serve(['--port', String(await closedPort())], {
      DATABASE_URL: CLOSED_DB,
    })

    const code = await served.exited

    expect(code, served.output()).toBe(3)
    expect(served.output()).toContain('DatabaseTimeout: database not reachable within 2 s')
    expect(served.output().trimEnd().endsWith('Startup failed.')).toBe(true)
  })

  test('the api listens on the given host and port only', async ({
    testSettings,
    unreachableOllama: _,
  }) => {
    const port = await closedPort()
    const served = serve(['--host', '127.0.0.2', '--port', `${port}`], {
      DATABASE_URL: testSettings.databaseUrl,
    })
    try {
      const body = await answering(served, `http://127.0.0.2:${port}`)

      expect(body).toEqual({
        status: 'degraded',
        db: 'ok',
        ollama: 'unreachable',
      })
      await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow('fetch failed')
    } finally {
      await served.stop()
    }
  })

  for (const [name, args] of [
    ['by default', []],
    ['with --reload', ['--reload']],
  ] as const) {
    test(
      'the loopback Host check is on ' + name,
      async ({ testSettings, unreachableOllama: _ }) => {
        const port = await closedPort()
        const served = serve([...args, '--port', `${port}`], {
          DATABASE_URL: testSettings.databaseUrl,
        })
        try {
          await answering(served, `http://127.0.0.1:${port}`)

          const foreign = await requestWithHost(port, 'evil.example')
          expect(foreign).toEqual({ status: 403, body: { detail: 'Host not allowed' } })
          const local = await requestWithHost(port, `localhost:${port}`)
          expect(local.status).toBe(200)
        } finally {
          await served.stop()
        }
      },
    )
  }

  test.skipIf(process.platform === 'win32')(
    'SIGTERM waits for a request in flight up to the graceful timeout, then exits 0 (POSIX: Windows has no SIGTERM)',
    async ({ testSettings, unreachableOllama: _ }) => {
      const port = await closedPort()
      const served = serve(['--port', `${port}`], {
        DATABASE_URL: testSettings.databaseUrl,
      })
      try {
        await answering(served, `http://127.0.0.1:${port}`)
        const inFlight = connect(port, '127.0.0.1')
        await once(inFlight, 'connect')
        inFlight.write('GET /api/health HTTP/1.1\r\nHost: test\r\n')
        const cut = once(inFlight, 'close')
        await sleep(200)

        const signalled = performance.now()
        served.child.kill('SIGTERM')
        const code = await served.exited
        const elapsed = performance.now() - signalled
        await cut

        expect(code, served.output()).toBe(0)
        expect(elapsed).toBeGreaterThanOrEqual(GRACEFUL_SHUTDOWN_MS - 200)
        expect(elapsed).toBeLessThan(GRACEFUL_SHUTDOWN_MS + 3000)
      } finally {
        await served.stop()
      }
    },
  )

  test('--reload restarts the server on the given host when a source file changes', async ({
    testSettings,
    unreachableOllama: _,
  }) => {
    const port = await closedPort()
    const url = `http://127.0.0.2:${port}`
    const served = serve(['--host', '127.0.0.2', '--port', `${port}`, '--reload'], {
      DATABASE_URL: testSettings.databaseUrl,
    })
    try {
      await waitFor(served, 'Mokosz API on', 1)
      await answering(served, url)

      const now = new Date()
      utimesSync(WATCHED, now, now)

      await waitFor(served, 'Mokosz API on', 2)
      expect(await answering(served, url)).toMatchObject({ db: 'ok' })
    } finally {
      await served.stop()
    }
  })

  test.skipIf(process.platform === 'win32')(
    '--reload passes SIGTERM on, so the watcher and the server stop (POSIX: Windows has no SIGTERM)',
    async ({ testSettings, unreachableOllama: _ }) => {
      const port = await closedPort()
      const served = serve(['--port', `${port}`, '--reload'], {
        DATABASE_URL: testSettings.databaseUrl,
      })
      try {
        await answering(served, `http://127.0.0.1:${port}`)

        served.child.kill('SIGTERM')
        await served.exited
        await sleep(500)

        await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow('fetch failed')
      } finally {
        await served.stop()
      }
    },
  )
})
