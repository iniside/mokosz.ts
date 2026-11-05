import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { vi } from 'vitest'
import { z } from 'zod'
import {
  LLMError,
  NODE_OPTIONS,
  nodeAgent,
  structured,
  type ChatMessage,
} from '../../src/llm/models.ts'
import { completionCost, PRICES } from '../../src/llm/prices.ts'
import {
  loadProfile,
  ollamaModels,
  PROFILES_DIR,
  ProfileError,
  UnknownProfile,
  type Profile,
} from '../../src/llm/profiles.ts'
import { RunRecorder, type LLMCall } from '../../src/llm/recorder.ts'
import { DIRECTORY as PROMPTS_DIR, load } from '../../src/prompts/index.ts'
import { Decimal } from '../../src/decimal.ts'
import { clearSettingsCache, getSettings } from '../../src/settings.ts'
import { portOf, spyOnSockets } from '../support/network.ts'
import { describe, expect, test as harnessTest } from '../support/harness.ts'
import { ScriptedLLM, scriptedLlmFixture } from './scripted.ts'

vi.mock('ollama-ai-provider-v2', async (importOriginal) => {
  const real = await importOriginal<typeof import('ollama-ai-provider-v2')>()
  const { scripted } = await import('./scripted.ts')
  return { ...real, createOllama: scripted(real.createOllama, 'ollama.responses') }
})
vi.mock('@ai-sdk/anthropic', async (importOriginal) => {
  const real = await importOriginal<typeof import('@ai-sdk/anthropic')>()
  const { scripted } = await import('./scripted.ts')
  return { ...real, createAnthropic: scripted(real.createAnthropic, 'anthropic.messages') }
})

const SYSTEM = 'Route.'
const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'Art. 14?' }]
const WIRE_MESSAGES = [
  { role: 'system', content: SYSTEM },
  { role: 'user', content: 'Art. 14?' },
]
const SERVER_DELAY_MS = 50
const POST_CALL_WAIT_MS = 500
const ROUTER = nodeAgent('router', SYSTEM)
const ANSWERER = nodeAgent('answerer', SYSTEM)

const Route = z.object({ lang: z.string(), article: z.int() })

// The JSON Schema of Route, as the model receives it.
const ROUTE_JSON_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: {
    lang: { type: 'string' },
    article: { type: 'integer', minimum: -9007199254740991, maximum: 9007199254740991 },
  },
  required: ['lang', 'article'],
  additionalProperties: false,
}

// Mastra's schema compatibility layer drops the integer bounds for Anthropic models.
const ROUTE_JSON_SCHEMA_ANTHROPIC = {
  ...ROUTE_JSON_SCHEMA,
  properties: { lang: { type: 'string' }, article: { type: 'integer' } },
}

interface AnthropicRequest {
  path: string
  'x-api-key': string | null
  body: Record<string, unknown>
}

interface CloudOutcome {
  parsed?: unknown
  error?: string
  call?: [string, string, number, number, string]
  requests: AnthropicRequest[]
}

interface ChatBody {
  path: string
  model: string
  [key: string]: unknown
}

interface FakeOllama {
  url: string
  port: number
  requests: ChatBody[]
  content: string
  hang: boolean
}

async function startOllama(): Promise<{ ollama: FakeOllama; close: () => void }> {
  const ollama: FakeOllama = {
    url: '',
    port: 0,
    requests: [],
    content: '{"lang": "en", "article": 14}',
    hang: false,
  }
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const parts: Buffer[] = []
    for await (const part of request) parts.push(Buffer.from(part))
    const body: { model: string } & Record<string, unknown> = JSON.parse(
      Buffer.concat(parts).toString('utf8'),
    )
    ollama.requests.push({ path: request.url ?? '', ...body })
    if (ollama.hang) return
    await sleep(SERVER_DELAY_MS)
    const payload = JSON.stringify({
      model: body.model,
      created_at: '2026-11-04T00:00:00Z',
      message: { role: 'assistant', content: ollama.content },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 11,
      eval_count: 7,
    })
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    })
    response.end(payload)
  }
  const server = createServer((request, response) => {
    handle(request, response).catch(() => response.destroy())
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  ollama.port = portOf(server)
  ollama.url = `http://127.0.0.1:${ollama.port}`
  return {
    ollama,
    close: () => {
      server.close()
      server.closeAllConnections()
    },
  }
}

function applyEnv(entries: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  clearSettingsCache()
}

function useEnv(values: Record<string, string | undefined>): () => void {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  applyEnv(values)
  return () => applyEnv(before)
}

type AnthropicMode = 'ok' | 'hang' | 'stall'

interface FakeAnthropic {
  url: string
  requests: AnthropicRequest[]
  mode: AnthropicMode
}

async function startAnthropic(): Promise<{ anthropic: FakeAnthropic; close: () => void }> {
  const anthropic: FakeAnthropic = { url: '', requests: [], mode: 'ok' }
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const parts: Buffer[] = []
    for await (const part of request) parts.push(Buffer.from(part))
    const body: Record<string, unknown> = JSON.parse(Buffer.concat(parts).toString('utf8'))
    const key = request.headers['x-api-key']
    anthropic.requests.push({
      path: request.url ?? '',
      'x-api-key': typeof key === 'string' ? key : null,
      body,
    })
    if (anthropic.mode === 'hang') return
    const payload = JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [{ type: 'text', text: '{"lang": "en", "article": 14}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 11, output_tokens: 7 },
    })
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    })
    if (anthropic.mode === 'stall') response.write(payload.slice(0, 10))
    else response.end(payload)
  }
  const server = createServer((request, response) => {
    handle(request, response).catch(() => response.destroy())
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  anthropic.url = `http://127.0.0.1:${portOf(server)}`
  return {
    anthropic,
    close: () => {
      server.close()
      server.closeAllConnections()
    },
  }
}

async function cloudOutcome(
  anthropic: FakeAnthropic,
  run: () => Promise<{ parsed: unknown }>,
): Promise<CloudOutcome> {
  anthropic.requests.length = 0
  const outcome = await run().then(
    (result): Omit<CloudOutcome, 'requests'> => ({ parsed: result.parsed }),
    (error: unknown): Omit<CloudOutcome, 'requests'> => {
      if (!(error instanceof LLMError)) throw error
      const { node, model, tokensIn, tokensOut, costUsd } = error.call
      return { error: error.message, call: [node, model, tokensIn, tokensOut, costUsd.toString()] }
    },
  )
  return { ...outcome, requests: [...anthropic.requests] }
}

const execFileAsync = promisify(execFile)

const test = harnessTest
  .extend('ollama', async ({}, { onCleanup }): Promise<FakeOllama> => {
    const { ollama, close } = await startOllama()
    const restore = useEnv({ OLLAMA_BASE_URL: ollama.url })
    onCleanup(() => {
      restore()
      close()
    })
    return ollama
  })
  .extend('tmp', async ({}, { onCleanup }): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'mokosz-llm-'))
    onCleanup(() => rm(dir, { recursive: true, force: true }))
    return dir
  })
  .extend('anthropic', async ({}, { onCleanup }): Promise<FakeAnthropic> => {
    const { anthropic, close } = await startAnthropic()
    const restore = useEnv({
      ANTHROPIC_BASE_URL: anthropic.url,
      ANTHROPIC_API_BASE: undefined,
      ANTHROPIC_API_KEY: 'sk-wire',
    })
    onCleanup(() => {
      restore()
      close()
    })
    return anthropic
  })
  .extend('scriptedLlm', ({}, hooks): ScriptedLLM => scriptedLlmFixture({}, hooks))

async function writeProfile(directory: string, name: string, text: string): Promise<void> {
  await writeFile(join(directory, `${name}.yaml`), text, 'utf8')
}

const LOCAL_NODE = `
    model: ollama_chat/m:1
    num_ctx: 8192
    think: false
    temperature: 0
    keep_alive: 30m
`

function profileText(router: string, answerer: string, timeout = '5'): string {
  return `name: p\ntimeout_s: ${timeout}\nretrieval: {top_k: 8}\nnodes:\n  router:${router}  answerer:${answerer}`
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  const error: unknown = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  )
  if (!(error instanceof Error)) throw new Error('the promise did not reject with an Error')
  return error
}

async function llmError(promise: Promise<unknown>): Promise<LLMError> {
  const error = await rejection(promise)
  if (!(error instanceof LLMError)) throw error
  return error
}

const zero = new Decimal(0)

function call(fields: Omit<LLMCall, 'error'> & { error?: string | null }): LLMCall {
  return { error: null, ...fields }
}

describe('profiles', () => {
  test('all three profiles load with the contract values', async () => {
    const names = (await readdir(PROFILES_DIR)).filter((file) => file.endsWith('.yaml'))
    expect(names.map((file) => file.slice(0, -'.yaml'.length)).toSorted()).toEqual([
      'cloud-claude',
      'local-gemma',
      'local-qwen',
    ])
    for (const [name, model] of [
      ['local-qwen', 'qwen3.6:27b'],
      ['local-gemma', 'gemma4:26b'],
    ] as const) {
      const profile = await loadProfile(name)
      expect(profile.name).toBe(name)
      expect(profile.timeout_s).toBe(180)
      expect(profile.retrieval.top_k).toBe(8)
      for (const node of [profile.nodes.router, profile.nodes.answerer]) {
        expect(node.model).toBe(`ollama_chat/${model}`)
        expect([node.num_ctx, node.think, node.temperature, node.keep_alive]).toEqual([
          8192,
          false,
          0,
          '30m',
        ])
      }
      expect(ollamaModels(profile)).toEqual([model])
    }

    const cloud = await loadProfile('cloud-claude')
    expect(cloud.timeout_s).toBe(120)
    expect(cloud.retrieval.top_k).toBe(8)
    expect(cloud.nodes.router.model).toBe('anthropic/claude-haiku-5-5')
    expect(cloud.nodes.answerer.model).toBe('anthropic/claude-sonnet-5-5')
    for (const node of [cloud.nodes.router, cloud.nodes.answerer]) {
      expect([node.num_ctx, node.think, node.temperature, node.keep_alive]).toEqual([
        null,
        null,
        null,
        null,
      ])
    }
    expect(ollamaModels(cloud)).toEqual([])
  })

  test('default profile setting names a loadable profile', async () => {
    expect(getSettings().defaultProfile).toBe('local-qwen')
    expect((await loadProfile(getSettings().defaultProfile)).name).toBe('local-qwen')
  })

  test.for<[string, string, string]>([
    [
      'top-level',
      `name: p\ntimeout_s: 1\ntop_k: 8\nretrieval: {top_k: 8}\nnodes:\n  router:${LOCAL_NODE}  answerer:${LOCAL_NODE}`,
      'p.yaml: invalid profile\n  (root): Unrecognized key: "top_k"',
    ],
    [
      'node-key',
      `name: p\ntimeout_s: 1\nretrieval: {top_k: 8}\nnodes:\n  router:${LOCAL_NODE}    temprature: 0\n  answerer:${LOCAL_NODE}`,
      'p.yaml: invalid profile\n  nodes.router: Unrecognized key: "temprature"',
    ],
    [
      'bad-type',
      profileText(LOCAL_NODE.replace('num_ctx: 8192', 'num_ctx: many'), LOCAL_NODE),
      'p.yaml: invalid profile\n  nodes.router.num_ctx: Invalid input: expected number, received string',
    ],
    [
      'quoted-number',
      profileText(LOCAL_NODE, LOCAL_NODE).replace('top_k: 8', 'top_k: "8"'),
      'p.yaml: invalid profile\n  retrieval.top_k: Invalid input: expected number, received string',
    ],
    [
      'zero-timeout',
      profileText(LOCAL_NODE, LOCAL_NODE, '0'),
      'p.yaml: invalid profile\n  timeout_s: Too small: expected number to be >0',
    ],
    [
      'missing-node',
      `name: p\ntimeout_s: 1\nretrieval: {top_k: 8}\nnodes:\n  router:${LOCAL_NODE}`,
      'answerer',
    ],
    [
      'missing-timeout',
      `name: p\nretrieval: {top_k: 8}\nnodes:\n  router:${LOCAL_NODE}  answerer:${LOCAL_NODE}`,
      'timeout_s',
    ],
    [
      'cloud-num-ctx',
      'name: p\ntimeout_s: 1\nretrieval: {top_k: 8}\nnodes:\n  router: {model: anthropic/x, num_ctx: 4096}\n  answerer: {model: anthropic/x}',
      'ollama_chat models only',
    ],
    [
      'cloud-think',
      'name: p\ntimeout_s: 1\nretrieval: {top_k: 8}\nnodes:\n  router: {model: anthropic/x, think: false}\n  answerer: {model: anthropic/x}',
      'num_ctx, keep_alive and think apply to ollama_chat models only',
    ],
    [
      'no-prefix',
      'name: p\ntimeout_s: 1\nretrieval: {top_k: 8}\nnodes:\n  router: {model: qwen3.6:27b}\n  answerer: {model: anthropic/x}',
      'must start with',
    ],
    [
      'name-mismatch',
      `name: other\ntimeout_s: 1\nretrieval: {top_k: 8}\nnodes:\n  router:${LOCAL_NODE}  answerer:${LOCAL_NODE}`,
      'name is "other", expected "p"',
    ],
    ['bad-yaml', 'name: p\nnodes: [', 'p.yaml'],
  ])('invalid profile %s is rejected', async ([, text, message], { tmp }) => {
    await writeProfile(tmp, 'p', text)

    const error = await rejection(loadProfile('p', tmp))

    expect(error).toBeInstanceOf(ProfileError)
    expect(error).not.toBeInstanceOf(UnknownProfile)
    expect(error.message).toContain(message)
    expect(error.message.startsWith('p.yaml: ')).toBe(true)
  })

  test('a valid profile in the same shape loads', async ({ tmp }) => {
    await writeProfile(tmp, 'p', profileText(LOCAL_NODE, LOCAL_NODE, '1'))

    expect((await loadProfile('p', tmp)).nodes.answerer.model).toBe('ollama_chat/m:1')
  })

  test.for(['missing', '../profiles/local-qwen', 'Local-Qwen', ''])(
    'unknown or unsafe profile name %j is unknown',
    async (name) => {
      const error = await rejection(loadProfile(name))

      expect(error).toBeInstanceOf(UnknownProfile)
      expect(error.message).toBe(`unknown profile: ${name}`)
    },
  )
})

describe('structured on the wire', () => {
  test('structured sends the profile options on the wire', async ({ ollama }) => {
    const recorder = new RunRecorder()

    const result = await structured(
      ROUTER,
      MESSAGES,
      Route,
      await loadProfile('local-qwen'),
      recorder,
    )

    expect(ollama.requests).toEqual([
      {
        path: '/api/chat',
        model: 'qwen3.6:27b',
        messages: WIRE_MESSAGES,
        options: { num_ctx: 8192, temperature: 0 },
        stream: false,
        format: ROUTE_JSON_SCHEMA,
        keep_alive: '30m',
        think: false,
      },
    ])
    expect(result.parsed).toEqual({ lang: 'en', article: 14 })
    expect(result.model).toBe('ollama_chat/qwen3.6:27b')
    expect([result.tokensIn, result.tokensOut]).toEqual([11, 7])
    expect(result.latencyMs).toBeGreaterThanOrEqual(SERVER_DELAY_MS)
    expect(result.costUsd.toString()).toBe('0')
    expect(recorder.calls).toEqual([
      call({
        node: 'router',
        model: 'ollama_chat/qwen3.6:27b',
        tokensIn: 11,
        tokensOut: 7,
        latencyMs: result.latencyMs,
        costUsd: zero,
      }),
    ])
  })

  // SPEC §3 profiles: each option set on a node is sent; one left out is not.
  test.for<[string, string, Record<string, unknown>]>([
    [
      'every option',
      LOCAL_NODE,
      {
        model: 'm:1',
        options: { num_ctx: 8192, temperature: 0 },
        keep_alive: '30m',
        think: false,
      },
    ],
    ['model only', '\n    model: ollama_chat/m:1\n', { model: 'm:1', options: {} }],
    [
      'thinking on',
      '\n    model: ollama_chat/m:1\n    think: true\n    num_ctx: 4096\n',
      { model: 'm:1', options: { num_ctx: 4096 }, think: true },
    ],
    [
      'temperature only',
      '\n    model: ollama_chat/m:1\n    temperature: 0.7\n',
      { model: 'm:1', options: { temperature: 0.7 } },
    ],
    [
      'keep_alive only',
      '\n    model: ollama_chat/m:1\n    keep_alive: 5m\n',
      { model: 'm:1', options: {}, keep_alive: '5m' },
    ],
  ])(
    'the Ollama chat body carries the node options: %s',
    async ([, node, fields], { ollama, tmp }) => {
      await writeProfile(tmp, 'p', profileText(node, node))

      await structured(ANSWERER, MESSAGES, Route, await loadProfile('p', tmp), new RunRecorder())

      expect(ollama.requests).toEqual([
        {
          path: '/api/chat',
          messages: WIRE_MESSAGES,
          stream: false,
          format: ROUTE_JSON_SCHEMA,
          ...fields,
        },
      ])
    },
  )

  test('a local call connects only to the configured Ollama', async ({ ollama, tmp }) => {
    const fresh = LOCAL_NODE.replace('m:1', `never-priced-${crypto.randomUUID()}:1`)
    await writeProfile(tmp, 'p', profileText(fresh, fresh))
    const profile = await loadProfile('p', tmp)

    const spy = spyOnSockets()
    try {
      await structured(ROUTER, MESSAGES, Route, profile, new RunRecorder())
      await sleep(POST_CALL_WAIT_MS)

      expect(spy.peers.ports()).toEqual(new Set([ollama.port]))
      expect(ollama.requests.map((request) => request.path)).toEqual(['/api/chat'])
    } finally {
      spy.restore()
    }
  })

  test('each node uses its own model', async ({ ollama, tmp }) => {
    await writeProfile(tmp, 'p', profileText(LOCAL_NODE, LOCAL_NODE.replace('m:1', 'n:2')))
    const profile = await loadProfile('p', tmp)

    await structured(ROUTER, MESSAGES, Route, profile, new RunRecorder())
    await structured(ANSWERER, MESSAGES, Route, profile, new RunRecorder())

    expect(ollama.requests.map((request) => request.model)).toEqual(['m:1', 'n:2'])
  })

  test.for<[string, string]>([
    ['{"lang": "en", "article": ', 'invalid output: not valid JSON'],
    [
      '{"lang": "en"}',
      'invalid output at article: Invalid input: expected number, received undefined',
    ],
    ['', 'invalid output: not valid JSON'],
    [
      '{"lang": "en", "article": "14"}',
      'invalid output at article: Invalid input: expected number, received string',
    ],
    ['[]', 'invalid output: Invalid input: expected object, received array'],
  ])(
    'invalid output %j raises LLMError with usage and is recorded',
    async ([content, error], { ollama }) => {
      ollama.content = content
      const recorder = new RunRecorder()

      const raised = await llmError(
        structured(ROUTER, MESSAGES, Route, await loadProfile('local-qwen'), recorder),
      )

      expect(raised.message).toBe(`router (ollama_chat/qwen3.6:27b): ${error}`)
      const recorded = raised.call
      expect([recorded.node, recorded.model, recorded.tokensIn, recorded.tokensOut]).toEqual([
        'router',
        'ollama_chat/qwen3.6:27b',
        11,
        7,
      ])
      expect(recorded.latencyMs).toBeGreaterThanOrEqual(SERVER_DELAY_MS)
      expect(recorded.costUsd.toString()).toBe('0')
      expect(recorded.error).toBe(error)
      expect(recorder.calls).toEqual([recorded])
    },
  )

  test.for<[string, string, unknown]>([
    ['valid', '{"lang": "en", "article": 14}', { lang: 'en', article: 14 }],
    ['edge whitespace', '  {"lang": "en", "article": 14}\n', { lang: 'en', article: 14 }],
    [
      'an unknown key of a non-strict schema',
      '{"lang": "en", "article": 14, "x": 1}',
      { lang: 'en', article: 14 },
    ],
    [
      'a later duplicate key wins',
      '{"lang": "en", "lang": "pl", "article": 14}',
      { lang: 'pl', article: 14 },
    ],
    ['an integral float', '{"lang": "en", "article": 1e2}', { lang: 'en', article: 100 }],
    ['escapes', '{"lang": "\\u017c\\u00f3\\u0142w", "article": 14}', { lang: 'żółw', article: 14 }],
  ])('a model output parses: %s', async ([, content, parsed], { ollama }) => {
    ollama.content = content
    const recorder = new RunRecorder()

    const result = await structured(
      ROUTER,
      MESSAGES,
      Route,
      await loadProfile('local-qwen'),
      recorder,
    )

    expect(result.parsed).toEqual(parsed)
    expect(recorder.calls.map((recorded) => recorded.error)).toEqual([null])
  })

  test('a server that never answers times out after timeout_s', async ({ ollama }) => {
    ollama.hang = true
    const profile: Profile = { ...(await loadProfile('local-qwen')), timeout_s: 0.3 }
    const recorder = new RunRecorder()
    const started = performance.now()

    const error = await llmError(structured(ANSWERER, MESSAGES, Route, profile, recorder))

    const elapsed = performance.now() - started
    expect(error.message).toMatch(/Timeout/)
    expect(elapsed).toBeGreaterThanOrEqual(300)
    expect(elapsed).toBeLessThan(5000)
    expect(ollama.requests).toHaveLength(1)
    expect(recorder.calls).toEqual([error.call])
    expect(error.call.node).toBe('answerer')
    expect(error.call.error).not.toBeNull()
    expect(error.call.latencyMs).toBeGreaterThanOrEqual(300)
    expect(error.call.costUsd.toString()).toBe('0')
  })

  test('an unreachable server raises LLMError and is recorded', async ({
    unreachableOllama: _,
  }) => {
    const recorder = new RunRecorder()

    const error = await llmError(
      structured(ROUTER, MESSAGES, Route, await loadProfile('local-qwen'), recorder),
    )

    expect(error.message).toMatch(
      /^router \(ollama_chat\/qwen3\.6:27b\): AI_APICallError: Cannot connect to API: connect ECONNREFUSED/,
    )
    expect(recorder.calls).toEqual([error.call])
    expect([error.call.tokensIn, error.call.tokensOut]).toEqual([0, 0])
    expect(error.call.costUsd.toString()).toBe('0')
  })

  test('an abort stops the call and records nothing', async ({ ollama }) => {
    ollama.hang = true
    const recorder = new RunRecorder()
    const controller = new AbortController()
    const reason = new Error('interrupted by shutdown')
    setTimeout(() => controller.abort(reason), 100)

    const error = await rejection(
      structured(
        ROUTER,
        MESSAGES,
        Route,
        await loadProfile('local-qwen'),
        recorder,
        controller.signal,
      ),
    )

    expect(error).toBe(reason)
    expect(recorder.calls).toEqual([])
  })
})

describe('cloud models', () => {
  test('cloud sends no temperature or think and parses mock output', async ({
    scriptedLlm,
    unreachableOllama: _,
    onTestFinished,
  }) => {
    onTestFinished(useEnv({ ANTHROPIC_API_KEY: 'sk-scripted' }))
    scriptedLlm.queue('router', { lang: 'pl', article: 26 })
    scriptedLlm.queue('answerer', { lang: 'en', article: 4 })
    const profile = await loadProfile('cloud-claude')
    const recorder = new RunRecorder()

    const router = await structured(ROUTER, MESSAGES, Route, profile, recorder)
    const answerer = await structured(ANSWERER, MESSAGES, Route, profile, recorder)

    expect(router.parsed).toEqual({ lang: 'pl', article: 26 })
    expect(answerer.parsed).toEqual({ lang: 'en', article: 4 })
    const [first, second] = scriptedLlm.calls
    expect(router.model).toBe('anthropic/claude-haiku-5-5')
    expect(answerer.model).toBe('anthropic/claude-sonnet-5-5')
    for (const [options, node] of [
      [first!, 'router'],
      [second!, 'answerer'],
    ] as const) {
      expect(options.temperature).toBeUndefined()
      expect(options.providerOptions).toEqual({ [NODE_OPTIONS]: { node } })
      expect(options.prompt).toEqual([
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: [{ type: 'text', text: 'Art. 14?', providerOptions: expect.anything() }],
        },
      ])
      expect(options.responseFormat?.type).toBe('json')
      const sent = options.responseFormat?.type === 'json' ? options.responseFormat.schema : null
      expect(sent).toEqual(ROUTE_JSON_SCHEMA_ANTHROPIC)
    }
    expect(recorder.calls.map((recorded) => recorded.model)).toEqual([router.model, answerer.model])
  })

  test('cloud cost comes from the price table and local cost is zero', async ({
    scriptedLlm,
    unreachableOllama: _,
    onTestFinished,
  }) => {
    onTestFinished(useEnv({ ANTHROPIC_API_KEY: 'sk-scripted' }))
    scriptedLlm.queue('answerer', { lang: 'en', article: 1 }, { lang: 'en', article: 2 })
    const recorder = new RunRecorder()

    const cloud = await structured(
      ANSWERER,
      MESSAGES,
      Route,
      await loadProfile('cloud-claude'),
      recorder,
    )
    const local = await structured(
      ANSWERER,
      MESSAGES,
      Route,
      await loadProfile('local-qwen'),
      recorder,
    )

    const prices = PRICES['claude-sonnet-5-5']!
    expect(prices).toEqual({ input: '0.000002', output: '0.00001' })
    const expected = new Decimal(cloud.tokensIn)
      .times(new Decimal('0.000002'))
      .plus(new Decimal(cloud.tokensOut).times(new Decimal('0.00001')))
    expect(cloud.costUsd.cmp(new Decimal(0))).toBe(1)
    expect(cloud.costUsd.equals(expected)).toBe(true)
    expect(local.costUsd.toString()).toBe('0')
    expect(recorder.totals().costUsd.equals(expected)).toBe(true)
  })

  // Tokens × USD per token, by hand: sonnet 0.000002 in and 0.00001 out; haiku 0.0000001 in and
  // 0.0000005 out, or 0.0000005 and 0.0000025 once the prompt has more than 100,000 tokens.
  test.each<[string, number, number, string]>([
    ['claude-sonnet-5-5', 0, 0, '0'],
    ['claude-sonnet-5-5', 1, 0, '0.000002'],
    ['claude-sonnet-5-5', 0, 1, '0.00001'],
    ['claude-sonnet-5-5', 1, 1, '0.000012'],
    ['claude-sonnet-5-5', 3, 3, '0.000036'],
    ['claude-sonnet-5-5', 11, 7, '0.000092'],
    ['claude-sonnet-5-5', 7919, 3571, '0.051548'],
    ['claude-sonnet-5-5', 250_000, 4000, '0.54'],
    ['claude-sonnet-5-5', 1_000_000, 128_000, '3.28'],
    ['claude-haiku-5-5', 0, 0, '0'],
    ['claude-haiku-5-5', 1, 0, '0.0000001'],
    ['claude-haiku-5-5', 0, 1, '0.0000005'],
    ['claude-haiku-5-5', 1, 1, '0.0000006'],
    ['claude-haiku-5-5', 3, 3, '0.0000018'],
    ['claude-haiku-5-5', 99_999, 100, '0.0100499'],
    ['claude-haiku-5-5', 100_000, 100, '0.01005'],
    ['claude-haiku-5-5', 100_001, 100, '0.0502505'],
    ['claude-haiku-5-5', 1_000_000, 128_000, '0.82'],
  ])('the cost of %s for %i in and %i out is %s USD', (model, tokensIn, tokensOut, cost) => {
    expect(completionCost(model, tokensIn, tokensOut).toString()).toBe(cost)
  })

  test('a model without a price fails the cost lookup', () => {
    expect(() => completionCost('claude-unmapped', 1, 1)).toThrow(
      'no price for model claude-unmapped; add it to src/llm/prices.ts',
    )
  })

  test('a failed cost lookup raises LLMError and keeps the usage', async ({
    scriptedLlm,
    unreachableOllama: _,
    onTestFinished,
    tmp,
  }) => {
    onTestFinished(useEnv({ ANTHROPIC_API_KEY: 'sk-scripted' }))
    const unmapped = '\n    model: anthropic/claude-unmapped\n'
    await writeProfile(tmp, 'p', profileText(unmapped, unmapped))
    scriptedLlm.queue('router', { lang: 'en', article: 1 })
    const recorder = new RunRecorder()

    const error = await llmError(
      structured(ROUTER, MESSAGES, Route, await loadProfile('p', tmp), recorder),
    )

    expect(error.message).toBe(
      'router (anthropic/claude-unmapped): cost lookup failed: no price for model claude-unmapped; add it to src/llm/prices.ts',
    )
    expect(recorder.calls).toEqual([error.call])
    expect(error.call.model).toBe('anthropic/claude-unmapped')
    expect(error.call.tokensIn).toBeGreaterThan(0)
    expect(error.call.tokensOut).toBeGreaterThan(0)
    expect(error.call.costUsd.toString()).toBe('0')
  })

  test('the default cloud profile sends neither temperature nor think', async ({ anthropic }) => {
    const cloud = await loadProfile('cloud-claude')

    const router = await cloudOutcome(anthropic, () =>
      structured(ROUTER, MESSAGES, Route, cloud, new RunRecorder()),
    )
    const answerer = await cloudOutcome(anthropic, () =>
      structured(ANSWERER, MESSAGES, Route, cloud, new RunRecorder()),
    )

    for (const [outcome, model] of [
      [router, 'claude-haiku-5-5'],
      [answerer, 'claude-sonnet-5-5'],
    ] as const) {
      expect(outcome.parsed).toEqual({ lang: 'en', article: 14 })
      expect(outcome.requests).toHaveLength(1)
      const [request] = outcome.requests
      expect([request!.path, request!['x-api-key']]).toEqual(['/v1/messages', 'sk-wire'])
      expect(request!.body).toMatchObject({
        model,
        system: [{ type: 'text', text: SYSTEM }],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Art. 14?' }] }],
      })
      expect(request!.body).not.toHaveProperty('temperature')
      expect(request!.body).not.toHaveProperty('think')
    }
  })

  test.for<[string, string, Record<string, unknown>]>([
    ['temperature 1', 'temperature: 1', { temperature: 1 }],
  ])('a cloud node with %s sends it as it is', async ([, option, fields], { anthropic, tmp }) => {
    const node = `\n    model: anthropic/claude-haiku-5-5\n    ${option}\n`
    await writeProfile(tmp, 'p', profileText(node, node))
    const profile = await loadProfile('p', tmp)

    const outcome = await cloudOutcome(anthropic, () =>
      structured(ROUTER, MESSAGES, Route, profile, new RunRecorder()),
    )

    expect(outcome.parsed).toEqual({ lang: 'en', article: 14 })
    expect(outcome.requests[0]?.body).toMatchObject(fields)
  })

  test.for<[string, string, string]>([
    [
      'claude-haiku-5-5',
      '0.5',
      'claude-haiku-5-5 does not accept temperature 0.5: only 1 is supported',
    ],
    [
      'claude-haiku-5-5',
      '0',
      'claude-haiku-5-5 does not accept temperature 0: only 1 is supported',
    ],
    [
      'claude-haiku-5-5',
      '1e-7',
      'claude-haiku-5-5 does not accept temperature 1e-7: only 1 is supported',
    ],
    [
      'claude-haiku-5-5',
      '1e20',
      'claude-haiku-5-5 does not accept temperature 100000000000000000000: only 1 is supported',
    ],
    [
      'claude-sonnet-5-5',
      '0.7',
      'claude-sonnet-5-5 does not accept temperature 0.7: only 1 is supported',
    ],
  ])(
    '%s with temperature %s is refused before any request',
    async ([model, temperature, message], { anthropic, tmp }) => {
      const node = `\n    model: anthropic/${model}\n    temperature: ${temperature}\n`
      await writeProfile(tmp, 'p', profileText(node, node))
      const profile = await loadProfile('p', tmp)

      const outcome = await cloudOutcome(anthropic, () =>
        structured(ROUTER, MESSAGES, Route, profile, new RunRecorder()),
      )

      expect(outcome).toEqual({
        error: `router (anthropic/${model}): ${message}`,
        call: ['router', `anthropic/${model}`, 0, 0, '0'],
        requests: [],
      })
    },
  )

  test.for<[string, string | undefined]>([
    ['unset', undefined],
    ['empty', ''],
    ['blank', '  '],
  ])('a missing API key (%s) fails before any request', async ([, key], { anthropic }) => {
    applyEnv({ ANTHROPIC_API_KEY: key })

    const outcome = await cloudOutcome(anthropic, async () =>
      structured(ROUTER, MESSAGES, Route, await loadProfile('cloud-claude'), new RunRecorder()),
    )

    expect(outcome).toEqual({
      error:
        'router (anthropic/claude-haiku-5-5): Anthropic API key missing: set ANTHROPIC_API_KEY',
      call: ['router', 'anthropic/claude-haiku-5-5', 0, 0, '0'],
      requests: [],
    })
  })

  test('an API key with edge spaces is sent trimmed', async ({ anthropic }) => {
    applyEnv({ ANTHROPIC_API_KEY: ' sk-pad ' })

    const outcome = await cloudOutcome(anthropic, async () =>
      structured(ROUTER, MESSAGES, Route, await loadProfile('cloud-claude'), new RunRecorder()),
    )

    expect(outcome.parsed).toEqual({ lang: 'en', article: 14 })
    expect(outcome.requests.map((request) => request['x-api-key'])).toEqual(['sk-pad'])
  })

  test.for<[Record<string, string>, string]>([
    [{ ANTHROPIC_BASE_URL: '' }, '/v1/messages'],
    [{ ANTHROPIC_BASE_URL: '/' }, '/v1/messages'],
    [{ ANTHROPIC_BASE_URL: '/v1' }, '/v1/v1/messages'],
    [{ ANTHROPIC_BASE_URL: '/v1/messages' }, '/v1/messages'],
    [{ ANTHROPIC_BASE_URL: '/proxy' }, '/proxy/v1/messages'],
    [{ ANTHROPIC_API_BASE: '/a', ANTHROPIC_BASE_URL: '/b' }, '/a/v1/messages'],
    [{ ANTHROPIC_API_BASE: '', ANTHROPIC_BASE_URL: '/b' }, '/b/v1/messages'],
  ])('the Anthropic URL for %j posts to %s', async ([env, path], { anthropic }) => {
    const { ANTHROPIC_API_BASE: apiBase, ANTHROPIC_BASE_URL: baseUrl } = env
    applyEnv({
      ANTHROPIC_API_BASE: apiBase && `${anthropic.url}${apiBase}`,
      ANTHROPIC_BASE_URL: baseUrl === undefined ? undefined : `${anthropic.url}${baseUrl}`,
    })

    await structured(ROUTER, MESSAGES, Route, await loadProfile('cloud-claude'), new RunRecorder())

    expect(anthropic.requests.map((request) => request.path)).toEqual([path])
  })

  test('the Anthropic API key is read from the .env file', async ({ anthropic, tmp }) => {
    await writeFile(join(tmp, '.env'), 'ANTHROPIC_API_KEY=sk-dotenv\n', 'utf8')
    const env: Record<string, string | undefined> = { ...process.env }
    delete env.ANTHROPIC_API_KEY
    env.ANTHROPIC_BASE_URL = anthropic.url

    const { stdout } = await execFileAsync(
      process.execPath,
      [join(import.meta.dirname, 'dotenv-child.ts')],
      { cwd: tmp, env },
    )

    expect(JSON.parse(stdout)).toEqual({ lang: 'en', article: 14 })
    expect(anthropic.requests.map((request) => request['x-api-key'])).toEqual(['sk-dotenv'])
  })

  test.for<[string, AnthropicMode, RegExp]>([
    ['headers', 'hang', /Headers Timeout/],
    ['body', 'stall', /Body Timeout/],
  ])(
    'a cloud response whose %s never arrive times out after timeout_s',
    async ([, mode, message], { anthropic, tmp }) => {
      anthropic.mode = mode
      const haiku = '\n    model: anthropic/claude-haiku-5-5\n'
      await writeProfile(tmp, 'p', profileText(haiku, haiku, '0.3'))
      const recorder = new RunRecorder()
      const started = performance.now()

      const error = await llmError(
        structured(ROUTER, MESSAGES, Route, await loadProfile('p', tmp), recorder),
      )

      const elapsed = performance.now() - started
      expect(error.message).toMatch(message)
      expect(elapsed).toBeGreaterThanOrEqual(300)
      expect(elapsed).toBeLessThan(2500)
      expect(recorder.calls).toEqual([error.call])
      expect(anthropic.requests.map((request) => request.path)).toEqual(['/v1/messages'])
    },
  )

  test('a cloud connection that never completes fails at timeout_s', async ({
    anthropic: _,
    tmp,
  }) => {
    const silent = createNetServer(() => {})
    silent.listen(0, '127.0.0.1')
    await once(silent, 'listening')
    try {
      applyEnv({ ANTHROPIC_BASE_URL: `https://127.0.0.1:${portOf(silent)}` })
      const haiku = '\n    model: anthropic/claude-haiku-5-5\n'
      await writeProfile(tmp, 'p', profileText(haiku, haiku, '0.3'))
      const started = performance.now()

      const error = await llmError(
        structured(ROUTER, MESSAGES, Route, await loadProfile('p', tmp), new RunRecorder()),
      )

      expect(performance.now() - started).toBeLessThan(2500)
      expect(error.message).toMatch(/Connect Timeout/)
    } finally {
      silent.close()
    }
  })
})

/** Runs the scripted LLM fixture around body; what its teardown throws, or null. */
async function teardownError(body: (script: ScriptedLLM) => Promise<void>): Promise<unknown> {
  let cleanup: (() => void) | undefined
  const script = scriptedLlmFixture({}, { onCleanup: (fn) => (cleanup = fn) })
  await body(script)
  try {
    cleanup!()
  } catch (error) {
    return error
  }
  return null
}

describe('scripted LLM', () => {
  test('scripted LLM runs our parsing for local nodes without a server', async ({
    scriptedLlm,
    unreachableOllama: _,
  }) => {
    scriptedLlm.queue('router', '{"lang": "en", "article": 14}')
    scriptedLlm.queue('answerer', '{"lang": "en"}')
    const recorder = new RunRecorder()
    const profile = await loadProfile('local-qwen')

    const result = await structured(ROUTER, MESSAGES, Route, profile, recorder)
    const error = await llmError(structured(ANSWERER, MESSAGES, Route, profile, recorder))

    expect(error.message).toBe(
      'answerer (ollama_chat/qwen3.6:27b): invalid output at article: Invalid input: expected number, received undefined',
    )
    expect(result.parsed).toEqual({ lang: 'en', article: 14 })
    expect(result.tokensIn).toBeGreaterThan(0)
    expect(result.tokensOut).toBeGreaterThan(0)
    expect(recorder.calls.map((recorded) => [recorded.node, recorded.error === null])).toEqual([
      ['router', true],
      ['answerer', false],
    ])
    expect(scriptedLlm.calls[0]!.providerOptions?.ollama).toEqual({
      think: false,
      options: { num_ctx: 8192, temperature: 0 },
    })
  })

  test('scripted LLM fails loudly when a node has no output', async ({ scriptedLlm }) => {
    const error = await rejection(
      structured(ROUTER, MESSAGES, Route, await loadProfile('local-qwen'), new RunRecorder()),
    )

    expect(error.message).toBe('no scripted output left for node router')
    expect(scriptedLlm.missing).toEqual(['router'])
    scriptedLlm.missing.length = 0
  })

  test('the scripted LLM fixture teardown fails unused or missing outputs', async () => {
    const Out = z.object({ a: z.int() })
    const profile = await loadProfile('local-qwen')

    const unused = await teardownError(async (script) => {
      script.queue('router', { a: 1 })
    })
    const swallowed = await teardownError(async () => {
      await rejection(structured(ROUTER, [], Out, profile, new RunRecorder()))
    })
    const consumed = await teardownError(async (script) => {
      script.queue('router', { a: 1 })
      await structured(ROUTER, [], Out, profile, new RunRecorder())
    })

    expect(String(unused)).toMatch(/scripted outputs not consumed: \{"router":\[".*a.*1/)
    expect(String(swallowed)).toMatch(/nodes called without a scripted output: .*"router"/)
    expect(consumed).toBeNull()
  })
})

describe('recorder', () => {
  test('recorder sums per step and per run', () => {
    const recorder = new RunRecorder()
    recorder.visit('router')
    recorder.record(
      call({
        node: 'router',
        model: 'a',
        tokensIn: 10,
        tokensOut: 2,
        latencyMs: 100,
        costUsd: new Decimal('0.001'),
      }),
    )
    const mark = recorder.mark()
    recorder.visit('answerer')
    recorder.record(
      call({
        node: 'answerer',
        model: 'b',
        tokensIn: 20,
        tokensOut: 5,
        latencyMs: 300,
        costUsd: new Decimal('0.002'),
        error: 'invalid output',
      }),
    )
    recorder.record(
      call({
        node: 'answerer',
        model: 'b',
        tokensIn: 30,
        tokensOut: 6,
        latencyMs: 400,
        costUsd: new Decimal('0.003'),
      }),
    )

    const step = recorder.since(mark)
    const total = recorder.totals()

    expect(recorder.path).toEqual(['router', 'answerer'])
    expect([step.models, step.tokensIn, step.tokensOut, step.latencyMs]).toEqual([
      ['b'],
      50,
      11,
      700,
    ])
    expect(step.costUsd.toString()).toBe('0.005')
    expect([total.models, total.tokensIn, total.tokensOut, total.latencyMs]).toEqual([
      ['a', 'b'],
      60,
      13,
      800,
    ])
    expect(total.costUsd.toString()).toBe('0.006')
    expect(recorder.since(recorder.mark()).models).toEqual([])
  })

  test.each<[string[], string]>([
    [[], '0'],
    [['0.001', '0.002', '0.003'], '0.006'],
    [['0.1', '0.2'], '0.3'],
    [['0.000002', '0.0000001'], '0.0000021'],
    [['1', '0.0000000000000000000000000001'], '1.0000000000000000000000000001'],
    [['0.5', '-0.50'], '0.00'],
  ])('the recorded cost total of %j is the exact sum %s', (costs, sum) => {
    const recorder = new RunRecorder()
    for (const cost of costs) {
      recorder.record(
        call({
          node: 'n',
          model: 'm',
          tokensIn: 0,
          tokensOut: 0,
          latencyMs: 0,
          costUsd: new Decimal(cost),
        }),
      )
    }
    expect(recorder.totals().costUsd.toString()).toBe(sum)
  })
})

describe('prompts', () => {
  test.for(['router', 'answerer'])(
    'load(%j) is the prompt file without its final newline',
    async (name) => {
      const raw = await readFile(join(PROMPTS_DIR, `${name}.md`), 'utf8')

      expect(raw.endsWith('\n')).toBe(true)
      expect(`${load(name)}\n`).toBe(raw)
    },
  )
})

describe('cloud invalid output', () => {
  test('an invalid cloud output is recorded with its cost', async ({
    scriptedLlm,
    unreachableOllama: _,
    onTestFinished,
  }) => {
    onTestFinished(useEnv({ ANTHROPIC_API_KEY: 'sk-scripted' }))
    scriptedLlm.queue('router', '{"lang": "en"}')
    const recorder = new RunRecorder()

    const error = await llmError(
      structured(ROUTER, MESSAGES, Route, await loadProfile('cloud-claude'), recorder),
    )

    expect(error.message).toBe(
      'router (anthropic/claude-haiku-5-5): invalid output at article: Invalid input: expected number, received undefined',
    )
    const { tokensIn, tokensOut, costUsd } = error.call
    expect(tokensIn).toBeGreaterThan(0)
    expect(costUsd.cmp(new Decimal(0))).toBe(1)
    expect(costUsd.toString()).toBe(
      completionCost('claude-haiku-5-5', tokensIn, tokensOut).toString(),
    )
    expect(recorder.calls).toEqual([error.call])
  })
})
