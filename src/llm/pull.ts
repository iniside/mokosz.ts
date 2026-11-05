import { Agent, fetch } from 'undici'
import { timeoutAgent } from './http.ts'

const VERSION_TIMEOUT_MS = 2000

export class PullError extends Error {
  override name = 'PullError'
}

export async function ollamaReachable(baseUrl: string): Promise<boolean> {
  const dispatcher = timeoutAgent(VERSION_TIMEOUT_MS)
  try {
    const response = await fetch(`${baseUrl}/api/version`, { dispatcher, redirect: 'manual' })
    await response.arrayBuffer()
    return response.status === 200
  } catch {
    return false
  } finally {
    await dispatcher.close()
  }
}

function reason(error: unknown): string {
  const cause: unknown = error instanceof Error ? error.cause : undefined
  if (cause instanceof Error) return cause.message
  return error instanceof Error ? error.message : String(error)
}

function errorField(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('error' in body)) return undefined
  if (body.error === '') return 'empty error'
  return typeof body.error === 'string' ? body.error : JSON.stringify(body.error)
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Pulls one model and waits for the download, however long it takes. */
export async function pullModel(baseUrl: string, model: string): Promise<void> {
  const dispatcher = new Agent({ connectTimeout: 0, headersTimeout: 0, bodyTimeout: 0 })
  let status: number
  let text: string
  try {
    const response = await fetch(`${baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: false }),
      dispatcher,
      redirect: 'manual',
    })
    status = response.status
    text = await response.text()
  } catch (error) {
    throw new PullError(reason(error), { cause: error })
  } finally {
    await dispatcher.close()
  }
  const body = parsed(text)
  const error = errorField(body)
  if (error !== undefined) throw new PullError(error)
  if (status !== 200) throw new PullError(`HTTP ${status}`)
  if (body === undefined) throw new PullError('the answer is not JSON')
}
