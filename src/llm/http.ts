import { AISDKError, APICallError } from 'ai'
import { Agent, fetch as undiciFetch } from 'undici'
import { oneLine } from '../text.ts'

export type JsonBody = Record<string, unknown>

// One dispatcher per timeout; the timeout applies to the connect, the headers and the body.
const agents = new Map<number, Agent>()

function agent(timeoutMs: number): Agent {
  let found = agents.get(timeoutMs)
  if (found === undefined) {
    found = new Agent({
      connectTimeout: timeoutMs,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    })
    agents.set(timeoutMs, found)
  }
  return found
}

/** The provider `fetch`: the profile timeout, and the JSON body rewritten where the provider differs. */
export function httpClient(timeoutMs: number, rewrite?: (body: JsonBody) => void): typeof fetch {
  const dispatcher = agent(timeoutMs)
  return async (input, init) => {
    if (typeof init?.body !== 'string') throw new TypeError('the request has no JSON body')
    if (input instanceof Request) throw new TypeError('the request is not a URL')
    let body = init.body
    if (rewrite !== undefined) {
      const json: JsonBody = JSON.parse(body)
      rewrite(json)
      body = JSON.stringify(json)
    }
    return await undiciFetch(input, {
      method: init.method,
      headers: Object.fromEntries(new Headers(init.headers)),
      signal: init.signal,
      body,
      dispatcher,
    })
  }
}

/** An AI SDK error on one line: its name, its message, the root cause and the response body. */
export function describe(error: AISDKError): string {
  const body = APICallError.isInstance(error) ? error.responseBody : undefined
  let root: unknown = error
  while (root instanceof Error && root.cause instanceof Error) root = root.cause
  const cause = root instanceof Error && !error.message.includes(root.message) ? root.message : ''
  const text = `${error.name}: ${error.message}${cause ? `: ${cause}` : ''}${body ? ` - ${body}` : ''}`
  return oneLine(text)
}
