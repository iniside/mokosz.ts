import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fetch as undiciFetch, type Dispatcher } from 'undici'
import { timeoutAgent } from '../llm/http.ts'
import { ACTS, LANGUAGES, type Lang } from './acts.ts'

export const CELLAR_URL = 'https://publications.europa.eu/resource/celex/'
const ACCEPT_LANGUAGE = { en: 'eng', pl: 'pol' }
export const TIMEOUT_MS = 60_000
const TIMEOUT_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
])
export const XHTML = 'application/xhtml+xml'

export class FetchError extends Error {
  override readonly name = 'FetchError'
}

export interface FetchInit {
  headers: Record<string, string>
  redirect: 'follow'
  dispatcher: Dispatcher
}

export interface FetchedResponse {
  status: number
  headers: { get(name: string): string | null }
  arrayBuffer(): Promise<ArrayBuffer>
}

export type Fetcher = (url: string, init: FetchInit) => Promise<FetchedResponse>

export interface FetchOptions {
  force?: boolean
  fetch?: Fetcher
  timeoutMs?: number
  report?: (message: string) => void
}

export function rawPath(rawDir: string, celex: string, lang: string): string {
  return join(rawDir, `${celex}.${lang}.xhtml`)
}

function timedOut(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if ('code' in current && typeof current.code === 'string' && TIMEOUT_CODES.has(current.code)) {
      return true
    }
  }
  return false
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  if (timedOut(error)) return 'timed out'
  return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message
}

async function download(
  http: Fetcher,
  dispatcher: Dispatcher,
  celex: string,
  act: string,
  lang: Lang,
): Promise<Uint8Array> {
  const label = `${act} (${celex}) ${lang}`
  let response: FetchedResponse
  let content: Uint8Array
  try {
    response = await http(`${CELLAR_URL}${celex}`, {
      headers: { Accept: XHTML, 'Accept-Language': ACCEPT_LANGUAGE[lang] },
      redirect: 'follow',
      dispatcher,
    })
    content = new Uint8Array(await response.arrayBuffer())
  } catch (error) {
    throw new FetchError(`${label}: request failed: ${describe(error)}`, { cause: error })
  }
  if (response.status !== 200) throw new FetchError(`${label}: HTTP ${response.status}`)
  if (content.length === 0) throw new FetchError(`${label}: empty response body`)
  const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (mediaType !== XHTML) {
    throw new FetchError(`${label}: expected ${XHTML}, got ${mediaType || 'no content type'}`)
  }
  return content
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function fetchActs(rawDir: string, options: FetchOptions = {}): Promise<void> {
  const {
    force = false,
    fetch: http = undiciFetch,
    timeoutMs = TIMEOUT_MS,
    report = () => {},
  } = options
  await mkdir(rawDir, { recursive: true })
  const dispatcher = timeoutAgent(timeoutMs)
  try {
    for (const [celex, act] of ACTS) {
      for (const lang of LANGUAGES) {
        const target = rawPath(rawDir, celex, lang)
        const name = `${celex}.${lang}.xhtml`
        if ((await exists(target)) && !force) {
          report(`skipped ${name}`)
          continue
        }
        const body = await download(http, dispatcher, celex, act, lang)
        const temp = `${target}.tmp`
        try {
          await writeFile(temp, body)
          await rename(temp, target)
        } finally {
          await rm(temp, { force: true })
        }
        report(`fetched ${name} (${body.length} bytes)`)
      }
    }
  } finally {
    await dispatcher.close()
  }
}
