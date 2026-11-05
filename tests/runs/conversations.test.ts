import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { MastraMemory } from '@mastra/core/memory'
import { Client, Pool } from 'pg'
import { inject } from 'vitest'
import { upgradeHead } from '../../src/db/index.ts'
import type { Lang } from '../../src/ingest/acts.ts'
import { citationKey, loadCorpus } from '../../src/ingest/chunker.ts'
import { Decimal } from '../../src/decimal.ts'
import { ConversationNotFound } from '../../src/mastra/memory.ts'
import * as conversations from '../../src/runs/conversations.ts'
import type { Payload, RunTotals } from '../../src/runs/conversations.ts'
import * as invoiceStore from '../../src/runs/invoices.ts'
import type { Database } from '../../src/runs/transaction.ts'
import * as readModel from '../../src/runs/turns.ts'
import type { Citation, TurnMetrics } from '../../src/runs/turns.ts'
import { endWithin } from '../support/databases.ts'
import { describe, expect, test as harnessTest } from '../support/harness.ts'
import { connect, expectIdle, intercepted, openMastra } from './helpers.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')
const CHUNKS = new Map(
  (await loadCorpus(ROOT)).map((chunk) => [`${citationKey(chunk)} ${chunk.lang}`, chunk]),
)

const TOTALS: RunTotals = {
  tokensIn: 1200,
  tokensOut: 340,
  costUsd: new Decimal('0.012345'),
  latencyMs: 4321,
  path: ['router', 'retriever', 'answerer', 'verifier'],
  models: ['ollama_chat/qwen3.6:27b'],
}
const AI_ACT_14_1 = '32024R1689#014.001'
const GDPR_4_1 = '32016R0679#art_4.pt_1'
const GDPR_50_A = '32016R0679#art_50.pt_1'

function final(lang: string, ...keys: string[]): Payload {
  return {
    lang,
    not_found: keys.length === 0,
    claims: keys.map((key, i) => ({ text: `claim ${i}`, citations: [key] })),
  }
}

const test = harnessTest
  .extend('memory', { scope: 'worker' }, async ({}, { onCleanup }): Promise<MastraMemory> => {
    const mastra = await openMastra(inject('testDatabaseUrl'))
    onCleanup(() => mastra.close())
    return mastra.memory
  })
  .extend('pool', async ({ testSettings }, { onCleanup }): Promise<Pool> => {
    // One connection, so a transaction left open would be seen by the next statement.
    const pool = new Pool({ connectionString: testSettings.databaseUrl, max: 1 })
    onCleanup(() => endWithin(pool))
    return pool
  })
  .extend('observer', async ({ testSettings }, { onCleanup }): Promise<Client> => {
    const client = await connect(testSettings.databaseUrl)
    onCleanup(() => client.end())
    return client
  })

interface RunRow {
  kind: string
  thread_id: string
  conversation_id: string | null
  question: string | null
  status: string
  profile: string
  tokens_in: number
  tokens_out: number
  cost_usd: string
  latency_ms: number | null
  path: string[]
  models: string[]
  error: string | null
  finished: boolean
}

async function runRow(observer: Client, runId: string): Promise<RunRow> {
  const { rows } = await observer.query<RunRow>(
    'SELECT kind, thread_id, conversation_id, question, status, profile, tokens_in,' +
      ' tokens_out, cost_usd, latency_ms, path, models, error, finished_at IS NOT NULL AS finished' +
      ' FROM runs WHERE id = $1',
    [runId],
  )
  expect(rows).toHaveLength(1)
  return rows[0]!
}

async function events(observer: Client, runId: string): Promise<[number, string, unknown][]> {
  const { rows } = await observer.query<{ seq: number; type: string; payload: unknown }>(
    'SELECT seq, type, payload FROM run_events WHERE run_id = $1 ORDER BY seq',
    [runId],
  )
  return rows.map((row) => [row.seq, row.type, row.payload])
}

async function types(observer: Client, runId: string): Promise<string[]> {
  return (await events(observer, runId)).map(([, type]) => type)
}

async function newRun(
  db: Database,
  memory: MastraMemory,
  question = 'q',
): Promise<[string, string]> {
  const conversation = await conversations.createConversation(memory)
  const run = await conversations.startRun(db, memory, {
    conversationId: conversation,
    question,
    profile: 'local-qwen',
  })
  return [conversation, run]
}

describe('run store', () => {
  test('startRun commits a running qa row', async ({ pool, memory, observer }) => {
    const [conversation, run] = await newRun(pool, memory, 'What does Article 14 require?')

    await expectIdle(pool, observer)
    expect(await runRow(observer, run)).toEqual({
      kind: 'qa',
      thread_id: conversation,
      conversation_id: conversation,
      question: 'What does Article 14 require?',
      status: 'running',
      profile: 'local-qwen',
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: '0.000000',
      latency_ms: null,
      path: [],
      models: [],
      error: null,
      finished: false,
    })
  })

  test('a second running run on a conversation is a conflict', async ({
    pool,
    memory,
    observer,
  }) => {
    const [conversation, run] = await newRun(pool, memory)
    const [other] = await newRun(pool, memory)

    const conflict = conversations.startRun(pool, memory, {
      conversationId: conversation,
      question: 'q2',
      profile: 'p',
    })
    await expect(conflict).rejects.toBeInstanceOf(conversations.RunConflict)
    await expectIdle(pool, observer)

    await conversations.finishRun(pool, run, TOTALS, { final: final('en') })
    const second = await conversations.startRun(pool, memory, {
      conversationId: conversation,
      question: 'q2',
      profile: 'p',
    })

    const { rows } = await observer.query(
      'SELECT id, status FROM runs WHERE conversation_id = $1 ORDER BY created_at',
      [conversation],
    )
    expect(rows).toEqual([
      { id: run, status: 'done' },
      { id: second, status: 'running' },
    ])
    expect(other).not.toBe(conversation)
  })

  test('startRun on an unknown conversation', async ({ pool, memory, observer }) => {
    const unknown = randomUUID()

    await expect(
      conversations.startRun(pool, memory, {
        conversationId: unknown,
        question: 'q',
        profile: 'p',
      }),
    ).rejects.toBeInstanceOf(ConversationNotFound)
    const { rows } = await observer.query('SELECT id FROM runs WHERE conversation_id = $1', [
      unknown,
    ])
    expect(rows).toEqual([])
  })

  test('concurrent appends get gapless sequence numbers', async ({ memory, testSettings }) => {
    const writers = new Pool({ connectionString: testSettings.databaseUrl, max: 6 })
    try {
      const [, run] = await newRun(writers, memory)

      const results = await Promise.all(
        Array.from({ length: 6 }, async (_, index) => {
          const seqs: number[] = []
          for (let n = 0; n < 8; n++) {
            seqs.push(
              await conversations.appendEvent(writers, run, 'step_started', {
                node: `w${index}-${n}`,
              }),
            )
          }
          return seqs
        }),
      )

      const assigned = results.flat().toSorted((a, b) => a - b)
      expect(assigned).toEqual(Array.from({ length: 48 }, (_, i) => i + 1))
      const stored = await conversations.eventsAfter(writers, run, 0)
      expect(stored!.events.map((event) => event.seq)).toEqual(assigned)
      const nodes = stored!.events.map((event) => event.payload.node)
      expect(nodes).toHaveLength(48)
      expect(new Set(nodes)).toEqual(
        new Set(
          Array.from({ length: 6 }, (_writer, i) =>
            Array.from({ length: 8 }, (_seq, n) => `w${i}-${n}`),
          ).flat(),
        ),
      )
    } finally {
      await writers.end()
    }
  })

  test('appendEvent rejects terminal types and finished runs', async ({
    pool,
    memory,
    observer,
  }) => {
    const [, run] = await newRun(pool, memory)
    for (const terminal of ['final', 'error']) {
      await expect(
        // @ts-expect-error the type excludes terminal events; the store rejects them at runtime too
        conversations.appendEvent(pool, run, terminal, {}),
      ).rejects.toThrow(`"${terminal}" is not a step event`)
    }
    await expect(
      conversations.appendEvent(pool, randomUUID(), 'step_started', { node: 'router' }),
    ).rejects.toBeInstanceOf(conversations.RunNotRunning)

    await conversations.finishRun(pool, run, TOTALS, { error: 'boom' })
    await expect(
      conversations.appendEvent(pool, run, 'step_started', { node: 'router' }),
    ).rejects.toBeInstanceOf(conversations.RunNotRunning)

    expect(await types(observer, run)).toEqual(['error'])
  })

  test('finishing done writes totals and final as the last event', async ({
    pool,
    memory,
    observer,
  }) => {
    const [conversation, run] = await newRun(pool, memory)
    await conversations.appendEvent(pool, run, 'step_started', { node: 'router' })
    await conversations.appendEvent(pool, run, 'step_finished', { node: 'router', tokens_in: 5 })
    const answer = final('en', AI_ACT_14_1)

    const seq = await conversations.finishRun(pool, run, TOTALS, { final: answer })

    expect(seq).toBe(3)
    await expectIdle(pool, observer)
    expect(await runRow(observer, run)).toEqual({
      kind: 'qa',
      thread_id: conversation,
      conversation_id: conversation,
      question: 'q',
      status: 'done',
      profile: 'local-qwen',
      tokens_in: 1200,
      tokens_out: 340,
      cost_usd: '0.012345',
      latency_ms: 4321,
      path: ['router', 'retriever', 'answerer', 'verifier'],
      models: ['ollama_chat/qwen3.6:27b'],
      error: null,
      finished: true,
    })
    expect((await events(observer, run)).at(-1)).toEqual([3, 'final', answer])
  })

  test('finishing failed writes the error status, totals and error event', async ({
    pool,
    memory,
    observer,
  }) => {
    const [, run] = await newRun(pool, memory)
    await conversations.appendEvent(pool, run, 'step_started', { node: 'router' })
    const totals = { ...TOTALS, path: ['router'], latencyMs: 180000 }

    await conversations.finishRun(pool, run, totals, { error: 'router: LLM timeout' })

    expect(await runRow(observer, run)).toMatchObject({
      status: 'failed',
      profile: 'local-qwen',
      tokens_in: 1200,
      tokens_out: 340,
      cost_usd: '0.012345',
      latency_ms: 180000,
      path: ['router'],
      models: ['ollama_chat/qwen3.6:27b'],
      error: 'router: LLM timeout',
      finished: true,
    })
    expect(await events(observer, run)).toEqual([
      [1, 'step_started', { node: 'router' }],
      [2, 'error', { message: 'router: LLM timeout' }],
    ])
  })

  test('finishRun is one transaction', async ({ pool, memory, observer }) => {
    const [, run] = await newRun(pool, memory)
    await conversations.appendEvent(pool, run, 'step_started', { node: 'router' })
    const unserializable = { ...final('en', AI_ACT_14_1), bad: 1n }

    await expect(
      conversations.finishRun(pool, run, TOTALS, { final: unserializable }),
    ).rejects.toThrow(TypeError)

    await expectIdle(pool, observer)
    expect(await runRow(observer, run)).toMatchObject({
      status: 'running',
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: '0.000000',
      latency_ms: null,
      finished: false,
    })
    expect(await types(observer, run)).toEqual(['step_started'])
  })

  test('finishRun rolls back its event when the run update fails', async ({
    pool,
    memory,
    observer,
  }) => {
    const [, run] = await newRun(pool, memory)
    await conversations.appendEvent(pool, run, 'step_started', { node: 'router' })
    const rejected = { ...TOTALS, tokensIn: -1 }

    await expect(
      conversations.finishRun(pool, run, rejected, { final: final('en', AI_ACT_14_1) }),
    ).rejects.toMatchObject({ code: '23514' })

    await expectIdle(pool, observer)
    expect(await runRow(observer, run)).toMatchObject({
      status: 'running',
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: '0.000000',
      latency_ms: null,
    })
    expect(await types(observer, run)).toEqual(['step_started'])
  })

  test('a run finishes only once', async ({ pool, memory, observer }) => {
    const [, run] = await newRun(pool, memory)
    await conversations.finishRun(pool, run, TOTALS, { final: final('en') })

    await expect(
      conversations.finishRun(pool, run, TOTALS, { error: 'late' }),
    ).rejects.toBeInstanceOf(conversations.RunNotRunning)

    expect(await types(observer, run)).toEqual(['final'])
    expect((await runRow(observer, run)).status).toBe('done')
  })

  test('finishRun adds the totals to what the row already holds', async ({ pool, observer }) => {
    const conversation = randomUUID()
    const {
      rows: [row],
    } = await observer.query<{ id: string }>(
      'INSERT INTO runs (kind, thread_id, conversation_id, question, status, profile, tokens_in,' +
        ' tokens_out, cost_usd, latency_ms, path, models)' +
        " VALUES ('qa', $1, $2, 'q', 'running', 'p', 10, 20, 0.5, 100, '{router}', '{m1,m2}')" +
        ' RETURNING id',
      [conversation, conversation],
    )
    const totals = { ...TOTALS, models: ['m2', 'new', 'm1'] }

    await conversations.finishRun(pool, row!.id, totals, { final: final('en') })

    expect(await runRow(observer, row!.id)).toMatchObject({
      status: 'done',
      tokens_in: 1210,
      tokens_out: 360,
      cost_usd: '0.512345',
      latency_ms: 4421,
      path: ['router', 'router', 'retriever', 'answerer', 'verifier'],
      models: ['m1', 'm2', 'new'],
      finished: true,
    })
  })

  test('finishRun rejects an extraction run', async ({ pool, observer }) => {
    const run = await invoiceStore.createInvoice(pool, {
      invoiceId: randomUUID(),
      pdfPath: 'x.pdf',
      profile: 'p',
    })

    await expect(
      conversations.finishRun(pool, run, TOTALS, { final: final('en') }),
    ).rejects.toThrow(`run ${run} is an extraction run; it ends with its invoice`)

    await expectIdle(pool, observer)
    expect(await runRow(observer, run)).toMatchObject({
      status: 'running',
      tokens_in: 0,
      finished: false,
    })
    expect(await types(observer, run)).toEqual([])
  })

  test('createConversation creates a mokosz Memory thread', async ({ memory }) => {
    const conversation = await conversations.createConversation(memory)

    const thread = await memory.getThreadById({ threadId: conversation })
    expect(thread).toMatchObject({ id: conversation, resourceId: 'mokosz' })
    expect(conversation).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  test.for([
    [undefined, undefined],
    [{ lang: 'en', not_found: true, claims: [] }, 'x'],
  ] as const)(
    'finishRun needs exactly one outcome: %j',
    async ([answer, error], { pool, memory, observer }) => {
      const [, run] = await newRun(pool, memory)

      await expect(
        conversations.finishRun(pool, run, TOTALS, { final: answer, error }),
      ).rejects.toThrow('finishRun needs exactly one of final or error')
      expect((await runRow(observer, run)).status).toBe('running')
    },
  )

  test('eventsAfter', async ({ pool, memory }) => {
    const [, run] = await newRun(pool, memory)
    await conversations.appendEvent(pool, run, 'step_started', { node: 'router' })
    const running = await conversations.eventsAfter(pool, run, 0)
    await conversations.appendEvent(pool, run, 'step_finished', { node: 'router' })
    await conversations.finishRun(pool, run, TOTALS, { final: final('en') })

    const everything = await conversations.eventsAfter(pool, run, 0)
    const tail = await conversations.eventsAfter(pool, run, 2)

    expect(running!.status).toBe('running')
    expect(running!.events.map((e) => [e.seq, e.type])).toEqual([[1, 'step_started']])
    expect(everything!.status).toBe('done')
    expect(everything!.events.map((e) => [e.seq, e.type])).toEqual([
      [1, 'step_started'],
      [2, 'step_finished'],
      [3, 'final'],
    ])
    expect(tail!.events).toEqual([{ seq: 3, type: 'final', payload: final('en') }])
    expect(await conversations.eventsAfter(pool, run, 3)).toEqual({ status: 'done', events: [] })
    expect(await conversations.eventsAfter(pool, randomUUID(), 0)).toBeNull()
  })

  test('eventsAfter never reports a terminal status without its terminal event', async ({
    pool,
    memory,
    testSettings,
  }) => {
    const [, run] = await newRun(pool, memory)
    await conversations.appendEvent(pool, run, 'step_started', { node: 'router' })
    const other = new Pool({ connectionString: testSettings.databaseUrl, max: 1 })
    let finished = false
    // The run finishes on another connection right after the first read, whichever it is.
    const reader = intercepted(pool, async (sql, execute) => {
      const result = await execute()
      if (!finished && sql !== 'BEGIN') {
        finished = true
        await conversations.finishRun(other, run, TOTALS, { final: final('en') })
      }
      return result
    })
    try {
      const seen = await conversations.eventsAfter(reader, run, 0)

      expect(finished).toBe(true)
      expect(
        seen!.status === 'running' || ['final', 'error'].includes(seen!.events.at(-1)!.type),
      ).toBe(true)
      expect(seen!.events.map((e) => e.type)).toEqual(['step_started', 'final'])
    } finally {
      await other.end()
    }
  })

  test('turns come in time order with answer, metrics and citations', async ({
    seededDatabaseUrl,
    memory,
    observer,
  }) => {
    // Without index scans the rows come back in heap order, so only ORDER BY gives time order.
    const pool = new Pool({
      connectionString: seededDatabaseUrl,
      max: 1,
      options: '-c enable_indexscan=off -c enable_bitmapscan=off -c enable_indexonlyscan=off',
    })
    try {
      const conversation = await conversations.createConversation(memory)
      const questions = ['What does Article 14 require?', 'Czym są dane osobowe?', 'And art. 26?']
      questions.push('Hm')
      const runs: string[] = []
      for (const question of questions) {
        const run = await conversations.startRun(pool, memory, {
          conversationId: conversation,
          question,
          profile: 'local-qwen',
        })
        runs.push(run)
        if (question === questions[0]) {
          await conversations.finishRun(pool, run, TOTALS, {
            final: final('en', AI_ACT_14_1, AI_ACT_14_1),
          })
        } else if (question === questions[1]) {
          await conversations.finishRun(pool, run, TOTALS, {
            final: final('pl', GDPR_4_1, GDPR_50_A),
          })
        } else if (question === questions[2]) {
          await conversations.finishRun(pool, run, TOTALS, { error: 'answerer: invalid JSON' })
        }
      }
      // The PL turn is moved first in time while its row is physically last after the update.
      await observer.query(
        "UPDATE runs SET created_at = created_at - interval '1 hour' WHERE id = $1",
        [runs[1]],
      )
      const { rows: settings } = await pool.query<{ enable_indexscan: string }>(
        'SHOW enable_indexscan',
      )
      expect(settings).toEqual([{ enable_indexscan: 'off' }])

      const result = (await readModel.turns(pool, memory, conversation))!

      expect(result.map((turn) => turn.run_id)).toEqual([runs[1], runs[0], runs[2], runs[3]])
      expect(result.map((turn) => turn.question)).toEqual([1, 0, 2, 3].map((i) => questions[i]))
      expect(result.map((turn) => turn.status)).toEqual(['done', 'done', 'failed', 'running'])
      expect(result.map((turn) => turn.answer)).toEqual([
        final('pl', GDPR_4_1, GDPR_50_A),
        final('en', AI_ACT_14_1, AI_ACT_14_1),
        null,
        null,
      ])
      expect(result[0]!.citations).toEqual({
        [GDPR_4_1]: citation(GDPR_4_1, 'pl', 'GDPR art. 4 pkt 1'),
        [GDPR_50_A]: citation(GDPR_50_A, 'pl', 'GDPR art. 50 lit. a'),
      })
      expect(result[1]!.citations).toEqual({
        [AI_ACT_14_1]: citation(AI_ACT_14_1, 'en', 'AI Act Art. 14(1)'),
      })
      expect(result[1]!.citations[AI_ACT_14_1]!.article).toBe(14)
      expect(result[1]!.citations[AI_ACT_14_1]!.heading).toBeTruthy()
      expect(result[2]!.citations).toEqual({})
      expect(result[3]!.citations).toEqual({})
      const finished: TurnMetrics = {
        path: [...TOTALS.path],
        models: [...TOTALS.models],
        tokens_in: TOTALS.tokensIn,
        tokens_out: TOTALS.tokensOut,
        cost_usd: '0.012345',
        latency_ms: TOTALS.latencyMs,
      }
      expect(result.slice(0, 3).map((turn) => turn.metrics)).toEqual([finished, finished, finished])
      expect(result[3]!.metrics).toEqual({
        path: [],
        models: [],
        tokens_in: 0,
        tokens_out: 0,
        cost_usd: '0.000000',
        latency_ms: null,
      })
      const instants = result.map((turn) => Date.parse(turn.created_at))
      expect(instants[0]! < instants[1]! && instants[1]! < instants[2]!).toBe(true)
    } finally {
      await pool.end()
    }
  })

  test('turns of unknown and empty conversations', async ({ pool, memory }) => {
    expect(await readModel.turns(pool, memory, randomUUID())).toBeNull()
    expect(
      await readModel.turns(pool, memory, await conversations.createConversation(memory)),
    ).toEqual([])
  })

  test('events are numbered from 1 in the order they were emitted', async ({ pool, memory }) => {
    const [, run] = await newRun(pool, memory)
    await conversations.appendEvent(pool, run, 'step_started', { node: 'router' })
    await conversations.appendEvent(pool, run, 'step_finished', { node: 'router', n: 1 })
    await conversations.appendEvent(pool, run, 'step_started', { node: 'retriever' })
    await conversations.appendEvent(pool, run, 'step_finished', { node: 'retriever', n: 2 })
    await conversations.finishRun(pool, run, TOTALS, { final: final('en') })

    const read = (await conversations.eventsAfter(pool, run, 0))!

    expect(read.status).toBe('done')
    expect(read.events).toStrictEqual([
      { seq: 1, type: 'step_started', payload: { node: 'router' } },
      { seq: 2, type: 'step_finished', payload: { node: 'router', n: 1 } },
      { seq: 3, type: 'step_started', payload: { node: 'retriever' } },
      { seq: 4, type: 'step_finished', payload: { node: 'retriever', n: 2 } },
      { seq: 5, type: 'final', payload: final('en') },
    ])
  })

  test('events of different runs are numbered independently', async ({ pool, memory }) => {
    const [, first] = await newRun(pool, memory)
    const [, second] = await newRun(pool, memory)
    await conversations.appendEvent(pool, first, 'step_started', { node: 'a' })
    await conversations.appendEvent(pool, second, 'step_started', { node: 'b' })
    await conversations.appendEvent(pool, first, 'step_finished', { node: 'a' })

    const one = (await conversations.eventsAfter(pool, first, 0))!
    const two = (await conversations.eventsAfter(pool, second, 0))!

    expect(one.events.map((e) => [e.seq, e.payload])).toEqual([
      [1, { node: 'a' }],
      [2, { node: 'a' }],
    ])
    expect(two.events.map((e) => [e.seq, e.payload])).toEqual([[1, { node: 'b' }]])
  })

  test('created_at is ISO 8601 UTC with milliseconds, whatever the session time zone', async ({
    seededDatabaseUrl,
    memory,
    observer,
  }) => {
    const pool = new Pool({
      connectionString: seededDatabaseUrl,
      max: 1,
      options: '-c timezone=America/New_York',
    })
    try {
      const conversation = await conversations.createConversation(memory)
      const ids: string[] = []
      for (const question of ['fresh', 'fraction', 'whole second']) {
        ids.push(
          await conversations.startRun(pool, memory, {
            conversationId: conversation,
            question,
            profile: 'local-qwen',
          }),
        )
        await conversations.finishRun(pool, ids.at(-1)!, TOTALS, { error: 'x' })
      }
      await observer.query('UPDATE runs SET created_at = $1::timestamptz WHERE id = $2', [
        '2026-03-08 04:05:06.789987+00',
        ids[1],
      ])
      await observer.query('UPDATE runs SET created_at = $1::timestamptz WHERE id = $2', [
        '2026-03-08 06:05:06+02',
        ids[2],
      ])

      const result = (await readModel.turns(pool, memory, conversation))!

      const created = Object.fromEntries(result.map((turn) => [turn.question, turn.created_at]))
      expect(created.fresh).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
      expect(created.fraction).toBe('2026-03-08T04:05:06.789Z')
      expect(created['whole second']).toBe('2026-03-08T04:05:06.000Z')
    } finally {
      await pool.end()
    }
  })

  test('failInterruptedRuns fails running runs with an error event', async ({
    throwawayDatabaseUrl: url,
  }) => {
    await upgradeHead(url)
    const mastra = await openMastra(url)
    const pool = new Pool({ connectionString: url, max: 1 })
    const observer = await connect(url)
    try {
      const [, first] = await newRun(pool, mastra.memory)
      const [, second] = await newRun(pool, mastra.memory)
      const [, finished] = await newRun(pool, mastra.memory)
      await conversations.appendEvent(pool, first, 'step_started', { node: 'router' })
      await conversations.appendEvent(pool, first, 'step_finished', { node: 'router' })
      await conversations.finishRun(pool, finished, TOTALS, { final: final('en') })

      const failed = await conversations.failInterruptedRuns(pool)
      const again = await conversations.failInterruptedRuns(pool)

      expect(new Set(failed)).toEqual(new Set([first, second]))
      expect(failed).toHaveLength(2)
      expect(again).toEqual([])
      for (const run of [first, second]) {
        expect(await runRow(observer, run)).toMatchObject({
          status: 'failed',
          error: conversations.INTERRUPTED,
          finished: true,
        })
      }
      expect(await events(observer, first)).toEqual([
        [1, 'step_started', { node: 'router' }],
        [2, 'step_finished', { node: 'router' }],
        [3, 'error', { message: 'interrupted by restart' }],
      ])
      expect(await events(observer, second)).toEqual([
        [1, 'error', { message: 'interrupted by restart' }],
      ])
      expect((await runRow(observer, finished)).status).toBe('done')
      expect(await types(observer, finished)).toEqual(['final'])
    } finally {
      await observer.end()
      await pool.end()
      await mastra.close()
    }
  })

  test('failInterruptedRuns is one transaction', async ({ throwawayDatabaseUrl: url }) => {
    await upgradeHead(url)
    const mastra = await openMastra(url)
    const pool = new Pool({ connectionString: url, max: 1 })
    const observer = await connect(url)
    try {
      const [, first] = await newRun(pool, mastra.memory)
      const [, second] = await newRun(pool, mastra.memory)
      await conversations.appendEvent(pool, first, 'step_started', { node: 'router' })
      let calls = 0
      const failing = intercepted(pool, async (sql, execute) => {
        if (sql.includes('INSERT INTO run_events')) {
          calls += 1
          if (calls === 2) throw new Error('event insert failed')
        }
        return execute()
      })

      await expect(conversations.failInterruptedRuns(failing)).rejects.toThrow(
        'event insert failed',
      )
      await expectIdle(pool, observer)

      expect(calls).toBe(2)
      for (const run of [first, second]) {
        expect(await runRow(observer, run)).toMatchObject({
          status: 'running',
          error: null,
          finished: false,
        })
      }
      expect(await types(observer, first)).toEqual(['step_started'])
      expect(await events(observer, second)).toEqual([])
    } finally {
      await observer.end()
      await pool.end()
      await mastra.close()
    }
  })
})

function citation(key: string, lang: Lang, label: string): Citation {
  const chunk = CHUNKS.get(`${key} ${lang}`)!
  return { label, act: chunk.act, article: chunk.article, heading: chunk.heading }
}

describe('run store abort signal', () => {
  test('a signal aborted before the call sends nothing', async ({ pool, memory, observer }) => {
    const [conversation, run] = await newRun(pool, memory)
    const reason = new Error('stop')
    const connects = { count: 0 }
    const counted = intercepted(pool, (_sql, execute) => execute(), connects)
    const signal = AbortSignal.abort(reason)

    await expect(
      conversations.appendEvent(counted, run, 'step_started', { node: 'router' }, { signal }),
    ).rejects.toBe(reason)
    await expect(
      conversations.finishRun(counted, run, TOTALS, { error: 'x', signal }),
    ).rejects.toBe(reason)
    await expect(
      conversations.startRun(counted, memory, {
        conversationId: conversation,
        question: 'q',
        profile: 'p',
        signal,
      }),
    ).rejects.toBe(reason)

    expect(connects.count).toBe(0)
    expect(await types(observer, run)).toEqual([])
    expect((await runRow(observer, run)).status).toBe('running')
  })

  test('a signal aborted during a blocked statement rejects and leaves no event', async ({
    pool,
    memory,
    observer,
    testSettings,
  }) => {
    const [, run] = await newRun(pool, memory)
    const locker = await connect(testSettings.databaseUrl)
    let locked = true
    try {
      await locker.query('BEGIN')
      await locker.query('SELECT id FROM runs WHERE id = $1 FOR UPDATE', [run])
      const controller = new AbortController()
      const pending = conversations.appendEvent(
        pool,
        run,
        'step_started',
        { node: 'router' },
        { signal: controller.signal },
      )
      const outcome = pending.then(
        () => 'finished',
        (error: unknown) => error,
      )
      const blocked = await waitForBlocked(observer)
      controller.abort(new Error('shutdown'))

      const settled = await within(outcome, 2000)

      expect(settled).toBeInstanceOf(Error)
      expect(settled).toHaveProperty('message', 'shutdown')
      expect(pool.totalCount).toBe(0)
      await locker.query('ROLLBACK')
      locked = false
      await waitGone(observer, blocked)
      expect(await types(observer, run)).toEqual([])
      expect(await conversations.appendEvent(pool, run, 'step_started', { node: 'router' })).toBe(1)
    } finally {
      // Unlocked before the pool fixture ends, so a failure here never leaves a client waiting.
      if (locked) await locker.query('ROLLBACK')
      await locker.end()
    }
  })

  test('a signal aborted while waiting for a connection releases it later', async ({
    pool,
    memory,
    observer,
  }) => {
    const [, run] = await newRun(pool, memory)
    const held = await pool.connect()
    const controller = new AbortController()
    const pending = conversations.appendEvent(
      pool,
      run,
      'step_started',
      { node: 'router' },
      { signal: controller.signal },
    )
    controller.abort(new Error('shutdown'))

    await expect(pending).rejects.toThrow('shutdown')
    held.release()
    await expect.poll(() => pool.idleCount).toBe(1)

    expect(pool.totalCount).toBe(1)
    await expectIdle(pool, observer)
    expect(await types(observer, run)).toEqual([])
  })
})

async function within<T>(pending: Promise<T>, ms: number): Promise<T | 'timed out'> {
  const timer = Promise.withResolvers<'timed out'>()
  const handle = setTimeout(() => timer.resolve('timed out'), ms)
  try {
    return await Promise.race([pending, timer.promise])
  } finally {
    clearTimeout(handle)
  }
}

async function waitForBlocked(observer: Client): Promise<number> {
  let pid: number | undefined
  await expect
    .poll(async () => {
      const { rows } = await observer.query<{ pid: number }>(
        "SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock'" +
          " AND query LIKE '%FOR UPDATE%' AND datname = current_database()",
      )
      pid = rows[0]?.pid
      return pid
    })
    .toBeDefined()
  return pid!
}

async function waitGone(observer: Client, pid: number): Promise<void> {
  await expect
    .poll(async () => {
      const { rows } = await observer.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid])
      return rows.length
    })
    .toBe(0)
}
