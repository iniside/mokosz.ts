import { get } from 'node:http'
import { vi } from 'vitest'
import { z } from 'zod'
import type { Profile } from '../../src/llm/profiles.ts'
import { ConversationNotFound, MEMORY, RESOURCE_ID } from '../../src/mastra/memory.ts'
import type { StepEventType } from '../../src/mastra/workflows/wrap.ts'
import { frame, KEEPALIVE, PING_INTERVAL_MS, SSE_HEADERS } from '../../src/api/runs.ts'
import { Decimal } from '../../src/decimal.ts'
import {
  appendEvent,
  createConversation,
  finishRun,
  RunConflict,
  startRun,
  type Payload,
  type RunEvent,
  type RunTotals,
} from '../../src/runs/conversations.ts'
import { describe, expect, test as harnessTest } from '../support/harness.ts'
import { serve, StreamingGet, type Served } from './streaming.ts'

const U = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
const RUN = '5b0e1f7c-3d4a-4c8e-9f21-7a6b5c4d3e2f'
const MISSING_CONVERSATION = '00000000-0000-4000-8000-000000000404'
const CONFLICT_CONVERSATION = '00000000-0000-4000-8000-000000000409'
const FAILING_CONVERSATION = '00000000-0000-4000-8000-000000000500'
const AI_14_1 = '32024R1689#014.001'
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const INVALID_UUID = { status: 422, body: { detail: 'Invalid UUID' } }
const NOT_FOUND = { status: 404, body: { detail: 'Not Found' } }
const TEXT = 'text must be a non-empty string'

const STEPS: (RunEvent & { type: StepEventType })[] = [
  { seq: 1, type: 'step_started', payload: { node: 'router' } },
  {
    seq: 2,
    type: 'step_finished',
    payload: { node: 'router', model: 'm', tokens_in: 3, tokens_out: 2, latency_ms: 5 },
  },
  { seq: 3, type: 'step_started', payload: { node: 'retriever' } },
  {
    seq: 4,
    type: 'step_finished',
    payload: { node: 'retriever', model: null, tokens_in: 0, tokens_out: 0, latency_ms: 1 },
  },
]
const FINAL: Payload = {
  lang: 'en',
  not_found: false,
  claims: [{ text: 'Humans oversee.', citations: [AI_14_1] }],
}

// The payload column is jsonb, which stores object keys shortest first, then bytewise.
const WIRE = [
  'event: step_started\ndata: {"node":"router"}\nid: 1\n\n',
  'event: step_finished\ndata: {"node":"router","model":"m","tokens_in":3,"latency_ms":5,"tokens_out":2}\nid: 2\n\n',
  'event: step_started\ndata: {"node":"retriever"}\nid: 3\n\n',
  'event: step_finished\ndata: {"node":"retriever","model":null,"tokens_in":0,"latency_ms":1,"tokens_out":0}\nid: 4\n\n',
  'event: final\ndata: {"lang":"en","claims":[{"text":"Humans oversee.","citations":["32024R1689#014.001"]}],"not_found":false}\nid: 5\n\n',
]
const FAILED_WIRE = [...WIRE.slice(0, 2), 'event: error\ndata: {"message":"boom"}\nid: 3\n\n']

const NO_TOTALS: RunTotals = {
  tokensIn: 0,
  tokensOut: 0,
  costUsd: new Decimal(0),
  latencyMs: 0,
  path: [],
  models: [],
}

const PING_MS = 400

const test = harnessTest.extend(
  'servedApi',
  async ({ seededDatabaseUrl: _, unreachableOllama: __, testSettings }, { onCleanup }) => {
    const served: Served = await serve(testSettings, { pingIntervalMs: PING_MS })
    onCleanup(() => served.close())
    return served
  },
)

async function ensureThread(served: Served, threadId: string): Promise<void> {
  const memory = served.app.state.mastra.getMemory(MEMORY)
  if ((await memory.getThreadById({ threadId })) === null) {
    await memory.createThread({ threadId, resourceId: RESOURCE_ID })
  }
}

async function storedRun(served: Served, steps: number): Promise<string> {
  const memory = served.app.state.mastra.getMemory(MEMORY)
  const { pool } = served.app.state
  const conversationId = await createConversation(memory)
  const runId = await startRun(pool, memory, { conversationId, question: 'q', profile: 'p' })
  for (const event of STEPS.slice(0, steps)) {
    await appendEvent(pool, runId, event.type, event.payload)
  }
  return runId
}

async function finishedRun(served: Served): Promise<string> {
  const runId = await storedRun(served, 4)
  await finishRun(served.app.state.pool, runId, NO_TOTALS, { final: FINAL })
  return runId
}

async function outcome(response: Response): Promise<{ status: number; body: unknown }> {
  expect(response.headers.get('content-type')).toMatch(/^application\/json(;|$)/)
  return { status: response.status, body: await response.json() }
}

/** A GET over node:http, so repeated headers go out as separate lines. */
function rawGet(
  url: string,
  headers: Record<string, string | string[]>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = get(url, { headers }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => (body += chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
      response.on('error', reject)
    })
    request.on('error', reject)
  })
}

async function streamed(served: Served, path: string, headers: Record<string, string> = {}) {
  const response = await served.client.get(path, { headers })
  return {
    status: response.status,
    headers: Object.fromEntries(
      Object.keys(SSE_HEADERS).map((name) => [name, response.headers.get(name)]),
    ),
    body: await response.text(),
  }
}

const seqs = (body: string): number[] =>
  [...body.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]))

function postJson(served: Served, path: string, body: string, contentType?: string) {
  return served.client.post(path, undefined, {
    body,
    headers: contentType === undefined ? {} : { 'content-type': contentType },
  })
}

describe('SSE frames', () => {
  test.for([
    [
      { seq: 1, type: 'step_started', payload: { node: 'router' } },
      'event: step_started\ndata: {"node":"router"}\nid: 1\n\n',
    ],
    [
      { seq: 7, type: 'error', payload: { message: 'line one\nline two' } },
      'event: error\ndata: {"message":"line one\\nline two"}\nid: 7\n\n',
    ],
    [
      { seq: 12, type: 'final', payload: { lang: 'pl', claims: [{ text: 'Zażółć' }] } },
      'event: final\ndata: {"lang":"pl","claims":[{"text":"Zażółć"}]}\nid: 12\n\n',
    ],
  ] as const)('an event is one frame with compact JSON data (%#)', ([event, expected]) => {
    expect(frame(event)).toBe(expected)
  })

  test('the keep-alive comment, its default interval and the headers', () => {
    expect(KEEPALIVE).toBe(': ping\n\n')
    expect(PING_INTERVAL_MS).toBe(15_000)
    expect(SSE_HEADERS).toEqual({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
    })
  })

  test('a finished run streams its stored events and closes', async ({ servedApi }) => {
    const done = await finishedRun(servedApi)
    const failed = await storedRun(servedApi, 2)
    await finishRun(servedApi.app.state.pool, failed, NO_TOTALS, { error: 'boom' })
    const sse = { status: 200, headers: SSE_HEADERS }

    expect(await streamed(servedApi, `/api/runs/${done}/events`)).toEqual({
      ...sse,
      body: WIRE.join(''),
    })
    expect(await streamed(servedApi, `/api/runs/${done}/events?after=3`)).toEqual({
      ...sse,
      body: WIRE.slice(3).join(''),
    })
    expect(await streamed(servedApi, `/api/runs/${done}/events`, { 'Last-Event-ID': '4' })).toEqual(
      { ...sse, body: WIRE.slice(4).join('') },
    )
    expect(await streamed(servedApi, `/api/runs/${failed}/events`)).toEqual({
      ...sse,
      body: FAILED_WIRE.join(''),
    })
  })

  test('a followed run gets a ping while idle and then the rest', async ({ servedApi }) => {
    const { pool, executor } = servedApi.app.state
    const runId = await storedRun(servedApi, 2)
    const stream = new StreamingGet(`${servedApi.url}/api/runs/${runId}/events`)
    stream.start()

    await stream.waitForText(KEEPALIVE.repeat(2))
    for (const event of STEPS.slice(2)) {
      await appendEvent(pool, runId, event.type, event.payload)
      executor.signals.notify(runId)
    }
    await finishRun(pool, runId, NO_TOTALS, { final: FINAL })
    executor.signals.notify(runId)
    await stream.waitEnd()

    expect(stream.status).toBe(200)
    expect(stream.body).toBe([...WIRE.slice(0, 2), KEEPALIVE, KEEPALIVE, ...WIRE.slice(2)].join(''))
  })
})

describe('path UUIDs', () => {
  test.for([
    [U, 200, U],
    [U.toUpperCase(), 200, U],
    ['A0eeBC99-9c0b-4EF8-bb6d-6bb9bd380A11', 200, U],
    [U.replaceAll('-', ''), 422, null],
    [`{${U}}`, 422, null],
    [`urn:uuid:${U}`, 422, null],
    [`${U}%20`, 422, null],
    ['nope', 422, null],
    ['a0eebc99-9c0b-0ef8-0b6d-6bb9bd380a11', 422, null],
  ] as const)('GET /api/conversations/%s is %i', async ([path, status, id], { servedApi }) => {
    await ensureThread(servedApi, U)

    const response = await servedApi.client.get(`/api/conversations/${path}`)

    expect(await outcome(response)).toEqual(
      id === null ? { status, body: INVALID_UUID.body } : { status, body: { id, turns: [] } },
    )
  })

  test('an uppercase id posts to the same conversation', async ({ servedApi }) => {
    const started: string[] = []
    vi.spyOn(servedApi.app.state.executor, 'start').mockImplementation(async (id: string) => {
      started.push(id)
      return RUN
    })

    const response = await servedApi.client.post(`/api/conversations/${U.toUpperCase()}/messages`, {
      text: 'Hi?',
    })

    expect(await outcome(response)).toEqual({ status: 202, body: { run_id: RUN } })
    expect(started).toEqual([U])
  })

  test('an uppercase run id streams the same run', async ({ servedApi }) => {
    const runId = await finishedRun(servedApi)

    const response = await servedApi.client.get(`/api/runs/${runId.toUpperCase()}/events`)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe(WIRE.join(''))
  })

  test.for([
    ['/api/runs/nope/events', INVALID_UUID],
    [`/api/runs/${U.replaceAll('-', '')}/events`, INVALID_UUID],
    ['/api/runs/nope/events?after=x', INVALID_UUID],
    [`/api/runs/${RUN}/events`, { status: 404, body: { detail: 'run not found' } }],
  ] as const)('GET %s', async ([path, expected], { servedApi }) => {
    expect(await outcome(await servedApi.client.get(path))).toEqual(expected)
  })
})

describe('after and Last-Event-ID', () => {
  const AFTER = 'after must be a non-negative integer'
  const LAST = 'Last-Event-ID must be a non-negative integer'

  test.for([
    ['', null, [1, 2, 3, 4, 5]],
    ['?after=0', null, [1, 2, 3, 4, 5]],
    ['?after=3', null, [4, 5]],
    ['?after=5', null, []],
    ['?after=99999999999', null, []],
    ['', '4', [5]],
    ['', '0', [1, 2, 3, 4, 5]],
    ['?after=1', '3', [4, 5]],
    ['?after=4', '2', [5]],
    ['?after=3&after=1', null, [4, 5]],
  ] as const)(
    '%s with Last-Event-ID %s streams %j',
    async ([query, header, ids], { servedApi }) => {
      const runId = await finishedRun(servedApi)
      const headers: Record<string, string> = header === null ? {} : { 'Last-Event-ID': header }

      const response = await servedApi.client.get(`/api/runs/${runId}/events${query}`, { headers })

      expect(response.status).toBe(200)
      expect(seqs(await response.text())).toEqual(ids)
    },
  )

  test.for([
    ['?after=-1', null, AFTER],
    ['?after=1.0', null, AFTER],
    ['?after=%2B1', null, AFTER],
    ['?after=', null, AFTER],
    ['?after=%201', null, AFTER],
    ['?after=x', null, AFTER],
    ['', 'x', LAST],
    ['', '-2', LAST],
    ['?after=x', 'x', AFTER],
  ] as const)('%s with Last-Event-ID %s is 422', async ([query, header, detail], { servedApi }) => {
    const runId = await finishedRun(servedApi)
    const headers: Record<string, string> = header === null ? {} : { 'Last-Event-ID': header }

    const response = await servedApi.client.get(`/api/runs/${runId}/events${query}`, { headers })

    expect(await outcome(response)).toEqual({ status: 422, body: { detail } })
  })
})

function recordStarts(served: Served): [string, string, string][] {
  const started: [string, string, string][] = []
  vi.spyOn(served.app.state.executor, 'start').mockImplementation(
    async (conversationId: string, question: string, profile: Profile) => {
      started.push([conversationId, question, profile.name])
      return RUN
    },
  )
  return started
}

describe('repeated Last-Event-ID', () => {
  test('two Last-Event-ID headers are 422', async ({ servedApi }) => {
    const runId = await finishedRun(servedApi)

    const response = await rawGet(`${servedApi.url}/api/runs/${runId}/events`, {
      'Last-Event-ID': ['2', '3'],
    })

    expect(response).toEqual({
      status: 422,
      body: JSON.stringify({ detail: 'Last-Event-ID must be a non-negative integer' }),
    })
  })
})

describe('message bodies', () => {
  const JSON_TYPE = 'application/json'

  test.for([
    ['{"text": "Hi?"}', JSON_TYPE, 'Hi?', null],
    ['{"text": "  Hi?\\n"}', JSON_TYPE, 'Hi?', null],
    ['{"text": "Hi?", "profile": null}', JSON_TYPE, 'Hi?', null],
    ['{"text": "Hi?", "profile": ""}', JSON_TYPE, 'Hi?', null],
    ['{"text": "Hi?", "profile": "local-qwen"}', JSON_TYPE, 'Hi?', 'local-qwen'],
    ['{"text": "Zażółć?"}', 'application/json; charset=utf-8', 'Zażółć?', null],
    ['{"text": "Hi?"}', 'Application/JSON', 'Hi?', null],
    ['{"text": "Hi?"}', 'application/vnd.api+json', 'Hi?', null],
  ] as const)(
    '%s (%s) starts a run',
    async ([body, contentType, text, profile], { servedApi, testSettings }) => {
      const started = recordStarts(servedApi)

      const response = await postJson(
        servedApi,
        `/api/conversations/${U}/messages`,
        body,
        contentType,
      )

      expect(await outcome(response)).toEqual({ status: 202, body: { run_id: RUN } })
      expect(started).toEqual([[U, text, profile ?? testSettings.defaultProfile]])
    },
  )

  test.for([
    ['{"text": ""}', JSON_TYPE, TEXT],
    ['{"text": "   \\n"}', JSON_TYPE, TEXT],
    ['{}', JSON_TYPE, TEXT],
    ['{"text": 1}', JSON_TYPE, TEXT],
    ['{"text": null}', JSON_TYPE, TEXT],
    ['{"text": "Hi?", "profile": 1}', JSON_TYPE, 'profile must be a string or null'],
    ['{"text": "Hi?", "profile": 1e999}', JSON_TYPE, 'profile must be a string or null'],
    ['{"text": "Hi?", "model": "x"}', JSON_TYPE, 'unknown field: model'],
    ['[]', JSON_TYPE, 'body must be a JSON object'],
    ['null', JSON_TYPE, 'body must be a JSON object'],
    ['"Hi?"', JSON_TYPE, 'body must be a JSON object'],
    ['{"text": NaN}', JSON_TYPE, 'Invalid JSON'],
    ['{"text": "Hi?", "profile": Infinity}', JSON_TYPE, 'Invalid JSON'],
    ['NaN', JSON_TYPE, 'Invalid JSON'],
    ['{"text": "Hi?"', JSON_TYPE, 'Invalid JSON'],
    ['', JSON_TYPE, 'Invalid JSON'],
    ['{"text": "Hi?"}', 'text/plain', 'Content-Type must be application/json'],
    ['{"text": "Hi?"}', undefined, 'Content-Type must be application/json'],
    [
      '{"text": "Hi?"}',
      'application/x-www-form-urlencoded',
      'Content-Type must be application/json',
    ],
    ['{"text": "Hi?"}', 'multipart/form-data', 'Content-Type must be application/json'],
    ['{"text": "Hi?"}', 'application/json-patch', 'Content-Type must be application/json'],
  ] as const)('%s (%s) is 422', async ([body, contentType, detail], { servedApi }) => {
    const started = recordStarts(servedApi)

    const response = await postJson(
      servedApi,
      `/api/conversations/${U}/messages`,
      body,
      contentType,
    )

    expect(await outcome(response)).toEqual({ status: 422, body: { detail } })
    expect(started).toEqual([])
  })

  test('the path id is checked before the body', async ({ servedApi }) => {
    const response = await postJson(servedApi, '/api/conversations/nope/messages', '{', JSON_TYPE)

    expect(await outcome(response)).toEqual(INVALID_UUID)
  })
})

describe('citation lang', () => {
  const LANG = { status: 422, body: { detail: "lang must be 'en' or 'pl'" } }

  test.for([
    ['?lang=en', 'en'],
    ['?lang=pl', 'pl'],
    ['', null],
    ['?lang=', null],
    ['?lang=de', null],
    ['?lang=EN', null],
  ] as const)('%s', async ([query, lang], { servedApi }) => {
    const response = await servedApi.client.get(`/api/citations/32024R1689/014.001${query}`)

    if (lang === null) {
      expect(await outcome(response)).toEqual(LANG)
    } else {
      expect(response.status).toBe(200)
      expect(z.object({ lang: z.string() }).parse(await response.json()).lang).toBe(lang)
    }
  })
})

describe('routing', () => {
  test.for([
    ['POST', '/api/health'],
    ['PUT', '/api/health'],
    ['DELETE', `/api/conversations/${U}`],
    ['PATCH', `/api/conversations/${U}`],
    ['GET', '/api/conversations'],
    ['GET', `/api/conversations/${U}/messages`],
    ['POST', `/api/runs/${RUN}/events`],
  ] as const)('%s %s is a 404 (wrong method)', async ([method, path], { servedApi }) => {
    const response = await servedApi.client.get(path, { method })

    expect(await outcome(response)).toEqual(NOT_FOUND)
  })

  test.for([
    ['GET', '/api/health/'],
    ['GET', `/api/conversations/${U}/`],
    ['POST', '/api/conversations/'],
    ['GET', '/api/nope'],
    ['GET', '/api'],
    ['GET', '/'],
  ] as const)(
    '%s %s is a 404 (trailing slash or unknown)',
    async ([method, path], { servedApi }) => {
      const response = await servedApi.client.get(path, { method, redirect: 'manual' })

      expect(await outcome(response)).toEqual(NOT_FOUND)
    },
  )

  test('HEAD on a running run answers the SSE headers and does not follow it', async ({
    servedApi,
  }) => {
    const runId = await storedRun(servedApi, 2)

    const response = await servedApi.client.get(`/api/runs/${runId}/events`, { method: 'HEAD' })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(SSE_HEADERS['content-type'])
    expect(await response.text()).toBe('')
    expect(servedApi.app.state.executor.signals.listeners(runId)).toBe(0)
  })

  test('HEAD on a GET route is answered like GET, without a body', async ({ servedApi }) => {
    await ensureThread(servedApi, U)

    for (const path of ['/api/health', `/api/conversations/${U}`]) {
      const response = await servedApi.client.get(path, { method: 'HEAD' })

      expect(response.status, path).toBe(200)
      expect(response.headers.get('content-type'), path).toMatch(/^application\/json/)
      expect(await response.text(), path).toBe('')
    }
    const missing = await servedApi.client.get(`/api/conversations/${MISSING_CONVERSATION}`, {
      method: 'HEAD',
    })
    expect(missing.status).toBe(404)
  })
})

describe('response bodies', () => {
  test('a new conversation is 201 with its id and exists afterwards', async ({ servedApi }) => {
    const created = await servedApi.client.post('/api/conversations')

    expect(created.status).toBe(201)
    expect(created.headers.get('content-type')).toMatch(/^application\/json/)
    const { id } = z.strictObject({ id: z.string().regex(UUID_V4) }).parse(await created.json())
    expect(await outcome(await servedApi.client.get(`/api/conversations/${id}`))).toEqual({
      status: 200,
      body: { id, turns: [] },
    })
  })

  test('message outcomes are their status and detail', async ({ servedApi }) => {
    const { client, app } = servedApi
    vi.spyOn(app.state.executor, 'start').mockImplementation(async (conversationId: string) => {
      if (conversationId === MISSING_CONVERSATION) throw new ConversationNotFound(conversationId)
      if (conversationId === CONFLICT_CONVERSATION) throw new RunConflict(conversationId)
      if (conversationId === FAILING_CONVERSATION) throw new Error('executor broke')
      return RUN
    })
    const message = { text: 'Hi?' }
    const post = (id: string, body: object = message) =>
      client.post(`/api/conversations/${id}/messages`, body)

    expect(await outcome(await post(U))).toEqual({ status: 202, body: { run_id: RUN } })
    expect(await outcome(await post(U, { ...message, profile: 'nope' }))).toEqual({
      status: 404,
      body: { detail: 'unknown profile: nope' },
    })
    expect(await outcome(await post(MISSING_CONVERSATION))).toEqual({
      status: 404,
      body: { detail: 'conversation not found' },
    })
    expect(await outcome(await post(CONFLICT_CONVERSATION))).toEqual({
      status: 409,
      body: { detail: 'a run is already active in this conversation' },
    })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const failed = await post(FAILING_CONVERSATION)
      expect(failed.status).toBe(500)
      expect(await failed.text()).toBe('Internal Server Error')
    } finally {
      logged.mockRestore()
    }
  })

  test('a missing conversation is 404 with a detail', async ({ servedApi }) => {
    const response = await servedApi.client.get(`/api/conversations/${MISSING_CONVERSATION}`)

    expect(await outcome(response)).toEqual({
      status: 404,
      body: { detail: 'conversation not found' },
    })
  })

  test('a conversation lists its turns with metrics and citations', async ({ servedApi }) => {
    const memory = servedApi.app.state.mastra.getMemory(MEMORY)
    const { pool } = servedApi.app.state
    const id = await createConversation(memory)
    const runId = await startRun(pool, memory, {
      conversationId: id,
      question: 'What does Art. 14 require?',
      profile: 'local-qwen',
    })
    await finishRun(
      pool,
      runId,
      {
        tokensIn: 3,
        tokensOut: 2,
        costUsd: new Decimal('0.00003'),
        latencyMs: 12,
        path: ['router', 'retriever', 'answerer', 'verifier'],
        models: ['m'],
      },
      { final: FINAL },
    )

    const response = await servedApi.client.get(`/api/conversations/${id}`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      id,
      turns: [
        {
          run_id: runId,
          question: 'What does Art. 14 require?',
          answer: FINAL,
          status: 'done',
          created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
          metrics: {
            path: ['router', 'retriever', 'answerer', 'verifier'],
            models: ['m'],
            tokens_in: 3,
            tokens_out: 2,
            cost_usd: '0.000030',
            latency_ms: 12,
          },
          citations: {
            [AI_14_1]: {
              label: 'AI Act Art. 14(1)',
              act: 'AI Act',
              article: 14,
              heading: 'Human oversight',
            },
          },
        },
      ],
    })
  })

  test('a citation is its key, lang, act, article, heading, label and text', async ({
    servedApi,
  }) => {
    const response = await servedApi.client.get('/api/citations/32024R1689/014.001?lang=en')

    expect(response.status).toBe(200)
    const body = z.record(z.string(), z.unknown()).parse(await response.json())
    expect(Object.keys(body)).toEqual([
      'citation_key',
      'lang',
      'act',
      'article',
      'heading',
      'label',
      'text',
    ])
    expect(body).toMatchObject({
      citation_key: AI_14_1,
      lang: 'en',
      act: 'AI Act',
      article: 14,
      heading: 'Human oversight',
      label: 'AI Act Art. 14(1)',
    })
    expect(String(body.text).startsWith('1. High-risk AI systems')).toBe(true)
  })

  test('an unknown citation is 404 with a detail', async ({ servedApi }) => {
    const response = await servedApi.client.get('/api/citations/32024R1689/999.001?lang=en')

    expect(await outcome(response)).toEqual({ status: 404, body: { detail: 'citation not found' } })
  })
})
