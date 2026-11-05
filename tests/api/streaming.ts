import { setTimeout as sleep } from 'node:timers/promises'
import type { z } from 'zod'
import { startApp, type App, type AppOptions } from '../../src/api/app.ts'
import { listen, type Listening } from '../../src/api/server.ts'
import type { Settings } from '../../src/settings.ts'

export const WAIT_MS = 10_000
const GRACEFUL_MS = 5000

export interface Client {
  get(path: string, init?: RequestInit): Promise<Response>
  post(path: string, json?: unknown, init?: RequestInit): Promise<Response>
}

export interface Served {
  readonly app: App
  readonly listening: Listening
  readonly url: string
  readonly client: Client
  close(): Promise<void>
}

/** The app started and served on an ephemeral loopback port. */
export async function serve(
  settings: Settings,
  options: Omit<AppOptions, 'settings'> = {},
): Promise<Served> {
  const app = await startApp({ host: '127.0.0.1', ...options, settings })
  const listening = await listen(app, '127.0.0.1', 0)
  const { url } = listening
  const client: Client = {
    get: (path, init) => fetch(`${url}${path}`, { signal: AbortSignal.timeout(WAIT_MS), ...init }),
    post: (path, json, init) =>
      fetch(`${url}${path}`, {
        method: 'POST',
        signal: AbortSignal.timeout(WAIT_MS),
        ...(json === undefined
          ? {}
          : { body: JSON.stringify(json), headers: { 'content-type': 'application/json' } }),
        ...init,
      }),
  }
  return { app, listening, url, client, close: () => listening.close(GRACEFUL_MS) }
}

/** A JSON response body, checked against the shape the test reads. */
export async function jsonOf<S extends z.ZodType>(
  response: Response,
  schema: S,
): Promise<z.output<S>> {
  return schema.parse(await response.json())
}

export interface SSE {
  id: number
  event: string
  data: unknown
}

export function parseSse(text: string): SSE[] {
  const events: SSE[] = []
  for (const block of text.replaceAll('\r\n', '\n').split('\n\n')) {
    const fields = new Map<string, string>()
    for (const line of block.split('\n')) {
      if (line === '' || line.startsWith(':')) continue
      const at = line.indexOf(': ')
      fields.set(at < 0 ? line : line.slice(0, at), at < 0 ? '' : line.slice(at + 2))
    }
    if (fields.size > 0) {
      events.push({
        id: Number(fields.get('id')),
        event: String(fields.get('event')),
        data: JSON.parse(String(fields.get('data'))),
      })
    }
  }
  return events
}

/**
 * One GET whose body is seen while it streams, over a real socket, so a disconnect is the client
 * closing its connection.
 */
export class StreamingGet {
  readonly url: string
  readonly headers: Record<string, string>
  status: number | null = null
  body = ''
  ended = false
  readonly #controller = new AbortController()
  #changed = Promise.withResolvers<void>()
  #task: Promise<void> | null = null

  constructor(url: string, headers: Record<string, string> = {}) {
    this.url = url
    this.headers = headers
  }

  start(): void {
    this.#task = this.#drive()
  }

  #notify(): void {
    this.#changed.resolve()
    this.#changed = Promise.withResolvers<void>()
  }

  async #drive(): Promise<void> {
    try {
      const response = await fetch(this.url, {
        headers: this.headers,
        signal: this.#controller.signal,
      })
      this.status = response.status
      this.#notify()
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        this.body += value
        this.#notify()
      }
    } catch (error) {
      if (!this.#controller.signal.aborted) throw error
    } finally {
      this.ended = true
      this.#notify()
    }
  }

  events(): SSE[] {
    return parseSse(this.body)
  }

  async waitFor(count: number): Promise<SSE[]> {
    await this.#until(() => this.events().length >= count)
    return this.events()
  }

  /** Waits until the body holds `text`, for what parseSse skips (a comment). */
  async waitForText(text: string): Promise<string> {
    await this.#until(() => this.body.includes(text))
    return this.body
  }

  async #until(condition: () => boolean): Promise<void> {
    const timeout = deadline()
    try {
      while (!condition() && !this.ended)
        await Promise.race([this.#changed.promise, timeout.expired])
    } finally {
      timeout.cancel()
    }
  }

  async waitEnd(): Promise<SSE[]> {
    if (this.#task === null) throw new Error('the stream was not started')
    await within(this.#task)
    return this.events()
  }

  async disconnect(): Promise<void> {
    this.#controller.abort()
    if (this.#task === null) throw new Error('the stream was not started')
    await within(this.#task)
  }
}

function deadline(): { expired: Promise<never>; cancel(): void } {
  const { promise, reject } = Promise.withResolvers<never>()
  promise.catch(() => {})
  const timer = setTimeout(() => reject(new Error(`not done within ${WAIT_MS} ms`)), WAIT_MS)
  return { expired: promise, cancel: () => clearTimeout(timer) }
}

async function within<T>(pending: Promise<T>): Promise<T> {
  const timeout = deadline()
  try {
    return await Promise.race([pending, timeout.expired])
  } finally {
    timeout.cancel()
  }
}

/** Polls app state that exposes no event to await (listener count, task registry). */
export async function until(condition: () => boolean): Promise<void> {
  const limit = performance.now() + WAIT_MS
  while (!condition()) {
    if (performance.now() > limit) throw new Error(`condition not met within ${WAIT_MS} ms`)
    await sleep(10)
  }
}
