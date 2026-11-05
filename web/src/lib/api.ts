export type Lang = 'en' | 'pl'
export type RunStatus = 'running' | 'done' | 'failed'
export type NodeName = 'router' | 'retriever' | 'answerer' | 'verifier'

export interface Claim {
  text: string
  citations: string[]
}

export interface Answer {
  lang: Lang
  not_found: boolean
  claims: Claim[]
}

export interface TurnMetrics {
  path: NodeName[]
  models: string[]
  tokens_in: number
  tokens_out: number
  cost_usd: string
  latency_ms: number | null
}

export interface CitationRef {
  label: string
  act: string
  article: number | null
  heading: string | null
}

export interface Turn {
  run_id: string
  question: string
  answer: Answer | null
  status: RunStatus
  created_at: string
  metrics: TurnMetrics
  citations: Record<string, CitationRef>
}

export interface Conversation {
  id: string
  turns: Turn[]
}

export interface CitationText {
  citation_key: string
  lang: Lang
  act: string
  article: number | null
  heading: string | null
  label: string
  text: string
}

export interface StepStarted {
  node: NodeName
}

export interface StepFinished {
  node: NodeName
  model: string | null
  tokens_in: number
  tokens_out: number
  latency_ms: number
}

export interface RunError {
  message: string
}

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }

  get unreachable(): boolean {
    return this.status === 0 || this.status === 502 || this.status === 503 || this.status === 504
  }
}

async function detail(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json()
    if (body && typeof body === 'object' && 'detail' in body && typeof body.detail === 'string') {
      return body.detail
    }
  } catch {
    // Non-JSON error bodies (proxy errors) fall through to the status text.
  }
  return response.statusText || `HTTP ${response.status}`
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      headers: { Accept: 'application/json', ...init?.headers },
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiError(0, 'The API is unreachable.')
  }
  if (!response.ok) {
    // The Vite dev proxy answers 500 with an empty body when the API is down.
    const status =
      response.status === 500 && !response.headers.get('content-type') ? 502 : response.status
    throw new ApiError(status, await detail(response))
  }
  return (await response.json()) as T
}

export function createConversation(): Promise<{ id: string }> {
  return request('/api/conversations', { method: 'POST' })
}

export function getConversation(id: string, signal?: AbortSignal): Promise<Conversation> {
  return request(`/api/conversations/${encodeURIComponent(id)}`, { signal })
}

export function postMessage(conversationId: string, text: string): Promise<{ run_id: string }> {
  return request(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
}

export function getCitation(key: string, lang: Lang, signal?: AbortSignal): Promise<CitationText> {
  const [celex, elementId] = splitKey(key)
  return request(
    `/api/citations/${encodeURIComponent(celex)}/${encodeURIComponent(elementId)}?lang=${lang}`,
    { signal },
  )
}

export function splitKey(key: string): [string, string] {
  const at = key.indexOf('#')
  return at < 0 ? [key, ''] : [key.slice(0, at), key.slice(at + 1)]
}

export function runEventsUrl(runId: string, after = 0): string {
  const url = `/api/runs/${encodeURIComponent(runId)}/events`
  return after > 0 ? `${url}?after=${after}` : url
}

export async function fetchRunError(runId: string, signal?: AbortSignal): Promise<string | null> {
  const response = await fetch(runEventsUrl(runId), { signal })
  if (!response.ok) return null
  const text = await response.text()
  let message: string | null = null
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/)
    if (!lines.includes('event: error')) continue
    const data = lines.find((line) => line.startsWith('data:'))
    if (data) message = (JSON.parse(data.slice(5)) as RunError).message
  }
  return message
}
