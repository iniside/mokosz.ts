import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createDatabase, databaseName, dropDatabase, listDatabases } from './databases.ts'
import { describe, expect, test } from './harness.ts'

const TESTS = import.meta.dirname
const VITEST = resolve(TESTS, '..', '..', 'node_modules', 'vitest', 'vitest.mjs')
const GLOBAL_SETUP = resolve(TESTS, 'global-setup.ts')
const HOUR = 60 * 60 * 1000

const url = (file: string): string => pathToFileURL(resolve(TESTS, file)).href

const inner = (harness: string, databases: string): string => `
import { appendFileSync } from 'node:fs'
import { databaseOf } from ${JSON.stringify(databases)}
import { test } from ${JSON.stringify(harness)}

const record = (url: string): void =>
  appendFileSync(process.env.MOKOSZ_INNER_LOG!, databaseOf(url) + '\\n', 'utf8')

const broken = test.extend('broken', ({ throwawayDatabaseUrl }): string => {
  record(throwawayDatabaseUrl)
  throw new Error('fixture setup fails')
})

test('a fails', ({ testSettings, throwawayDatabaseUrl }) => {
  record(testSettings.databaseUrl)
  record(throwawayDatabaseUrl)
  throw new Error('inner failure')
})

broken('b setup error', ({ broken: _ }) => {})

test('c interrupted', async ({ throwawayDatabaseUrl, signal }) => {
  record(throwawayDatabaseUrl)
  await new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('interrupted')), { once: true })
    setTimeout(() => reject(new Error('the run was not cancelled')), 20_000)
  })
})
`

interface Summary {
  reason: string
  tests: Record<string, { state: string; errors: string[] }>
}

interface InnerRun {
  output: string
  summary: Summary | null
  created: string[]
  staleSurvived: boolean
}

async function runInner(serverUrl: string): Promise<InnerRun> {
  const directory = mkdtempSync(join(tmpdir(), 'mokosz-inner-'))
  writeFileSync(join(directory, 'inner.test.ts'), inner(url('harness.ts'), url('databases.ts')))
  const log = join(directory, 'created.txt')
  const stale = databaseName('throwaway', new Date(Date.now() - 2 * HOUR))
  await createDatabase(serverUrl, stale)
  let staleSurvived = true
  try {
    const result = spawnSync(process.execPath, [resolve(TESTS, 'cleanup-run.ts'), directory], {
      cwd: resolve(TESTS, '..', '..'),
      env: { ...process.env, DATABASE_URL: serverUrl, MOKOSZ_INNER_LOG: log },
      encoding: 'utf8',
      timeout: 300_000,
    })
    const output = `${result.stdout}${result.stderr}`
    const line = output.split('\n').find((text) => text.startsWith('SUMMARY '))
    const summary: Summary | null = line === undefined ? null : JSON.parse(line.slice(8))
    const created = existsSync(log) ? readFileSync(log, 'utf8').split(/\s+/).filter(Boolean) : []
    staleSurvived = (await listDatabases(serverUrl)).includes(stale)
    return { output, summary, created, staleSurvived }
  } finally {
    if (staleSurvived) await dropDatabase(serverUrl, stale)
  }
}

describe('database cleanup', () => {
  let run: InnerRun | null = null
  const innerRun = async (serverUrl: string): Promise<InnerRun> => {
    run ??= await runInner(serverUrl)
    return run
  }

  test('failed, errored and interrupted runs drop their databases', async ({ serverUrl }) => {
    const { output, summary, created } = await innerRun(serverUrl)

    expect(summary, output).not.toBeNull()
    expect(summary!.reason, output).toBe('interrupted')
    expect(summary!.tests['a fails'], output).toEqual({
      state: 'failed',
      errors: ['inner failure'],
    })
    expect(summary!.tests['b setup error'], output).toEqual({
      state: 'failed',
      errors: ['fixture setup fails'],
    })
    expect(summary!.tests['c interrupted']?.state, output).toBe('skipped')
    const kinds = created.map((name) => name.split('_')[1])
    expect(
      kinds.filter((kind) => kind === 'test'),
      created.join(' '),
    ).toHaveLength(1)
    expect(
      kinds.filter((kind) => kind === 'throwaway'),
      created.join(' '),
    ).toHaveLength(3)

    const existing = new Set(await listDatabases(serverUrl))
    const leaked = created.filter((name) => existing.has(name))

    for (const name of leaked) await dropDatabase(serverUrl, name)
    expect(leaked).toEqual([])
  })

  test('a new run sweeps databases older than an hour', async ({ serverUrl }) => {
    expect((await innerRun(serverUrl)).staleSurvived).toBe(false)
  })
})

interface SignalledRun {
  output: string
  created: string[]
  exitedAfterMs: number
}

async function runInnerUntilSigint(serverUrl: string): Promise<SignalledRun> {
  const directory = mkdtempSync(join(tmpdir(), 'mokosz-inner-'))
  writeFileSync(join(directory, 'inner.test.ts'), inner(url('harness.ts'), url('databases.ts')))
  writeFileSync(
    join(directory, 'vitest.config.mjs'),
    `export default { test: { include: ['*.test.ts'], globalSetup: [${JSON.stringify(GLOBAL_SETUP)}] } }\n`,
  )
  const log = join(directory, 'created.txt')
  const created = (): string[] =>
    existsSync(log) ? readFileSync(log, 'utf8').split(/\s+/).filter(Boolean) : []
  const child = spawn(process.execPath, [VITEST, 'run', '--root', directory], {
    cwd: resolve(TESTS, '..', '..'),
    env: { ...process.env, DATABASE_URL: serverUrl, MOKOSZ_INNER_LOG: log },
  })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
  const exited = new Promise<void>((done) => child.once('exit', () => done()))
  const deadline = Date.now() + 60_000
  // Test c records the third throwaway database, then waits to be interrupted.
  while (created().filter((name) => name.includes('_throwaway_')).length < 3) {
    if (Date.now() > deadline) {
      child.kill('SIGKILL')
      throw new Error(`test c never started:\n${output}`)
    }
    await sleep(100)
  }
  await sleep(300)
  const signalled = performance.now()
  child.kill('SIGINT')
  await exited
  return { output, created: created(), exitedAfterMs: performance.now() - signalled }
}

describe('database cleanup on SIGINT', () => {
  test.skipIf(process.platform === 'win32')(
    'a run stopped by SIGINT drops its databases (POSIX: Windows cannot send a catchable SIGINT)',
    async ({ serverUrl }) => {
      const { output, created, exitedAfterMs } = await runInnerUntilSigint(serverUrl)

      expect(exitedAfterMs, output).toBeLessThan(10_000)
      const kinds = created.map((name) => name.split('_')[1])
      expect(
        kinds.filter((kind) => kind === 'test'),
        created.join(' '),
      ).toHaveLength(1)
      expect(
        kinds.filter((kind) => kind === 'throwaway'),
        created.join(' '),
      ).toHaveLength(3)

      const existing = new Set(await listDatabases(serverUrl))
      const leaked = created.filter((name) => existing.has(name))

      for (const name of leaked) await dropDatabase(serverUrl, name)
      expect(leaked, output).toEqual([])
    },
  )
})
