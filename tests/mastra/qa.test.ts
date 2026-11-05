import { Client, Pool } from 'pg'
import { vi } from 'vitest'
import { z } from 'zod'
import { parseOutput } from '../../src/llm/models.ts'
import { loadProfile } from '../../src/llm/profiles.ts'
import { AnswerOutputSchema, request } from '../../src/mastra/agents/answerer.ts'
import { PROMPT as ROUTER_PROMPT } from '../../src/mastra/agents/router.ts'
import { createMastra } from '../../src/mastra/index.ts'
import { MEMORY } from '../../src/mastra/memory.ts'
import { previousFilters, saveMessage } from '../../src/mastra/workflows/qa.ts'
import {
  AttemptSchema,
  RetrievalSchema,
  RoutedSchema,
  type Attempt,
  type Retrieved,
} from '../../src/mastra/workflows/state.ts'
import { registerRunContext, runContext } from '../../src/mastra/workflows/wrap.ts'
import { storeSink } from '../../src/runs/executor.ts'
import { eventsAfter, startRun } from '../../src/runs/conversations.ts'
import { endWithin } from '../support/databases.ts'
import { describe, expect, test as harnessTest } from '../support/harness.ts'
import { scriptedLlmFixture, type CallOptions, type ScriptedLLM } from '../llm/scripted.ts'
import {
  EMBED_DELAY_MS,
  errorFields,
  FakeEmbedder,
  Harness,
  newTurn,
  type Embed,
  type Turn,
} from './qa-harness.ts'

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined
}

const embedding = vi.hoisted(() => ({ current: null as Embed | null }))

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
      if (embedding.current === null) throw new Error('the test has no embedder')
      return embedding.current(text, options)
    },
  }
})

// SPEC §3 answerer: claims with at least one citation key each, and not_found.
const ANSWER_JSON_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          citations: { type: 'array', items: { type: 'string' }, minItems: 1 },
        },
        required: ['text', 'citations'],
        additionalProperties: false,
      },
    },
    not_found: { type: 'boolean' },
  },
  required: ['claims', 'not_found'],
  additionalProperties: false,
}

const StepFinishedSchema = z.strictObject({
  node: z.string(),
  model: z.string().nullable(),
  tokens_in: z.int(),
  tokens_out: z.int(),
  latency_ms: z.int(),
})
type StepFinished = z.output<typeof StepFinishedSchema>

const harnessProfile = await loadProfile('local-qwen')

const MODEL = 'ollama_chat/qwen3.6:27b'
const NODES = ['router', 'retriever', 'answerer', 'verifier']
const RETRY = [...NODES, 'answerer', 'verifier']
const AI_14_1 = '32024R1689#014.001'
const AI_26_1 = '32024R1689#026.001'
const GDPR_6_1 = '32016R0679#006.001'
const UNKNOWN = '32024R1689#099.009'

const Q_AI_14 = 'What does Article 14 of the AI Act require?'
const STANDALONE_AI_14 = 'What does AI Act Article 14 require?'
const Q_AI_26 = 'And what about art. 26?'
const STANDALONE_AI_26 = 'What does AI Act Article 26 require?'
const Q_GDPR_6 = 'When is processing lawful under Article 6 GDPR?'

const test = harnessTest
  .extend('pool', { scope: 'file' }, async ({ seededDatabaseUrl }, { onCleanup }) => {
    const pool = new Pool({ connectionString: seededDatabaseUrl })
    onCleanup(() => endWithin(pool))
    return pool
  })
  .extend('mastra', { scope: 'file' }, async ({ pool }, { onCleanup }) => {
    const mastra = createMastra(pool)
    await mastra.getStorage()!.init()
    onCleanup(() => mastra.shutdown())
    return mastra
  })
  .extend('scriptedLlm', ({}, hooks): ScriptedLLM => scriptedLlmFixture({}, hooks))
  .extend('embedder', ({}, { onCleanup }): FakeEmbedder => {
    const fake = new FakeEmbedder()
    embedding.current = fake.embed
    onCleanup(() => {
      embedding.current = null
    })
    return fake
  })
  .extend(
    'harness',
    async ({ mastra, pool, embedder, unreachableOllama: _ }): Promise<Harness> =>
      new Harness(mastra, pool, await loadProfile('local-qwen'), embedder),
  )

function route(lang: string, acts: string[], refs: [string | null, number][], query: string) {
  return {
    lang,
    acts,
    article_refs: refs.map(([act, article]) => ({ act, article })),
    query,
  }
}

function answer(claims: [string, string[]][], notFound = false) {
  return {
    claims: claims.map(([text, keys]) => ({ text, citations: keys })),
    not_found: notFound,
  }
}

function node(call: CallOptions): unknown {
  return record(call.providerOptions?.mokosz)?.node
}

function userText(call: CallOptions): string {
  const [system, user, ...rest] = call.prompt
  expect(system?.role).toBe('system')
  expect(rest).toEqual([])
  if (user?.role !== 'user') throw new Error('the second message is not the user request')
  return user.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
}

function requestsOf(script: ScriptedLLM, name: string): string[] {
  return script.calls.filter((call) => node(call) === name).map(userText)
}

function sentSchema(call: CallOptions): unknown {
  return call.responseFormat?.type === 'json' ? call.responseFormat.schema : undefined
}

function started(turn: Turn): string[] {
  return turn.sink.events.flatMap(([kind, p]) => (kind === 'step_started' ? [String(p.node)] : []))
}

function stepOutput<S extends z.ZodType>(turn: Turn, id: string, schema: S): z.output<S> {
  const step = turn.result?.steps[id]
  if (step?.status !== 'success') throw new Error(`step ${id} is ${step?.status ?? 'missing'}`)
  return schema.parse(step.output)
}

/** The answer-verify loop's last output: the turn's final answer, attempts and reasons. */
function attempt(turn: Turn): Attempt {
  return stepOutput(turn, 'answer-verify', AttemptSchema)
}

function retrievedKeys(state: Pick<Attempt, 'retrieved'>): string[] {
  return state.retrieved.map((chunk) => chunk.citation_key)
}

function failure(turn: Turn): Record<string, unknown> {
  expect(turn.result?.status).toBe('failed')
  return turn.result?.status === 'failed' ? errorFields(turn.result.error) : {}
}

async function ai14Turn(harness: Harness, script: ScriptedLLM, conversationId: string) {
  await harness.embedAs(STANDALONE_AI_14, AI_14_1, 'en')
  script.queue('router', route('en', ['AI Act'], [['AI Act', 14]], STANDALONE_AI_14))
  script.queue('answerer', answer([['Humans must be able to oversee high-risk AI.', [AI_14_1]]]))
  return harness.turn(conversationId, Q_AI_14)
}

describe('qa workflow', () => {
  test('a turn runs the nodes in order with wrapper events', async ({
    harness,
    scriptedLlm,
    seededDatabaseUrl,
  }) => {
    const conversationId = await harness.conversation()

    const turn = await ai14Turn(harness, scriptedLlm, conversationId)

    expect(turn.recorder.path).toEqual(NODES)
    const expectedKinds = NODES.flatMap(() => ['step_started', 'step_finished'])
    expect(turn.sink.events.map(([kind]) => kind)).toEqual(expectedKinds)
    expect(turn.sink.events.map(([, p]) => p.node)).toEqual(NODES.flatMap((n) => [n, n]))
    const timeline = turn.sink.timeline
    for (const name of NODES) {
      const update = timeline.findIndex(([kind, item]) => kind === 'update' && item === name)
      expect(update).toBeGreaterThan(-1)
      const isStart = ([kind, item]: (typeof timeline)[number]): boolean =>
        kind === 'step_started' && record(item)?.node === name
      expect(timeline.findIndex(isStart)).toBeLessThan(update)
      const finished = timeline.findIndex(
        ([kind, item]) => kind === 'step_finished' && record(item)?.node === name,
      )
      expect(finished).toBeGreaterThan(-1)
      expect(finished).toBeLessThan(update)
    }

    const finishedPayloads = new Map(
      turn.sink.events.flatMap(([kind, p]): [unknown, StepFinished][] =>
        kind === 'step_finished' ? [[p.node, StepFinishedSchema.parse(p)]] : [],
      ),
    )
    const finishedOf = (name: string): StepFinished => finishedPayloads.get(name)!
    const [routerCall, answererCall] = turn.recorder.calls
    for (const [name, call] of [
      ['router', routerCall!],
      ['answerer', answererCall!],
    ] as const) {
      const payload = finishedOf(name)
      expect(payload.model).toBe(MODEL)
      expect([payload.tokens_in, payload.tokens_out]).toEqual([call.tokensIn, call.tokensOut])
      expect(call.tokensIn).toBeGreaterThan(0)
      expect(call.error).toBeNull()
    }
    for (const name of ['retriever', 'verifier']) {
      expect(finishedOf(name).model).toBeNull()
      expect([finishedOf(name).tokens_in, finishedOf(name).tokens_out]).toEqual([0, 0])
    }
    for (const payload of finishedPayloads.values()) {
      expect(payload.latency_ms).toBeGreaterThanOrEqual(0)
    }
    expect(finishedOf('retriever').latency_ms).toBeGreaterThanOrEqual(EMBED_DELAY_MS)

    const [routerOptions, answererOptions] = scriptedLlm.calls
    expect(routerOptions!.prompt[0]).toEqual({ role: 'system', content: ROUTER_PROMPT })
    expect(record(sentSchema(routerOptions!))?.required).toEqual([
      'lang',
      'acts',
      'article_refs',
      'query',
    ])
    expect(requestsOf(scriptedLlm, 'router')).toEqual([
      `Conversation so far:\n(none)\n\nNew message:\n${Q_AI_14}`,
    ])
    expect(sentSchema(answererOptions!)).toEqual(ANSWER_JSON_SCHEMA)
    const [answererRequest] = requestsOf(scriptedLlm, 'answerer')
    expect(
      answererRequest!.startsWith(
        `Answer language: en\n\nQuestion: ${STANDALONE_AI_14}\n\nSources:\n`,
      ),
    ).toBe(true)
    expect(answererRequest).toContain(`[${AI_14_1}] Human oversight\n1. High-risk AI systems`)
    expect(answererRequest).not.toContain('Rejected')
    expect(harness.embedder.queries).toEqual([STANDALONE_AI_14])

    const freshPool = new Pool({ connectionString: seededDatabaseUrl })
    const fresh = createMastra(freshPool)
    try {
      const stored = await fresh.getWorkflow('qa').getWorkflowRunById(turn.runId)
      expect(stored?.status).toBe('success')
      const steps = stored!.steps!
      const routed = record(record(steps.router)?.output)
      expect(routed).toEqual({
        conversation_id: conversationId,
        query: STANDALONE_AI_14,
        filters: { lang: 'en', acts: ['AI Act'], article_refs: [{ act: 'AI Act', article: 14 }] },
      })
      const context = await fresh
        .getWorkflow('qa')
        .getWorkflowRunById(turn.runId, { fields: ['requestContext'] })
      expect(context?.requestContext).toEqual({})
      const loopOutput = record(record(steps['answer-verify'])?.output)
      const final = AttemptSchema.parse(loopOutput)
      expect(new Set(Object.keys(loopOutput ?? {}))).toEqual(
        new Set([
          'conversation_id',
          'query',
          'filters',
          'retrieved',
          'answer',
          'attempts',
          'verifier_errors',
        ]),
      )
      const keys = retrievedKeys(final)
      expect(keys).toHaveLength(harness.profile.retrieval.top_k)
      expect(keys[0]).toBe(AI_14_1)
      expect(keys.slice(0, 5).toSorted()).toEqual(
        [1, 2, 3, 4, 5].map((i) => `32024R1689#014.00${i}`),
      )
      const expectedAnswer = {
        lang: 'en',
        not_found: false,
        claims: [{ text: 'Humans must be able to oversee high-risk AI.', citations: [AI_14_1] }],
      }
      expect(final.answer).toEqual(expectedAnswer)
      expect(stored!.result).toEqual(expectedAnswer)
      expect([final.attempts, final.verifier_errors]).toEqual([1, []])
      const memory = fresh.getMemory(MEMORY)
      expect(await previousFilters(memory, conversationId)).toEqual(routed!.filters)
      expect(await harness.messages(conversationId, memory)).toEqual([
        ['user', Q_AI_14],
        ['assistant', 'Humans must be able to oversee high-risk AI.'],
      ])
    } finally {
      await fresh.shutdown()
      await endWithin(freshPool)
    }
  })

  test('a bad answer is retried once with the reasons', async ({ harness, scriptedLlm }) => {
    const conversationId = await harness.conversation()
    await harness.embedAs(STANDALONE_AI_14, AI_14_1, 'en')
    scriptedLlm.queue('router', route('en', ['AI Act'], [['AI Act', 14]], STANDALONE_AI_14))
    scriptedLlm.queue(
      'answerer',
      answer([['Invented.', [UNKNOWN]]]),
      answer([['Humans oversee high-risk AI.', [AI_14_1]]]),
    )

    const turn = await harness.turn(conversationId, Q_AI_14)

    expect(turn.recorder.path).toEqual(RETRY)
    expect(started(turn)).toEqual(RETRY)
    const [first, second] = requestsOf(scriptedLlm, 'answerer')
    expect(first).not.toContain('Rejected')
    expect(second!.endsWith(`Rejected:\n- ${UNKNOWN} was not retrieved`)).toBe(true)
    const answererUsage = turn.sink.events.flatMap(([kind, p]) =>
      kind === 'step_finished' && p.node === 'answerer' ? [[p.tokens_in, p.tokens_out]] : [],
    )
    const attemptCalls = turn.recorder.calls.filter((call) => call.node === 'answerer')
    expect(attemptCalls).toHaveLength(2)
    expect(answererUsage).toEqual(attemptCalls.map((call) => [call.tokensIn, call.tokensOut]))
    const final = attempt(turn)
    expect(final.answer?.claims).toEqual([
      { text: 'Humans oversee high-risk AI.', citations: [AI_14_1] },
    ])
    expect([final.attempts, final.verifier_errors]).toEqual([2, []])
    expect((await harness.messages(conversationId)).map(([, text]) => text)).toEqual([
      Q_AI_14,
      'Humans oversee high-risk AI.',
    ])
  })

  test('two bad answers end as not found in the question language', async ({
    harness,
    scriptedLlm,
  }) => {
    const conversationId = await harness.conversation()
    const question = 'Czego wymaga art. 14 aktu w sprawie sztucznej inteligencji?'
    const standalone = 'Czego wymaga art. 14 AI Act?'
    await harness.embedAs(standalone, AI_14_1, 'pl')
    scriptedLlm.queue('router', route('pl', ['AI Act'], [['AI Act', 14]], standalone))
    scriptedLlm.queue('answerer', answer([['Zmyślone.', [UNKNOWN]]]), answer([], false))

    const turn = await harness.turn(conversationId, question)

    expect(turn.recorder.path).toEqual(RETRY)
    expect(turn.recorder.calls.map((call) => call.node)).toEqual(['router', 'answerer', 'answerer'])
    const [first] = requestsOf(scriptedLlm, 'answerer')
    expect(first!.startsWith('Answer language: pl\n')).toBe(true)
    expect(first).toContain(`[${AI_14_1}] Nadzór ze strony człowieka`)
    const final = attempt(turn)
    expect(final.retrieved.every((chunk) => chunk.lang === 'pl')).toBe(true)
    expect(final.answer).toEqual({ lang: 'pl', not_found: true, claims: [] })
    expect(turn.result?.status === 'success' && turn.result.result).toEqual(final.answer)
    expect(final.verifier_errors).toEqual(['no claims but not_found is false'])
    expect((await harness.messages(conversationId)).map(([, text]) => text)).toEqual([
      question,
      'Nie znaleziono w źródłach.',
    ])
  })

  test('each turn gets its own retry and its own reasons', async ({ harness, scriptedLlm }) => {
    const conversationId = await harness.conversation()
    const standaloneGdpr = 'When is processing lawful under GDPR Article 6?'
    await harness.embedAs(STANDALONE_AI_14, AI_14_1, 'en')
    await harness.embedAs(standaloneGdpr, GDPR_6_1, 'en')
    scriptedLlm.queue(
      'router',
      route('en', ['AI Act'], [['AI Act', 14]], STANDALONE_AI_14),
      route('en', ['GDPR'], [['GDPR', 6]], standaloneGdpr),
    )
    scriptedLlm.queue(
      'answerer',
      answer([['Invented.', [UNKNOWN]]]),
      answer([['Oversight.', [AI_14_1]]], true),
      answer([['Turn 1 source.', [AI_14_1]]]),
      answer([['Processing needs a legal basis.', [GDPR_6_1]]]),
    )

    const firstTurn = await harness.turn(conversationId, Q_AI_14)
    const afterFirst = attempt(firstTurn)
    const secondTurn = await harness.turn(conversationId, Q_GDPR_6)

    expect(firstTurn.recorder.path).toEqual(RETRY)
    expect(afterFirst.answer).toEqual({ lang: 'en', not_found: true, claims: [] })
    expect(afterFirst.verifier_errors).toEqual(['claims present but not_found is true'])
    expect(secondTurn.recorder.path).toEqual(RETRY)
    const [turn2First, turn2Second] = requestsOf(scriptedLlm, 'answerer').slice(2)
    expect(turn2First).not.toContain('Rejected')
    expect(turn2Second!.endsWith(`Rejected:\n- ${AI_14_1} was not retrieved`)).toBe(true)
    expect(turn2Second).not.toContain(UNKNOWN)
    expect(turn2Second).not.toContain('not_found is true')

    const final = attempt(secondTurn)
    const keys = retrievedKeys(final)
    expect(keys).toHaveLength(harness.profile.retrieval.top_k)
    expect(keys.every((key) => key.startsWith('32016R0679#'))).toBe(true)
    expect(keys[0]).toBe(GDPR_6_1)
    expect(keys.slice(0, 4).toSorted()).toEqual([1, 2, 3, 4].map((i) => `32016R0679#006.00${i}`))
    expect(final.answer?.claims).toEqual([
      { text: 'Processing needs a legal basis.', citations: [GDPR_6_1] },
    ])
    expect([final.attempts, final.verifier_errors]).toEqual([2, []])
    expect((await harness.messages(conversationId)).map(([, text]) => text)).toEqual([
      Q_AI_14,
      'Not found in the sources.',
      Q_GDPR_6,
      'Processing needs a legal basis.',
    ])
  })

  test('a follow-up article takes the act of the conversation', async ({
    harness,
    scriptedLlm,
  }) => {
    const conversationId = await harness.conversation()
    await ai14Turn(harness, scriptedLlm, conversationId)
    await harness.embedAs(STANDALONE_AI_26, AI_26_1, 'en')
    scriptedLlm.queue('router', route('en', [], [[null, 26]], STANDALONE_AI_26))
    scriptedLlm.queue('answerer', answer([['Deployers take measures.', [AI_26_1]]]))

    const turn = await harness.turn(conversationId, Q_AI_26)

    expect(requestsOf(scriptedLlm, 'router')[1]).toBe(
      `Conversation so far:\nUser: ${Q_AI_14}\n` +
        'Assistant: Humans must be able to oversee high-risk AI.\n\n' +
        `New message:\n${Q_AI_26}`,
    )
    const final = attempt(turn)
    const filters = { lang: 'en', acts: [], article_refs: [{ act: 'AI Act', article: 26 }] }
    expect(final.query).toBe(STANDALONE_AI_26)
    expect(final.filters).toEqual(filters)
    expect(await previousFilters(harness.memory, conversationId)).toEqual(filters)
    const keys = retrievedKeys(final)
    expect(keys).toHaveLength(harness.profile.retrieval.top_k)
    expect(keys.every((key) => key.startsWith('32024R1689#026.'))).toBe(true)
  })

  test('a reference without any act is dropped', async ({ harness, scriptedLlm }) => {
    const conversationId = await harness.conversation()
    const query = 'What does Article 5 say?'
    await harness.embedAs(query, GDPR_6_1, 'en')
    scriptedLlm.queue('router', route('en', [], [[null, 5]], query))
    scriptedLlm.queue('answerer', answer([], true))

    const turn = await harness.turn(conversationId, query)

    const final = attempt(turn)
    expect(final.filters.article_refs).toEqual([])
    expect(final.retrieved[0]?.citation_key).toBe(GDPR_6_1)
    expect(final.answer).toEqual({ lang: 'en', not_found: true, claims: [] })
    expect((await harness.messages(conversationId)).at(-1)?.[1]).toBe('Not found in the sources.')
  })

  test.for<[string, object | string]>([
    ['lang', route('de', [], [], 'q')],
    ['act', route('en', ['CCPA'], [], 'q')],
    ['article', route('en', [], [[null, 0]], 'q')],
    ['query', route('en', [], [], '')],
    ['extra-key', { ...route('en', [], [], 'q'), answer: 'x' }],
    ['not-json', 'not json'],
  ])(
    'router output outside the schema fails the turn with usage recorded (%s)',
    async ([, output], { harness, scriptedLlm }) => {
      scriptedLlm.queue('router', output)
      const turn = newTurn()

      await harness.run(await harness.conversation(), 'anything', turn)

      const error = failure(turn)
      expect(error.name).toBe('LLMError')
      expect(String(error.message)).toMatch(/^router .*invalid output/)
      expect(turn.recorder.calls).toEqual([error.call])
      const [call] = turn.recorder.calls
      expect([call!.node, call!.model]).toEqual(['router', MODEL])
      expect(call!.tokensIn).toBeGreaterThan(0)
      expect(call!.tokensOut).toBeGreaterThan(0)
      expect(call!.error?.startsWith('invalid output')).toBe(true)
      expect(turn.recorder.path).toEqual(['router'])
      expect(turn.sink.events).toEqual([['step_started', { node: 'router' }]])
      expect(harness.embedder.queries).toEqual([])
    },
  )

  test('a failed turn keeps its events and usage until the failure', async ({
    harness,
    scriptedLlm,
  }) => {
    await harness.embedAs('q', GDPR_6_1, 'en')
    scriptedLlm.queue('router', route('en', [], [], 'q'))
    scriptedLlm.queue('answerer', '{not json')
    const turn = newTurn()

    await harness.run(await harness.conversation(), 'q', turn)

    const error = failure(turn)
    expect(error.name).toBe('LLMError')
    expect(String(error.message)).toMatch(/^answerer .*invalid output/)
    expect(turn.recorder.path).toEqual(['router', 'retriever', 'answerer'])
    expect(turn.sink.events.map(([kind, p]) => [kind, p.node])).toEqual([
      ['step_started', 'router'],
      ['step_finished', 'router'],
      ['step_started', 'retriever'],
      ['step_finished', 'retriever'],
      ['step_started', 'answerer'],
    ])
    expect(turn.recorder.calls.map((call) => [call.node, call.error === null])).toEqual([
      ['router', true],
      ['answerer', false],
    ])
    expect(turn.recorder.calls[1]!.tokensIn).toBeGreaterThan(0)
  })

  test('after a turn failed mid-graph the next turn starts at the router', async ({
    harness,
    scriptedLlm,
  }) => {
    const conversationId = await harness.conversation()
    await ai14Turn(harness, scriptedLlm, conversationId)
    await harness.embedAs(STANDALONE_AI_26, AI_26_1, 'en')
    scriptedLlm.queue('router', route('en', [], [[null, 26]], STANDALONE_AI_26))
    scriptedLlm.queue('answerer', '{not json')

    await expect(harness.turn(conversationId, Q_AI_26)).rejects.toMatchObject({
      name: 'LLMError',
      message: expect.stringMatching(/^answerer /),
    })

    const question = 'Who must ensure human oversight?'
    await harness.embedAs(question, AI_14_1, 'en')
    scriptedLlm.queue('router', route('en', ['AI Act'], [], question))
    scriptedLlm.queue('answerer', answer([['Deployers assign oversight.', [AI_14_1]]]))

    const turn = await harness.turn(conversationId, question)

    expect(turn.recorder.path).toEqual(NODES)
    expect(started(turn)).toEqual(NODES)
    expect(turn.recorder.calls.map((call) => call.node)).toEqual(['router', 'answerer'])
    expect(requestsOf(scriptedLlm, 'router')[2]).toBe(
      `Conversation so far:\nUser: ${Q_AI_14}\n` +
        'Assistant: Humans must be able to oversee high-risk AI.\n' +
        `User: ${Q_AI_26}\n\nNew message:\n${question}`,
    )
    const final = attempt(turn)
    expect([final.answer, final.attempts]).toEqual([
      { lang: 'en', not_found: false, claims: [expect.anything()] },
      1,
    ])
    expect(final.answer?.claims[0]?.citations).toEqual([AI_14_1])
    expect((await harness.messages(conversationId)).map(([, text]) => text)).toEqual([
      Q_AI_14,
      'Humans must be able to oversee high-risk AI.',
      Q_AI_26,
      question,
      'Deployers assign oversight.',
    ])
  })

  test('the failed turn keeps what its steps returned and no answer', async ({
    harness,
    scriptedLlm,
  }) => {
    await harness.embedAs(STANDALONE_AI_26, AI_26_1, 'en')
    scriptedLlm.queue('router', route('en', ['AI Act'], [['AI Act', 26]], STANDALONE_AI_26))
    scriptedLlm.queue('answerer', '{not json')
    const turn = newTurn()

    await harness.run(await harness.conversation(), Q_AI_26, turn)

    failure(turn)
    const retrieval = stepOutput(turn, 'retriever', RetrievalSchema)
    expect(retrieval.retrieved.length).toBeGreaterThan(0)
    expect(retrievedKeys(retrieval).every((key) => key.startsWith('32024R1689#026.'))).toBe(true)
    expect(turn.result?.steps['answer-verify']?.status).toBe('failed')
  })

  test('a claim without citations is retried, not failed', async ({ harness, scriptedLlm }) => {
    const conversationId = await harness.conversation()
    await harness.embedAs(STANDALONE_AI_14, AI_14_1, 'en')
    scriptedLlm.queue('router', route('en', ['AI Act'], [['AI Act', 14]], STANDALONE_AI_14))
    scriptedLlm.queue(
      'answerer',
      answer([['Uncited.', []]]),
      answer([['Humans oversee high-risk AI.', [AI_14_1]]]),
    )

    const turn = await harness.turn(conversationId, Q_AI_14)

    expect(turn.recorder.path).toEqual(RETRY)
    expect(turn.recorder.calls.every((call) => call.error === null)).toBe(true)
    expect(
      requestsOf(scriptedLlm, 'answerer')[1]!.endsWith('Rejected:\n- claim 1 has no citation'),
    ).toBe(true)
    expect(attempt(turn).answer?.claims).toEqual([
      { text: 'Humans oversee high-risk AI.', citations: [AI_14_1] },
    ])
  })

  test('the answer schema parses an empty citation list, which the verifier rejects', () => {
    const parsed = AnswerOutputSchema.parse({
      claims: [{ text: 'x', citations: [] }],
      not_found: false,
    })
    expect(parsed.claims[0]?.citations).toEqual([])
  })

  test('a router failure after a good turn leaves no stale turn fields', async ({
    harness,
    scriptedLlm,
  }) => {
    const conversationId = await harness.conversation()
    const good = await ai14Turn(harness, scriptedLlm, conversationId)
    scriptedLlm.queue('router', 'not json')
    const turn = newTurn()

    await harness.run(conversationId, Q_AI_26, turn)

    failure(turn)
    expect(Object.keys(turn.result?.steps ?? {}).filter((id) => id !== 'input')).toEqual(['router'])
    expect(await previousFilters(harness.memory, conversationId)).toEqual(
      stepOutput(good, 'router', RoutedSchema).filters,
    )
    expect((await harness.messages(conversationId)).map(([, text]) => text)).toEqual([
      Q_AI_14,
      'Humans must be able to oversee high-risk AI.',
      Q_AI_26,
    ])
  })

  test('the retriever searches within the router acts with the profile top_k', async ({
    harness,
    scriptedLlm,
  }) => {
    const small = harness.withProfile({ ...harness.profile, retrieval: { top_k: 3 } })
    const conversationId = await small.conversation()
    const query = 'What does NIS2 require of essential entities?'
    await small.embedAs(query, AI_14_1, 'en')
    scriptedLlm.queue('router', route('en', ['NIS2'], [], query))
    scriptedLlm.queue('answerer', answer([], true))

    const turn = await small.turn(conversationId, query)

    const keys = retrievedKeys(attempt(turn))
    expect(keys).toHaveLength(3)
    expect(keys.every((key) => key.startsWith('32022L2555#'))).toBe(true)
  })

  test('the router sees the last ten messages of the thread and the new one', async ({
    harness,
    scriptedLlm,
  }) => {
    const conversationId = await harness.conversation()
    for (let i = 0; i < 6; i++) {
      await saveMessage(harness.memory, conversationId, 'user', `question ${i}`)
      await saveMessage(harness.memory, conversationId, 'assistant', `answer ${i}`)
    }
    await harness.embedAs('q', GDPR_6_1, 'en')
    scriptedLlm.queue('router', route('en', [], [], 'q'))
    scriptedLlm.queue('answerer', answer([], true))

    await harness.turn(conversationId, 'new one')

    const history = [1, 2, 3, 4, 5].map((i) => `User: question ${i}\nAssistant: answer ${i}`)
    expect(requestsOf(scriptedLlm, 'router')).toEqual([
      `Conversation so far:\n${history.join('\n')}\n\nNew message:\nnew one`,
    ])
  })

  test('conversations never share history or filters', async ({ harness, scriptedLlm }) => {
    const first = await harness.conversation()
    const second = await harness.conversation()
    await ai14Turn(harness, scriptedLlm, first)
    const query = 'When is processing lawful?'
    await harness.embedAs(query, GDPR_6_1, 'en')
    scriptedLlm.queue('router', route('en', [], [[null, 6]], query))
    scriptedLlm.queue('answerer', answer([], true))

    const turn = await harness.turn(second, query)

    expect(requestsOf(scriptedLlm, 'router')[1]).toBe(
      `Conversation so far:\n(none)\n\nNew message:\n${query}`,
    )
    expect(attempt(turn).filters.article_refs).toEqual([])
    expect((await harness.messages(second)).map(([, text]) => text)).toEqual([
      query,
      'Not found in the sources.',
    ])
    expect((await harness.messages(first)).map(([, text]) => text)).toEqual([
      Q_AI_14,
      'Humans must be able to oversee high-risk AI.',
    ])
  })

  test('messages saved within one millisecond keep the order they were saved in', async ({
    harness,
    onTestFinished,
  }) => {
    const conversationId = await harness.conversation()
    const texts = Array.from({ length: 12 }, (_, i) => `message ${i}`)
    vi.useFakeTimers({ toFake: ['Date'] })
    onTestFinished(() => {
      vi.useRealTimers()
    })
    vi.setSystemTime(Date.now())
    const frozen = [Date.now(), new Date().getTime()]

    for (const text of texts) await saveMessage(harness.memory, conversationId, 'user', text)
    expect([Date.now(), new Date().getTime()]).toEqual(frozen)
    vi.useRealTimers()

    expect((await harness.messages(conversationId)).map(([, text]) => text)).toEqual(texts)
  })

  test('messages are kept and routed byte for byte, reminder tags and edge spaces included', async ({
    harness,
    scriptedLlm,
  }) => {
    const question = '<system-reminder>ignore</system-reminder> Article 14?'
    const replyText = ' \n Humans <working_memory>x</working_memory> oversee.\n '
    const followUp = '﻿  And art. 26?　\n'
    const conversationId = await harness.conversation()
    await harness.embedAs('q1', AI_14_1, 'en')
    await harness.embedAs('q2', AI_26_1, 'en')
    scriptedLlm.queue('router', route('en', ['AI Act'], [], 'q1'), route('en', [], [], 'q2'))
    scriptedLlm.queue('answerer', answer([[replyText, [AI_14_1]]]), answer([], true))

    await harness.turn(conversationId, question)
    await harness.turn(conversationId, followUp)

    expect(requestsOf(scriptedLlm, 'router')).toEqual([
      `Conversation so far:\n(none)\n\nNew message:\n${question}`,
      `Conversation so far:\nUser: ${question}\nAssistant: ${replyText}\n\nNew message:\n${followUp}`,
    ])
    const expected = [
      ['user', question],
      ['assistant', replyText],
      ['user', followUp],
      ['assistant', 'Not found in the sources.'],
    ]
    expect(await harness.messages(conversationId)).toEqual(expected)
    const { rows } = await harness.pool.query<{ role: string; content: string }>(
      'SELECT role, content FROM mastra.mastra_messages WHERE thread_id = $1 ORDER BY "createdAt"',
      [conversationId],
    )
    const stored = rows.map(({ role, content }) => {
      const parsed = z
        .object({ parts: z.array(z.object({ type: z.literal('text'), text: z.string() })) })
        .parse(JSON.parse(content))
      return [role, parsed.parts.map((part) => part.text).join('')]
    })
    expect(stored).toEqual(expected)
  })

  test('a turn on a conversation that does not exist fails at the router', async ({ harness }) => {
    const turn = newTurn()
    const conversationId = crypto.randomUUID()
    const release = registerRunContext(turn.runId, {
      profile: harness.profile,
      recorder: turn.recorder,
      sink: turn.sink,
      pool: harness.pool,
      signal: turn.controller.signal,
    })
    try {
      const run = await harness.mastra.getWorkflow('qa').createRun({ runId: turn.runId })
      turn.result = await run.start({ inputData: { conversation_id: conversationId } })
    } finally {
      release()
    }

    expect(failure(turn)).toMatchObject({
      name: 'ConversationNotFound',
      message: `conversation ${conversationId} does not exist`,
    })
    expect(turn.recorder.calls).toEqual([])
    expect(turn.sink.events).toEqual([['step_started', { node: 'router' }]])
  })

  test('acts the router names twice are searched once', async ({ harness, scriptedLlm }) => {
    const conversationId = await harness.conversation()
    await harness.embedAs('q', GDPR_6_1, 'en')
    scriptedLlm.queue('router', route('en', ['GDPR', 'NIS2', 'GDPR'], [[null, 6]], 'q'))
    scriptedLlm.queue('answerer', answer([], true))

    const turn = await harness.turn(conversationId, 'q')

    expect(stepOutput(turn, 'router', RoutedSchema).filters).toEqual({
      lang: 'en',
      acts: ['GDPR', 'NIS2'],
      article_refs: [],
    })
    expect((await previousFilters(harness.memory, conversationId))?.acts).toEqual(['GDPR', 'NIS2'])
  })

  test('a finished turn returns its search connection to the pool', async ({
    harness,
    scriptedLlm,
    seededDatabaseUrl,
    onTestFinished,
  }) => {
    const stepPool = new Pool({ connectionString: seededDatabaseUrl, max: 1 })
    onTestFinished(() => endWithin(stepPool))
    await harness.embedAs('q', GDPR_6_1, 'en')
    scriptedLlm.queue('router', route('en', [], [], 'q'))
    scriptedLlm.queue('answerer', answer([], true))
    const turn = newTurn()
    turn.pool = stepPool

    await harness.run(await harness.conversation(), 'q', turn)

    expect(turn.result?.status).toBe('success')
    expect([stepPool.totalCount, stepPool.idleCount]).toEqual([1, 1])
  })

  test('a turn persists its step events in order through the store sink', async ({
    harness,
    scriptedLlm,
  }) => {
    const conversationId = await harness.conversation()
    const runId = await startRun(harness.pool, harness.memory, {
      conversationId,
      question: Q_AI_14,
      profile: harness.profile.name,
    })
    await harness.embedAs(STANDALONE_AI_14, AI_14_1, 'en')
    scriptedLlm.queue('router', route('en', ['AI Act'], [['AI Act', 14]], STANDALONE_AI_14))
    scriptedLlm.queue('answerer', answer([['Humans oversee high-risk AI.', [AI_14_1]]]))
    const turn = newTurn(runId)
    let notified = 0
    turn.eventSink = storeSink(harness.pool, runId, turn.controller.signal, () => notified++)

    await harness.run(conversationId, Q_AI_14, turn)

    expect(turn.result?.status).toBe('success')
    const read = await eventsAfter(harness.pool, runId, 0)
    expect(read?.events.map(({ seq, type, payload }) => [seq, type, payload.node])).toEqual(
      NODES.flatMap((name, i) => [
        [2 * i + 1, 'step_started', name],
        [2 * i + 2, 'step_finished', name],
      ]),
    )
    const finished = read!.events.filter((event) => event.type === 'step_finished')
    expect(finished.map((event) => StepFinishedSchema.parse(event.payload).model)).toEqual([
      MODEL,
      null,
      MODEL,
      null,
    ])
    expect(notified).toBe(8)
  })
})

describe('abort guards', () => {
  test('a turn aborted during the router call leaves the thread metadata as it was', async ({
    harness,
    scriptedLlm,
  }) => {
    const conversationId = await harness.conversation()
    const good = await ai14Turn(harness, scriptedLlm, conversationId)
    scriptedLlm.queue('router', route('en', ['GDPR'], [], 'q'))
    const turn = newTurn()
    scriptedLlm.onGenerate = (name) => {
      if (name === 'router') turn.controller.abort(new Error('shutdown'))
    }

    await harness.run(conversationId, Q_AI_26, turn)

    expect(failure(turn)).toMatchObject({ message: 'shutdown' })
    expect(await previousFilters(harness.memory, conversationId)).toEqual(
      stepOutput(good, 'router', RoutedSchema).filters,
    )
    expect(turn.sink.events).toEqual([['step_started', { node: 'router' }]])
  })

  test.for(['answerer', 'verifier'])(
    'a turn aborted at the %s saves no reply',
    async (name, { harness, scriptedLlm }) => {
      const conversationId = await harness.conversation()
      await harness.embedAs('q', GDPR_6_1, 'en')
      scriptedLlm.queue('router', route('en', [], [], 'q'))
      scriptedLlm.queue('answerer', answer([], true))
      const turn = newTurn()
      const abort = (): void => turn.controller.abort(new Error('shutdown'))
      scriptedLlm.onGenerate = (called) => {
        if (name === 'answerer' && called === 'answerer') abort()
      }
      turn.sink.onEmit = (type, payload) => {
        if (name === 'verifier' && type === 'step_started' && payload.node === 'verifier') abort()
      }

      await harness.run(conversationId, 'q', turn)

      expect(failure(turn)).toMatchObject({ message: 'shutdown' })
      expect(await harness.messages(conversationId)).toEqual([['user', 'q']])
      expect(started(turn).at(-1)).toBe(name)
    },
  )
})

function source(key: string, text: string, heading: string | null): Retrieved {
  return { citation_key: key, lang: 'en', text, heading }
}

function answererState(
  lang: 'en' | 'pl',
  query: string,
  retrieved: Retrieved[],
  verifierErrors: string[] = [],
): Parameters<typeof request>[0] {
  return {
    filters: { lang, acts: [], article_refs: [] },
    query,
    retrieved,
    verifier_errors: verifierErrors,
  }
}

describe('answerer request', () => {
  test.for<[string, Parameters<typeof request>[0], string]>([
    [
      'one source with its heading',
      answererState('en', STANDALONE_AI_14, [
        source(AI_14_1, 'Humans oversee.', 'Human oversight'),
      ]),
      `Answer language: en\n\nQuestion: ${STANDALONE_AI_14}\n\nSources:\n` +
        `[${AI_14_1}] Human oversight\nHumans oversee.`,
    ],
    [
      'sources apart by a blank line, a source without heading, the rejected reasons',
      answererState(
        'pl',
        'Czego wymaga art. 14?',
        [
          source(AI_14_1, 'Nadzór.', 'Nadzór ze strony człowieka'),
          source(GDPR_6_1, '(1) Ochrona.', null),
        ],
        [`${UNKNOWN} was not retrieved`, 'claims present but not_found is true'],
      ),
      'Answer language: pl\n\nQuestion: Czego wymaga art. 14?\n\nSources:\n' +
        `[${AI_14_1}] Nadzór ze strony człowieka\nNadzór.\n\n[${GDPR_6_1}]\n(1) Ochrona.\n\n` +
        `Rejected:\n- ${UNKNOWN} was not retrieved\n- claims present but not_found is true`,
    ],
    [
      'no sources',
      answererState('en', 'q', []),
      'Answer language: en\n\nQuestion: q\n\nSources:\n(none)',
    ],
    [
      'no sources after a rejection',
      answererState('en', 'q', [], ['claim 1 has no citation']),
      'Answer language: en\n\nQuestion: q\n\nSources:\n(none)\n\nRejected:\n- claim 1 has no citation',
    ],
    [
      'an empty heading, empty text and line breaks are kept as they are',
      answererState(
        'en',
        'q',
        [source('a#1', 't', ''), source('a#2', '', null), source('a#3', 'x\n\ny', 'H\nI')],
        ['', 'line\nbreak'],
      ),
      'Answer language: en\n\nQuestion: q\n\nSources:\n[a#1]\nt\n\n[a#2]\n\n\n[a#3] H\nI\nx\n\ny' +
        '\n\nRejected:\n- \n- line\nbreak',
    ],
  ])('%s', ([, state, text]) => {
    expect(request(state)).toBe(text)
  })
})

const CLAIM = { text: 't', citations: ['k'] }

describe('answerer output', () => {
  test.for<[string, string, unknown]>([
    [
      'valid',
      '{"claims": [{"text": "t", "citations": ["k"]}], "not_found": false}',
      { claims: [CLAIM], not_found: false },
    ],
    [
      'an empty citation list',
      '{"claims": [{"text": "t", "citations": []}], "not_found": false}',
      { claims: [{ text: 't', citations: [] }], not_found: false },
    ],
    ['not found', '{"claims": [], "not_found": true}', { claims: [], not_found: true }],
  ])('parses: %s', ([, output, parsed]) => {
    expect(parseOutput(AnswerOutputSchema, output)).toEqual({ success: true, data: parsed })
  })

  test.for<[string, string, string]>([
    [
      'a claim without citations',
      '{"claims": [{"text": "t"}], "not_found": false}',
      'invalid output at claims.0.citations: Invalid input: expected array, received undefined',
    ],
    [
      'a citation that is not a string',
      '{"claims": [{"text": "t", "citations": [1]}], "not_found": false}',
      'invalid output at claims.0.citations.0: Invalid input: expected string, received number',
    ],
    [
      'not_found as a string',
      '{"claims": [], "not_found": "false"}',
      'invalid output at not_found: Invalid input: expected boolean, received string',
    ],
    [
      'not_found as 0',
      '{"claims": [], "not_found": 0}',
      'invalid output at not_found: Invalid input: expected boolean, received number',
    ],
    [
      'not_found null',
      '{"claims": [], "not_found": null}',
      'invalid output at not_found: Invalid input: expected boolean, received null',
    ],
    [
      'claims not a list',
      '{"claims": {"text": "t"}, "not_found": false}',
      'invalid output at claims: Invalid input: expected array, received object',
    ],
    [
      'a claim that is not an object',
      '{"claims": ["t"], "not_found": false}',
      'invalid output at claims.0: Invalid input: expected object, received string',
    ],
    [
      'the second claim has no text',
      '{"claims": [{"text": "t", "citations": ["k"]}, {"text": 5, "citations": []}], "not_found": false}',
      'invalid output at claims.1.text: Invalid input: expected string, received number',
    ],
    [
      'an extra key in a claim',
      '{"claims": [{"text": "t", "citations": ["k"], "quote": "q"}], "not_found": false}',
      'invalid output at claims.0: Unrecognized key: "quote"',
    ],
    [
      'an extra top-level key',
      '{"claims": [], "not_found": true, "lang": "en"}',
      'invalid output: Unrecognized key: "lang"',
    ],
    [
      'missing claims',
      '{"not_found": true}',
      'invalid output at claims: Invalid input: expected array, received undefined',
    ],
    [
      'missing not_found',
      '{"claims": []}',
      'invalid output at not_found: Invalid input: expected boolean, received undefined',
    ],
  ])('fails with the first issue: %s', ([, output, error]) => {
    expect(parseOutput(AnswerOutputSchema, output)).toEqual({ success: false, error })
  })
})

describe('abort', () => {
  test('an aborted search ends the turn and discards its busy connection', async ({
    harness,
    scriptedLlm,
    seededDatabaseUrl,
    onTestFinished,
  }) => {
    await harness.embedAs('q', GDPR_6_1, 'en')
    scriptedLlm.queue('router', route('en', [], [], 'q'))
    const conversationId = await harness.conversation()
    const stepPool = new Pool({ connectionString: seededDatabaseUrl, max: 1 })
    onTestFinished(() => endWithin(stepPool))
    const locker = new Client({ connectionString: seededDatabaseUrl })
    await locker.connect()
    onTestFinished(() => locker.end())
    await locker.query('BEGIN')
    await locker.query('LOCK TABLE chunks IN ACCESS EXCLUSIVE MODE')
    const turn = newTurn()
    turn.pool = stepPool

    const running = harness.run(conversationId, 'q', turn)
    // Not from the locker: a transaction sees pg_stat_activity as of its first read.
    await expect
      .poll(
        async () =>
          (
            await harness.pool.query<{ waiting: number }>(
              "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock'" +
                " AND query LIKE '%FROM chunks%' AND pid <> pg_backend_pid()",
            )
          ).rows[0]?.waiting,
        { timeout: 10_000, interval: 20 },
      )
      .toBe(1)
    turn.controller.abort(new Error('shutdown'))
    await running
    await locker.query('ROLLBACK')

    expect(failure(turn)).toMatchObject({ message: 'shutdown' })
    expect([stepPool.totalCount, stepPool.idleCount]).toEqual([0, 0])
    expect(turn.recorder.path).toEqual(['router', 'retriever'])
    expect(turn.sink.events.map(([kind, p]) => [kind, p.node])).toEqual([
      ['step_started', 'router'],
      ['step_finished', 'router'],
      ['step_started', 'retriever'],
    ])
  })
})

describe('logging', () => {
  test('a failed model call writes nothing to the console', async ({ harness }) => {
    const written: string[] = []
    const capture = (...args: unknown[]): void => {
      written.push(args.map(String).join(' '))
    }
    const spies = [
      ...(['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((level) =>
        vi.spyOn(console, level).mockImplementation(capture),
      ),
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (capture(chunk), true)),
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => (capture(chunk), true)),
    ]
    const turn = newTurn()
    try {
      await harness.run(await harness.conversation(), 'a secret question', turn)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }

    expect(failure(turn)).toMatchObject({ name: 'LLMError' })
    expect(turn.recorder.calls.map((call) => call.node)).toEqual(['router'])
    expect(written).toEqual([])
  })
})

describe('run context', () => {
  test('a run started without a registered context fails at its first step', async ({ mastra }) => {
    const run = await mastra.getWorkflow('qa').createRun()

    const result = await run.start({ inputData: { conversation_id: crypto.randomUUID() } })

    expect(result.status).toBe('failed')
    expect(result.status === 'failed' && errorFields(result.error)).toMatchObject({
      name: 'TypeError',
      message: `workflow run ${run.runId} has no RunContext`,
    })
    const steps = Object.entries(result.steps).filter(([id]) => id !== 'input')
    expect(steps.map(([id, step]) => [id, step.status])).toEqual([['router', 'failed']])
  })

  test('a stale release does not withdraw a later context of the same run', async ({ pool }) => {
    const turn = newTurn()
    const context = (signal: AbortSignal) => ({
      profile: harnessProfile,
      recorder: turn.recorder,
      sink: turn.sink,
      pool,
      signal,
    })
    const first = context(new AbortController().signal)
    const second = context(new AbortController().signal)
    const releaseFirst = registerRunContext(turn.runId, first)
    releaseFirst()
    const releaseSecond = registerRunContext(turn.runId, second)

    releaseFirst()

    expect(runContext(turn.runId)).toBe(second)
    releaseSecond()
    expect(() => runContext(turn.runId)).toThrow(TypeError)
  })

  test('a context is registered once per run and withdrawn by its owner', async ({ pool }) => {
    const turn = newTurn()
    const context = {
      profile: await loadProfile('local-qwen'),
      recorder: turn.recorder,
      sink: turn.sink,
      pool,
      signal: new AbortController().signal,
    }
    const release = registerRunContext(turn.runId, context)

    expect(runContext(turn.runId)).toBe(context)
    expect(() => registerRunContext(turn.runId, context)).toThrow(
      `run ${turn.runId} already has a RunContext`,
    )
    release()
    expect(() => runContext(turn.runId)).toThrow(TypeError)
  })

  test('the store sink appends step events to the run and then notifies', async ({
    pool,
    mastra,
  }) => {
    const memory = mastra.getMemory(MEMORY)
    const conversationId = await (
      await import('../../src/runs/conversations.ts')
    ).createConversation(memory)
    const runId = await startRun(pool, memory, { conversationId, question: 'q', profile: 'p' })
    const notified: number[] = []
    const controller = new AbortController()
    const sink = storeSink(pool, runId, controller.signal, () => notified.push(notified.length))

    await sink.emit('step_started', { node: 'router' })
    await sink.emit('step_finished', { node: 'router', model: null })
    controller.abort()
    await expect(sink.emit('step_started', { node: 'retriever' })).rejects.toThrow()

    const read = await eventsAfter(pool, runId, 0)
    expect(read?.status).toBe('running')
    expect(read?.events.map(({ seq, type, payload }) => [seq, type, payload])).toEqual([
      [1, 'step_started', { node: 'router' }],
      [2, 'step_finished', { node: 'router', model: null }],
    ])
    expect(notified).toEqual([0, 1])
  })
})
