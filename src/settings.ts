import { existsSync, readFileSync, statSync } from 'node:fs'
import { parseEnv } from 'node:util'

const MASK = '**********'

export class SecretStr {
  readonly #value: string

  constructor(value: string) {
    this.#value = value
  }

  reveal(): string {
    return this.#value
  }

  toString(): string {
    return MASK
  }

  toJSON(): string {
    return MASK
  }
}

export interface Settings {
  databaseUrl: string
  ollamaBaseUrl: string
  defaultProfile: string
  anthropicApiKey: SecretStr | null
  uploadsDir: string
  /** Read from the process environment only, never from the .env file. */
  anthropicApiBase: string
}

const DEFAULTS = {
  databaseUrl: 'postgresql://mokosz:mokosz@localhost:5433/mokosz',
  ollamaBaseUrl: 'http://localhost:11434',
  defaultProfile: 'local-qwen',
  uploadsDir: 'data/uploads',
  anthropicApiBase: 'https://api.anthropic.com',
}

type Source = Record<string, string | undefined>

const NAMES = [
  'DATABASE_URL',
  'OLLAMA_BASE_URL',
  'DEFAULT_PROFILE',
  'ANTHROPIC_API_KEY',
  'UPLOADS_DIR',
] as const
type Name = (typeof NAMES)[number]

export class SettingsError extends Error {
  override name = 'SettingsError'
}

const isName = (key: string): key is Name => (NAMES as readonly string[]).includes(key)

function readEnvFile(path: string): Partial<Record<Name, string>> {
  if (!existsSync(path) || !statSync(path).isFile()) return {}
  const entries = Object.entries(parseEnv(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')))
  const unknown = entries
    .filter(([key, value]) => !isName(key) && value !== '')
    .map(([key]) => key)
    .toSorted()
  if (unknown.length > 0) {
    throw new SettingsError(
      `${path}: unknown setting${unknown.length === 1 ? '' : 's'} ${unknown.join(', ')} ` +
        `(known: ${NAMES.join(', ')})`,
    )
  }
  return Object.fromEntries(entries.filter(([key]) => isName(key)))
}

/**
 * Environment variables win over the .env file, which wins over the defaults. Names are exact
 * and upper-case; a non-empty key in the file that is not a setting is an error.
 */
export function loadSettings(options: { env?: Source; envFile?: string | null } = {}): Settings {
  const { env = process.env, envFile = '.env' } = options
  const file = envFile === null ? {} : readEnvFile(envFile)
  const value = (name: Name): string | undefined => env[name] ?? file[name]
  const apiKey = value('ANTHROPIC_API_KEY')
  return {
    databaseUrl: value('DATABASE_URL') ?? DEFAULTS.databaseUrl,
    ollamaBaseUrl: value('OLLAMA_BASE_URL') ?? DEFAULTS.ollamaBaseUrl,
    defaultProfile: value('DEFAULT_PROFILE') ?? DEFAULTS.defaultProfile,
    anthropicApiKey: apiKey === undefined ? null : new SecretStr(apiKey),
    uploadsDir: value('UPLOADS_DIR') ?? DEFAULTS.uploadsDir,
    anthropicApiBase: env.ANTHROPIC_API_BASE || env.ANTHROPIC_BASE_URL || DEFAULTS.anthropicApiBase,
  }
}

let cached: Settings | null = null

export function getSettings(): Settings {
  cached ??= loadSettings()
  return cached
}

export function clearSettingsCache(): void {
  cached = null
}
