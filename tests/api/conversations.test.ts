import { Client, DatabaseError } from 'pg'
import { vi } from 'vitest'
import { MEMORY } from '../../src/mastra/memory.ts'
import { conversationMessages } from '../../src/mastra/workflows/qa.ts'
import { SHUTDOWN } from '../../src/runs/executor.ts'
import * as conversations from '../../src/runs/conversations.ts'
import { INTERRUPTED } from '../../src/runs/conversations.ts'
import { Decimal } from '../../src/decimal.ts'
import { describe, expect, test as harnessTest } from '../support/harness.ts'
import { scriptedLlmFixture, type CallOptions, type ScriptedLLM } from '../llm/scripted.ts'
import { z } from 'zod'
import { ai14Vector, AI_14_1, Flag, GatedEmbedder } from './gated-embedder.ts'
import {
  jsonOf,
  parseSse,
  serve,
  StreamingGet,
  until,
  WAIT_MS,
  type Client as ApiClient,
  type Served,
  type SSE,
} from './streaming.ts'

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined
}

type Store = typeof import('../../src/runs/conversations.ts')
type Embed = GatedEmbedder['embed']

const hooks = vi.hoisted(() => ({
  embed: null as Embed | null,
  eventsAfter: null as Store['eventsAfter'] | null,
  finishRun: null as Store['finishRun'] | null,
}))

vi.mock('ollama-ai-provider-v2', async (importOriginal) => {
  const real = await importOriginal<typeof import('ollama-ai-provider-v2')>()
  const { scripted } = await import('../llm/scripted.ts')
  return { ...real, createOllama: scripted(real.createOllama, 'ollama.responses') }
})
vi.mock('../../src/retrieval/embeddings.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/retrieval/embeddings.ts')>()
  return {
    ...real,
    embedQuery: (text: string, options?: { abortSignal?: AbortSignal }) => {
      if (hooks.embed === null) throw new Error('the test has no embedder')
      return hooks.embed(text, options)
    },
  }
})
vi.mock('../../src/runs/conversations.ts', async (importOriginal) => {
  const real = await importOriginal<Store>()
  return {
    ...real,
    eventsAfter: (...args: Parameters<Store['eventsAfter']>) =>
      (hooks.eventsAfter ?? real.eventsAfter)(...args),
    finishRun: (...args: Parameters<Store['finishRun']>) =>
      (hooks.finishRun ?? real.finishRun)(...args),
  }
})

const actual = await vi.importActual<Store>('../../src/runs/conversations.ts')

const MODEL = 'ollama_chat/qwen3.6:27b'
const NODES = ['router', 'retriever', 'answerer', 'verifier']
const QUESTION = 'What does Article 14 of the AI Act require?'
const STANDALONE = 'What does AI Act Article 14 require?'
const CLAIM = 'Humans must be able to oversee high-risk AI.'
const NOT_RETRIEVED = '32024R1689#099.009'

class RuntimeError extends Error {
  override name = 'RuntimeError'
}

const test = harnessTest
  .extend('scriptedLlm', ({}, fixture): ScriptedLLM => scriptedLlmFixture({}, fixture))
  .extend('gatedEmbedder', async ({ seededDatabaseUrl }, { onCleanup }) => {
    const fake = new GatedEmbedder(await ai14Vector(seededDatabaseUrl))
    hooks.embed = fake.embed
    onCleanup(() => {
      hooks.embed = null
    })
    return fake
  })
  .extend(
    'servedApi',
    async ({ unreachableOllama: _, testSettings, gatedEmbedder: __ }, { onCleanup }) => {
      const served = await serve(testSettings)
      onCleanup(() => served.close())
      return served
    },
  )

const TurnSchema = z.object({
  run_id: z.string(),
  question: z.string(),
  answer: z.unknown(),
  status: z.string(),
  metrics: z.object({
    path: z.array(z.string()),
    models: z.array(z.string()),
    tokens_in: z.int(),
    tokens_out: z.int(),
    cost_usd: z.string(),
    latency_ms: z.int().nullable(),
  }),
  citations: z.record(z.string(), z.unknown()),
})
type Turn = z.output<typeof TurnSchema>
const ConversationSchema = z.object({ id: z.string(), turns: z.array(TurnSchema) })

function scriptTurn(script: ScriptedLLM, ...answers: object[]): void {
  script.queue('router', {
    lang: 'en',
    acts: ['AI Act'],
    article_refs: [{ act: 'AI Act', article: 14 }],
    query: STANDALONE,
  })
  script.queue('answerer', ...(answers.length > 0 ? answers : [answer(AI_14_1)]))
}

function answer(...keys: string[]): object {
  return { claims: [{ text: CLAIM, citations: keys }], not_found: false }
}

function scriptRouterOnly(script: ScriptedLLM): void {
  script.queue('router', { lang: 'en', acts: ['AI Act'], article_refs: [], query: STANDALONE })
}

async function newConversation(client: ApiClient): Promise<string> {
  const response = await client.post('/api/conversations')
  expect(response.status).toBe(201)
  return (await jsonOf(response, z.object({ id: z.string() }))).id
}

async function ask(client: ApiClient, conversationId: string, text = QUESTION): Promise<string> {
  const response = await client.post(`/api/conversations/${conversationId}/messages`, { text })
  expect(response.status, await response.clone().text()).toBe(202)
  return (await jsonOf(response, z.object({ run_id: z.string() }))).run_id
}

async function events(
  client: ApiClient,
  runId: string,
  options: { params?: Record<string, string>; headers?: Record<string, string> } = {},
): Promise<SSE[]> {
  const query =
    options.params === undefined ? '' : `?${new URLSearchParams(options.params).toString()}`
  const response = await client.get(`/api/runs/${runId}/events${query}`, {
    headers: options.headers ?? {},
  })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/)
  return parseSse(await response.text())
}

async function withClient<T>(
  databaseUrl: string,
  work: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    return await work(client)
  } finally {
    await client.end()
  }
}

async function storedEvents(
  databaseUrl: string,
  runId: string,
): Promise<[number, string, unknown][]> {
  return withClient(databaseUrl, async (client) => {
    const { rows } = await client.query<{ seq: number; type: string; payload: unknown }>(
      'SELECT seq, type, payload FROM run_events WHERE run_id = $1 ORDER BY seq',
      [runId],
    )
    return rows.map((row) => [row.seq, row.type, row.payload])
  })
}

interface RunRow {
  status: string
  error: string | null
  tokens_in: number
  tokens_out: number
  latency_ms: number | null
  path: string[]
  models: string[]
}

async function runRow(databaseUrl: string, runId: string): Promise<RunRow> {
  return withClient(databaseUrl, async (client) => {
    const { rows } = await client.query<RunRow>(
      'SELECT status, error, tokens_in, tokens_out, latency_ms, path, models FROM runs WHERE id = $1',
      [runId],
    )
    expect(rows).toHaveLength(1)
    return rows[0]!
  })
}

function asWire(stored: [number, string, unknown][]): SSE[] {
  return stored.map(([id, event, payload]) => ({ id, event, data: payload }))
}

function data(event: SSE | undefined): Record<string, unknown> {
  const value = record(event?.data)
  if (value === undefined) throw new Error(`event ${JSON.stringify(event)} has no object data`)
  return value
}

function finishedTokens(stream: SSE[]): [number, number] {
  const steps = stream.filter((e) => e.event === 'step_finished').map(data)
  return [
    steps.reduce((sum, s) => sum + Number(s.tokens_in), 0),
    steps.reduce((sum, s) => sum + Number(s.tokens_out), 0),
  ]
}

function nodeOf(call: CallOptions): unknown {
  return record(call.providerOptions?.mokosz)?.node
}

function userText(call: CallOptions): string {
  const user = call.prompt[1]
  if (user?.role !== 'user') throw new Error('the second message is not the user request')
  return user.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
}

/** The answerer's model call waits until released. */
function holdAnswerer(script: ScriptedLLM): [Flag, Flag] {
  const called = new Flag()
  const release = new Flag()
  const model = script.model.bind(script)
  script.model = (provider, modelId) => {
    const mock = model(provider, modelId)
    const generate = mock.doGenerate.bind(mock)
    mock.doGenerate = async (options) => {
      if (nodeOf(options) === 'answerer') {
        called.set()
        await release.wait()
      }
      return generate(options)
    }
    return mock
  }
  return [called, release]
}

async function turnsOf(client: ApiClient, conversationId: string): Promise<Turn[]> {
  const response = await client.get(`/api/conversations/${conversationId}`)
  return (await jsonOf(response, ConversationSchema)).turns
}

async function within<T>(pending: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`not done within ${WAIT_MS} ms`)), WAIT_MS)
  })
  try {
    return await Promise.race([pending, timeout])
  } finally {
    clearTimeout(timer)
  }
}

describe('conversations API', () => {
  test('a message runs a turn whose events end with final', async ({
    servedApi: { client },
    scriptedLlm,
    seededDatabaseUrl,
  }) => {
    const conversationId = await newConversation(client)
    scriptTurn(scriptedLlm)

    const runId = await ask(client, conversationId)
    const stream = await events(client, runId)

    expect(stream.map((e) => e.id)).toEqual(stream.map((_, index) => index + 1))
    expect(stream.slice(0, -1).map((e) => [e.event, data(e).node])).toEqual(
      NODES.flatMap((node) => [
        ['step_started', node],
        ['step_finished', node],
      ]),
    )
    expect(stream.at(-1)?.event).toBe('final')
    expect(stream.at(-1)?.data).toEqual({
      lang: 'en',
      not_found: false,
      claims: [{ text: CLAIM, citations: [AI_14_1] }],
    })
    expect(stream).toEqual(asWire(await storedEvents(seededDatabaseUrl, runId)))
    expect(scriptedLlm.calls).toHaveLength(2)
    const [routerCall] = scriptedLlm.calls
    expect(userText(routerCall!).endsWith(`New message:\n${QUESTION}`)).toBe(true)
  })

  test('turns carry question, answer, metrics and citations', async ({
    servedApi: { app, client },
    scriptedLlm,
  }) => {
    const conversationId = await newConversation(client)
    scriptTurn(scriptedLlm)
    const runId = await ask(client, conversationId, `  ${QUESTION}  `)
    const stream = await events(client, runId)

    const response = await client.get(`/api/conversations/${conversationId}`)

    expect(response.status).toBe(200)
    expect(await conversationMessages(app.state.mastra.getMemory(MEMORY), conversationId)).toEqual([
      { role: 'user', text: QUESTION },
      { role: 'assistant', text: CLAIM },
    ])
    const body = await jsonOf(response, ConversationSchema)
    expect(body.id).toBe(conversationId)
    expect(body.turns).toHaveLength(1)
    const [turn] = body.turns
    expect(turn!.run_id).toBe(runId)
    expect(turn!.question).toBe(QUESTION)
    expect(turn!.status).toBe('done')
    expect(turn!.answer).toEqual(stream.at(-1)?.data)
    const { metrics } = turn!
    expect(metrics.path).toEqual(NODES)
    expect(metrics.models).toEqual([MODEL])
    const [tokensIn, tokensOut] = finishedTokens(stream)
    expect(tokensIn > 0 && tokensOut > 0).toBe(true)
    expect([metrics.tokens_in, metrics.tokens_out]).toEqual([tokensIn, tokensOut])
    expect(new Decimal(metrics.cost_usd).isZero()).toBe(true)
    expect(metrics.latency_ms).toBeGreaterThan(0)
    expect(turn!.citations).toEqual({
      [AI_14_1]: {
        label: 'AI Act Art. 14(1)',
        act: 'AI Act',
        article: 14,
        heading: 'Human oversight',
      },
    })
  })

  test('two failed verifications finish with the not-found answer', async ({
    servedApi: { client },
    scriptedLlm,
  }) => {
    const conversationId = await newConversation(client)
    scriptTurn(scriptedLlm, answer(NOT_RETRIEVED), answer(NOT_RETRIEVED))

    const stream = await events(client, await ask(client, conversationId))

    expect(stream.filter((e) => e.event === 'step_started').map((e) => data(e).node)).toEqual([
      ...NODES,
      'answerer',
      'verifier',
    ])
    expect([stream.at(-1)?.event, stream.at(-1)?.data]).toEqual([
      'final',
      { lang: 'en', not_found: true, claims: [] },
    ])
  })

  test('a second message while running is 409', async ({
    servedApi: { client },
    scriptedLlm,
    gatedEmbedder,
  }) => {
    gatedEmbedder.gated = true
    const conversationId = await newConversation(client)
    scriptTurn(scriptedLlm)
    const runId = await ask(client, conversationId)
    await within(gatedEmbedder.entered.wait())

    const response = await client.post(`/api/conversations/${conversationId}/messages`, {
      text: 'And art. 26?',
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      detail: 'a run is already active in this conversation',
    })
    gatedEmbedder.release.set()
    expect((await events(client, runId)).at(-1)?.event).toBe('final')
    const turns = await turnsOf(client, conversationId)
    expect(turns.map((t) => t.run_id)).toEqual([runId])
  })

  test('unknown conversation, profile and run are 404', async ({ servedApi: { client } }) => {
    const missing = crypto.randomUUID()
    const conversationId = await newConversation(client)

    expect((await client.get(`/api/conversations/${missing}`)).status).toBe(404)
    let response = await client.post(`/api/conversations/${missing}/messages`, { text: 'Hi?' })
    expect(response.status).toBe(404)
    response = await client.post(`/api/conversations/${conversationId}/messages`, {
      text: 'Hi?',
      profile: 'nope',
    })
    expect(response.status).toBe(404)
    expect(await turnsOf(client, conversationId)).toEqual([])
    expect((await client.get(`/api/runs/${missing}/events`)).status).toBe(404)
  })

  test('empty text and unknown fields are 422', async ({ servedApi: { client } }) => {
    const conversationId = await newConversation(client)
    const url = `/api/conversations/${conversationId}/messages`

    for (const body of [{ text: '' }, { text: '   \n' }, {}, { text: 'Hi?', model: 'x' }]) {
      expect((await client.post(url, body)).status, JSON.stringify(body)).toBe(422)
    }
    expect(await turnsOf(client, conversationId)).toEqual([])
  })

  test('a late stream replays everything and closes', async ({
    servedApi: { client },
    scriptedLlm,
    seededDatabaseUrl,
  }) => {
    scriptTurn(scriptedLlm)
    const runId = await ask(client, await newConversation(client))
    const first = await events(client, runId)

    const replay = await events(client, runId)
    const tail = await events(client, runId, { params: { after: '3' } })

    expect(replay).toEqual(first)
    expect(first).toEqual(asWire(await storedEvents(seededDatabaseUrl, runId)))
    expect(tail).toEqual(first.slice(3))
  })

  test('a reconnect after the last event closes at once', async ({
    servedApi: { client },
    scriptedLlm,
  }) => {
    scriptTurn(scriptedLlm)
    const runId = await ask(client, await newConversation(client))
    const last = (await events(client, runId)).at(-1)!.id

    expect(await events(client, runId, { headers: { 'Last-Event-ID': String(last) } })).toEqual([])
    expect(await events(client, runId, { params: { after: String(last) } })).toEqual([])
    const resumed = await events(client, runId, { headers: { 'Last-Event-ID': String(last - 1) } })
    expect(resumed.map((e) => e.id)).toEqual([last])
  })

  test('a stream opened mid-run gets every event once', async ({
    servedApi: { client, url },
    scriptedLlm,
    gatedEmbedder,
    seededDatabaseUrl,
  }) => {
    gatedEmbedder.gated = true
    const [answererCalled, answererRelease] = holdAnswerer(scriptedLlm)
    scriptTurn(scriptedLlm)
    const runId = await ask(client, await newConversation(client))
    await within(gatedEmbedder.entered.wait())
    const stream = new StreamingGet(`${url}/api/runs/${runId}/events`)
    stream.start()

    const before = await stream.waitFor(3)
    expect(before.map((e) => [e.id, e.event])).toEqual([
      [1, 'step_started'],
      [2, 'step_finished'],
      [3, 'step_started'],
    ])
    expect(stream.ended).toBe(false)
    gatedEmbedder.release.set()
    await within(answererCalled.wait())
    const whileRunning = await stream.waitFor(5)
    expect(whileRunning.slice(3).map((e) => [e.id, e.event, data(e).node])).toEqual([
      [4, 'step_finished', 'retriever'],
      [5, 'step_started', 'answerer'],
    ])
    expect(stream.ended).toBe(false)
    answererRelease.set()
    const received = await stream.waitEnd()

    expect(stream.status).toBe(200)
    expect(received).toEqual(asWire(await storedEvents(seededDatabaseUrl, runId)))
    expect(received.at(-1)?.event).toBe('final')
  })

  test('events committed before the listener or between reads are not lost', async ({
    servedApi: { app, client, url },
    scriptedLlm,
    gatedEmbedder,
    seededDatabaseUrl,
    onTestFinished,
  }) => {
    gatedEmbedder.gated = true
    const [answererCalled, answererRelease] = holdAnswerer(scriptedLlm)
    scriptTurn(scriptedLlm)
    const runId = await ask(client, await newConversation(client))
    await within(gatedEmbedder.entered.wait())
    let reads = 0
    hooks.eventsAfter = async (db, run, after, options) => {
      reads += 1
      const batch = await actual.eventsAfter(db, run, after, options)
      if (reads === 1) {
        // Seq 4 and 5 are committed and notified before the stream has a listener.
        gatedEmbedder.release.set()
        await answererCalled.wait()
      } else if (reads === 2) {
        // Committed and notified after this read; the stale batch must not hide it.
        await actual.appendEvent(app.state.pool, run, 'step_started', { node: 'probe' })
        app.state.executor.signals.notify(run)
      }
      return batch
    }
    onTestFinished(() => {
      hooks.eventsAfter = null
    })
    const stream = new StreamingGet(`${url}/api/runs/${runId}/events`)
    stream.start()

    const seen = await stream.waitFor(6)
    expect(seen.slice(3).map((e) => [e.id, e.event, data(e).node])).toEqual([
      [4, 'step_finished', 'retriever'],
      [5, 'step_started', 'answerer'],
      [6, 'step_started', 'probe'],
    ])
    expect(stream.ended).toBe(false)
    answererRelease.set()
    const received = await stream.waitEnd()

    expect(received).toEqual(asWire(await storedEvents(seededDatabaseUrl, runId)))
    expect(received.at(-1)?.event).toBe('final')
  })

  test('a stream resumed mid-run skips what it saw', async ({
    servedApi: { client, url },
    scriptedLlm,
    gatedEmbedder,
    seededDatabaseUrl,
  }) => {
    gatedEmbedder.gated = true
    scriptTurn(scriptedLlm)
    const runId = await ask(client, await newConversation(client))
    await within(gatedEmbedder.entered.wait())
    const stream = new StreamingGet(`${url}/api/runs/${runId}/events`, { 'Last-Event-ID': '2' })
    stream.start()

    expect((await stream.waitFor(1)).map((e) => e.id)).toEqual([3])
    gatedEmbedder.release.set()
    const received = await stream.waitEnd()

    expect(received).toEqual(asWire(await storedEvents(seededDatabaseUrl, runId)).slice(2))
  })

  test('a disconnected stream does not cancel the run', async ({
    servedApi: { app, client, url },
    scriptedLlm,
    gatedEmbedder,
    seededDatabaseUrl,
  }) => {
    gatedEmbedder.gated = true
    scriptTurn(scriptedLlm)
    const runId = await ask(client, await newConversation(client))
    await within(gatedEmbedder.entered.wait())
    const stream = new StreamingGet(`${url}/api/runs/${runId}/events`)
    stream.start()
    await stream.waitFor(3)
    const { signals } = app.state.executor
    await until(() => signals.listeners(runId) === 1)

    await stream.disconnect()

    // The server sees the closed socket on its own schedule, not when the client's task ends.
    await until(() => signals.listeners(runId) === 0)
    const task = app.state.executor.tasks.get(runId)
    expect(task).toBeDefined()
    let done = false
    void task!.done.finally(() => {
      done = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(done).toBe(false)
    expect(task!.controller.signal.aborted).toBe(false)
    gatedEmbedder.release.set()
    await within(task!.done)
    const row = await runRow(seededDatabaseUrl, runId)
    expect(row.status).toBe('done')
    expect((await storedEvents(seededDatabaseUrl, runId)).at(-1)?.[1]).toBe('final')
  })

  test('a graph exception fails the run with the usage so far', async ({
    servedApi: { client },
    scriptedLlm,
    gatedEmbedder,
    seededDatabaseUrl,
  }) => {
    gatedEmbedder.error = new RuntimeError('embedder down')
    scriptRouterOnly(scriptedLlm)
    const conversationId = await newConversation(client)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    let stream: SSE[]
    let runId: string
    let errors: unknown[][]
    try {
      runId = await ask(client, conversationId)
      stream = await events(client, runId)
    } finally {
      errors = [...logged.mock.calls]
      logged.mockRestore()
    }

    expect(stream.map((e) => [e.event, record(e.data)?.node ?? null])).toEqual([
      ['step_started', 'router'],
      ['step_finished', 'router'],
      ['step_started', 'retriever'],
      ['error', null],
    ])
    expect(stream.at(-1)?.data).toEqual({ message: 'RuntimeError: embedder down' })
    expect(errors.filter(([text]) => text === `run ${runId} failed`)).toHaveLength(1)
    const routerFinished = data(stream[1])
    expect(Number(routerFinished.tokens_in)).toBeGreaterThan(0)
    const turns = await turnsOf(client, conversationId)
    expect(turns).toHaveLength(1)
    const [turn] = turns
    expect(turn!.status).toBe('failed')
    expect(turn!.answer).toBeNull()
    const { metrics } = turn!
    expect([metrics.tokens_in, metrics.tokens_out]).toEqual([
      routerFinished.tokens_in,
      routerFinished.tokens_out,
    ])
    expect(metrics.path).toEqual(['router', 'retriever'])
    expect(metrics.models).toEqual([MODEL])
    expect(metrics.latency_ms).toBeGreaterThan(0)
    const row = await runRow(seededDatabaseUrl, turn!.run_id)
    expect(row.error).toBe('RuntimeError: embedder down')
  })

  test('startup fails a stale running run with its error event', async ({
    testSettings,
    unreachableOllama: _,
    seededDatabaseUrl,
  }) => {
    const first = await serve(testSettings)
    let conversationId: string
    let stale: string
    try {
      const memory = first.app.state.mastra.getMemory(MEMORY)
      conversationId = await conversations.createConversation(memory)
      stale = await conversations.startRun(first.app.state.pool, memory, {
        conversationId,
        question: QUESTION,
        profile: 'local-qwen',
      })
      await conversations.appendEvent(first.app.state.pool, stale, 'step_started', {
        node: 'router',
      })
    } finally {
      await first.close()
    }

    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let served: Served
    let warnings: unknown[][]
    try {
      served = await serve(testSettings)
    } finally {
      warnings = [...warned.mock.calls]
      warned.mockRestore()
    }
    let stream: SSE[]
    let turns: Turn[]
    try {
      stream = await events(served.client, stale)
      turns = await turnsOf(served.client, conversationId)
    } finally {
      await served.close()
    }

    expect(
      warnings.some(([text]) => /^marked \d+ interrupted runs as failed$/.test(String(text))),
    ).toBe(true)
    expect(stream.map((e) => [e.id, e.event, e.data])).toEqual([
      [1, 'step_started', { node: 'router' }],
      [2, 'error', { message: INTERRUPTED }],
    ])
    expect(turns.map((t) => t.status)).toEqual(['failed'])
    expect((await runRow(seededDatabaseUrl, stale)).error).toBe(INTERRUPTED)
  })

  test('shutdown fails a running run with its error event', async ({
    testSettings,
    unreachableOllama: _,
    scriptedLlm,
    gatedEmbedder,
    seededDatabaseUrl,
  }) => {
    gatedEmbedder.gated = true
    scriptRouterOnly(scriptedLlm)
    const served = await serve(testSettings)
    let task
    let runId: string
    try {
      runId = await ask(served.client, await newConversation(served.client))
      await within(gatedEmbedder.entered.wait())
      task = served.app.state.executor.tasks.get(runId)

      await served.app.state.executor.shutdown()

      // Shutdown returns only once its runs are finished.
      expect(served.app.state.executor.tasks.size).toBe(0)
      expect((await storedEvents(seededDatabaseUrl, runId)).at(-1)?.[1]).toBe('error')
    } finally {
      await served.close()
    }

    expect(task?.controller.signal.aborted).toBe(true)
    expect(served.app.state.executor.tasks.size).toBe(0)
    const stored = await storedEvents(seededDatabaseUrl, runId)
    expect(stored.map(([, kind]) => kind)).toEqual([
      'step_started',
      'step_finished',
      'step_started',
      'error',
    ])
    expect(stored.at(-1)?.[2]).toEqual({ message: SHUTDOWN })
    const row = await runRow(seededDatabaseUrl, runId)
    expect(row.status).toBe('failed')
    expect(row.error).toBe(SHUTDOWN)
    const routerTokens = record(stored[1]?.[2])?.tokens_in
    expect(row.tokens_in).toBe(routerTokens)
    expect(row.tokens_in).toBeGreaterThan(0)
    expect(row.path).toEqual(['router', 'retriever'])
  })

  test('a run that cannot be finished is logged with its id', async ({
    servedApi: { app, client },
    scriptedLlm,
    onTestFinished,
  }) => {
    scriptTurn(scriptedLlm)
    const failure = new DatabaseError('database gone', 0, 'error')
    hooks.finishRun = async () => {
      throw failure
    }
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => {
      hooks.finishRun = null
      logged.mockRestore()
    })

    const runId = await ask(client, await newConversation(client))
    await until(() => !app.state.executor.tasks.has(runId))

    const records = logged.mock.calls.filter(([text]) => String(text).includes(runId))
    expect(records).toEqual([[`run ${runId} could not be finished`, failure]])
  })
})
