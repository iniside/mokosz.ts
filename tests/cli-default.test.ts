import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { vi } from 'vitest'
import { main } from '../src/cli.ts'
import { evalCommand } from '../src/evals/run.ts'
import { embedCommand, fetchCommand, seedCommand } from '../src/ingest/commands.ts'
import { clearSettingsCache } from '../src/settings.ts'
import { setup } from '../src/setup.ts'
import { describe, expect, test } from './support/harness.ts'

vi.mock('../src/setup.ts', () => ({ setup: vi.fn(async () => {}) }))
vi.mock('../src/ingest/commands.ts', () => ({
  fetchCommand: vi.fn(async () => {}),
  embedCommand: vi.fn(async () => {}),
  seedCommand: vi.fn(async () => {}),
  seedDatabase: vi.fn(async () => 0),
}))
vi.mock('../src/evals/run.ts', () => ({ evalCommand: vi.fn(async () => {}) }))

const ROOT = resolve(import.meta.dirname, '..')
const DATABASE_URL = 'postgresql://wired:wired@127.0.0.1:1/wired'
const OLLAMA_BASE_URL = 'http://127.0.0.1:1'

async function run(args: string[]): Promise<{ code: number; stderr: string }> {
  vi.stubEnv('DATABASE_URL', DATABASE_URL)
  vi.stubEnv('OLLAMA_BASE_URL', OLLAMA_BASE_URL)
  clearSettingsCache()
  let stderr = ''
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk)
    return true
  })
  try {
    return { code: await main(args), stderr }
  } finally {
    err.mockRestore()
    vi.unstubAllEnvs()
    clearSettingsCache()
  }
}

/** The arguments of the single call, with the repository root resolved. */
function onlyCall(calls: readonly (readonly unknown[])[]): unknown[] {
  expect(calls).toHaveLength(1)
  const [root, ...rest] = calls[0]!
  return [resolve(String(root)), ...rest]
}

describe('the default commands pass the git toplevel, the settings and the options', () => {
  test('setup', async () => {
    vi.mocked(setup).mockClear()

    expect(await run(['setup', '--profile', 'a', '--profile', 'b'])).toEqual({
      code: 0,
      stderr: '',
    })

    const [root, settings, profiles] = onlyCall(vi.mocked(setup).mock.calls)
    expect(root).toBe(ROOT)
    expect(settings).toMatchObject({ databaseUrl: DATABASE_URL, ollamaBaseUrl: OLLAMA_BASE_URL })
    expect(profiles).toEqual(['a', 'b'])
  })

  test('fetch', async () => {
    vi.mocked(fetchCommand).mockClear()

    expect((await run(['fetch', '--force'])).code).toBe(0)

    expect(onlyCall(vi.mocked(fetchCommand).mock.calls)).toEqual([ROOT, true])
  })

  test('embed', async () => {
    vi.mocked(embedCommand).mockClear()

    expect((await run(['embed', '--model', 'a', '--model', 'b'])).code).toBe(0)

    expect(onlyCall(vi.mocked(embedCommand).mock.calls)).toEqual([
      ROOT,
      OLLAMA_BASE_URL,
      ['a', 'b'],
    ])
  })

  test('seed', async () => {
    vi.mocked(seedCommand).mockClear()

    expect((await run(['seed'])).code).toBe(0)

    expect(onlyCall(vi.mocked(seedCommand).mock.calls)).toEqual([ROOT, DATABASE_URL])
  })

  test('eval', async () => {
    vi.mocked(evalCommand).mockClear()

    expect((await run(['eval', '--repeat', '3', '--profile', 'x'])).code).toBe(0)

    const [root, settings, options] = onlyCall(vi.mocked(evalCommand).mock.calls)
    expect(root).toBe(ROOT)
    expect(settings).toMatchObject({ databaseUrl: DATABASE_URL })
    expect(options).toEqual({ profile: 'x', set: 'qa', repeat: 3 })
  })
})

// Resolving the dev dependencies fails as it does after npm install --omit=dev.
const WITHOUT_DEV = [
  'import { registerHooks } from "node:module"',
  'const dev = new Set(["playwright", "sharp", "@faker-js/faker", "pdfkit"])',
  'registerHooks({ resolve(specifier, context, next) {',
  '  if (dev.has(specifier)) {',
  '    throw Object.assign(new Error("Cannot find package " + specifier), { code: "ERR_MODULE_NOT_FOUND" })',
  '  }',
  '  return next(specifier, context)',
  '} })',
].join('\n')

describe('without the dev dependencies', () => {
  test.for<[string[], string]>([
    [
      ['screenshots', '--conversation', 'nope'],
      'Screenshots need the dev dependencies: run npm install, then npx playwright install chromium\n',
    ],
    [
      ['generate-invoices', '--out', 'x'],
      'Generating invoices needs the dev dependencies: run npm install\n',
    ],
  ])('mokosz %j says how to install them', ([args, hint]) => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        `data:text/javascript,${encodeURIComponent(WITHOUT_DEV)}`,
        join(ROOT, 'src', 'cli.ts'),
        ...args,
      ],
      { cwd: ROOT, encoding: 'utf8' },
    )

    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 1,
      stdout: '',
      stderr: hint,
    })
  })
})
