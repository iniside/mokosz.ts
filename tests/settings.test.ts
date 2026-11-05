import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  clearSettingsCache,
  getSettings,
  loadSettings,
  SettingsError,
  type Settings,
} from '../src/settings.ts'

const ROOT = resolve(import.meta.dirname, '..')

const DEFAULTS = {
  databaseUrl: 'postgresql://mokosz:mokosz@localhost:5433/mokosz',
  ollamaBaseUrl: 'http://localhost:11434',
  defaultProfile: 'local-qwen',
}

function envFileWith(text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'mokosz-env-')), '.env')
  writeFileSync(path, text, 'utf8')
  return path
}

const anthropicBase = (env: Record<string, string>): string =>
  loadSettings({ env, envFile: null }).anthropicApiBase

/** The settings as plain values, with the API key revealed. */
function plain(settings: Settings): Record<string, string | null> {
  const { databaseUrl, ollamaBaseUrl, defaultProfile, anthropicApiKey } = settings
  return {
    databaseUrl,
    ollamaBaseUrl,
    defaultProfile,
    anthropicApiKey: anthropicApiKey?.reveal() ?? null,
  }
}

function fromFile(text: string, env: Record<string, string> = {}): Record<string, string | null> {
  return plain(loadSettings({ env, envFile: envFileWith(text) }))
}

describe('settings', () => {
  test('the defaults apply without environment or .env file', () => {
    expect(loadSettings({ env: {}, envFile: null })).toEqual({
      ...DEFAULTS,
      anthropicApiKey: null,
      anthropicApiBase: 'https://api.anthropic.com',
    })
  })

  test('a missing .env file means the defaults', () => {
    const envFile = join(mkdtempSync(join(tmpdir(), 'mokosz-env-')), '.env')

    expect(plain(loadSettings({ env: {}, envFile }))).toEqual({
      ...DEFAULTS,
      anthropicApiKey: null,
    })
  })

  test.for<[string, keyof typeof DEFAULTS]>([
    ['DATABASE_URL', 'databaseUrl'],
    ['OLLAMA_BASE_URL', 'ollamaBaseUrl'],
    ['DEFAULT_PROFILE', 'defaultProfile'],
  ])('%s: the environment wins over .env, which wins over the default', ([name, field]) => {
    const envFile = envFileWith(`${name}=from-file\n`)
    const read = (env: Record<string, string>, file: string | null) =>
      loadSettings({ env, envFile: file })[field]

    expect(read({}, null)).toBe(DEFAULTS[field])
    expect(read({}, envFile)).toBe('from-file')
    expect(read({ [name]: 'from-env' }, envFile)).toBe('from-env')
    expect(read({ [name]: '' }, envFile)).toBe('')
    expect(read({ [name.toLowerCase()]: 'lower-env' }, envFile)).toBe('from-file')
  })

  test('ANTHROPIC_API_KEY: the environment wins over .env, and it stays masked', () => {
    const envFile = envFileWith('ANTHROPIC_API_KEY=sk-file\n')

    expect(loadSettings({ env: {}, envFile: null }).anthropicApiKey).toBeNull()
    expect(loadSettings({ env: {}, envFile }).anthropicApiKey?.reveal()).toBe('sk-file')
    const settings = loadSettings({ env: { ANTHROPIC_API_KEY: 'sk-env' }, envFile })
    expect(settings.anthropicApiKey?.reveal()).toBe('sk-env')
    expect(String(settings.anthropicApiKey)).toBe('**********')
    expect(JSON.stringify(settings)).not.toContain('sk-env')
    expect(fromFile('ANTHROPIC_API_KEY=\n').anthropicApiKey).toBe('')
  })

  test('the Anthropic base URL comes from the environment only', () => {
    expect(anthropicBase({ ANTHROPIC_BASE_URL: 'http://b' })).toBe('http://b')
    expect(anthropicBase({ ANTHROPIC_API_BASE: 'http://a', ANTHROPIC_BASE_URL: 'http://b' })).toBe(
      'http://a',
    )
    expect(anthropicBase({ ANTHROPIC_API_BASE: '', ANTHROPIC_BASE_URL: 'http://b' })).toBe(
      'http://b',
    )
    expect(anthropicBase({ ANTHROPIC_BASE_URL: '' })).toBe('https://api.anthropic.com')
    expect(() => fromFile('ANTHROPIC_BASE_URL=http://file\n')).toThrow(
      'unknown setting ANTHROPIC_BASE_URL',
    )
  })

  test.for<[string, string, Record<string, string>, string]>([
    ['${VAR} is left as written', 'DATABASE_URL=${DB_X}/z\n', { DB_X: 'pg' }, '${DB_X}/z'],
    ['$VAR is left as written', 'DATABASE_URL=$DB_X/z\n', { DB_X: 'pg' }, '$DB_X/z'],
    ['a key with no = is ignored', 'DATABASE_URL\nOLLAMA_BASE_URL=y\n', {}, DEFAULTS.databaseUrl],
    ['an empty value is kept', 'DATABASE_URL=\n', {}, ''],
    ['export is dropped', 'export DATABASE_URL=e\n', {}, 'e'],
    ['an inline comment is dropped', 'DATABASE_URL=a # c\n', {}, 'a'],
    ['spaces around = and the value go', 'DATABASE_URL = spaced  \n', {}, 'spaced'],
    ['single quotes are taken off', "DATABASE_URL='q v'\n", {}, 'q v'],
    ['a later duplicate wins', 'DATABASE_URL=a\nDATABASE_URL=b\n', {}, 'b'],
    ['CRLF line ends', 'DATABASE_URL=x\r\nOLLAMA_BASE_URL=y\r\n', {}, 'x'],
    ['a leading BOM is dropped', '﻿DATABASE_URL=bom\n', {}, 'bom'],
    ['comments and blank lines', '# c\n\nDATABASE_URL=ind\n', {}, 'ind'],
  ])('.env: %s', ([, text, env, databaseUrl]) => {
    expect(fromFile(text, env).databaseUrl).toBe(databaseUrl)
  })

  test('.env: a double-quoted value spans lines and reads \\n as a newline', () => {
    expect(fromFile('DATABASE_URL="multi\nline"\n').databaseUrl).toBe('multi\nline')
    expect(fromFile('DATABASE_URL="a\\nb"\n').databaseUrl).toBe('a\nb')
  })

  test.for<[string, string]>([
    ['FOO=1\n', 'unknown setting FOO (known: '],
    ['FOO=1\nBar=2\n', 'unknown settings Bar, FOO (known: '],
    ['database_url=q\n', 'unknown setting database_url (known: '],
    ['ANTHROPIC_BASE_URL=http://x\n', 'unknown setting ANTHROPIC_BASE_URL (known: '],
    ['UPLOADS_DIR=data/uploads\n', 'unknown setting UPLOADS_DIR (known: '],
  ])('.env: a non-empty key that is not a setting is an error: %j', ([text, message]) => {
    const envFile = envFileWith(text)

    const run = () => loadSettings({ env: {}, envFile })

    expect(run).toThrow(SettingsError)
    expect(run).toThrow(
      `${envFile}: ${message}DATABASE_URL, OLLAMA_BASE_URL, DEFAULT_PROFILE, ANTHROPIC_API_KEY)`,
    )
  })

  test('.env: the error does not show the value of an unknown key', () => {
    expect(() => fromFile('SECRET_TOKEN=sk-hidden\n')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('sk-hidden') }),
    )
  })

  test('.env: an unknown key with an empty value or no = is ignored', () => {
    expect(fromFile('FOO=\nBAR\nDATABASE_URL=x\n')).toEqual({
      ...DEFAULTS,
      databaseUrl: 'x',
      anthropicApiKey: null,
    })
  })

  test('environment variables that are not settings are ignored', () => {
    expect(fromFile('DATABASE_URL=x\n', { FOO: '1' }).databaseUrl).toBe('x')
  })

  test('getSettings reads .env from the working directory once', () => {
    const cwd = process.cwd()
    const dir = mkdtempSync(join(tmpdir(), 'mokosz-cwd-'))
    writeFileSync(join(dir, '.env'), 'DEFAULT_PROFILE=from-dotenv\n', 'utf8')
    try {
      process.chdir(dir)
      clearSettingsCache()
      expect(getSettings().defaultProfile).toBe('from-dotenv')
      writeFileSync(join(dir, '.env'), 'DEFAULT_PROFILE=changed\n', 'utf8')
      expect(getSettings().defaultProfile).toBe('from-dotenv')
    } finally {
      process.chdir(cwd)
      clearSettingsCache()
    }
  })

  test('uploaded pdfs are not tracked', () => {
    const result = spawnSync('git', ['check-ignore', '--no-index', 'data/uploads/0b5c.pdf'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe('data/uploads/0b5c.pdf')
  })
})
