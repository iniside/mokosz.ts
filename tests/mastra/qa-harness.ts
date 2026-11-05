import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import type { MastraMemory } from '@mastra/core/memory'
import type { Pool } from 'pg'
import { z } from 'zod'
import type { Profile } from '../../src/llm/profiles.ts'
import { RunRecorder } from '../../src/llm/recorder.ts'
import type { createMastra } from '../../src/mastra/index.ts'
import { MEMORY } from '../../src/mastra/memory.ts'
import { conversationMessages, saveMessage } from '../../src/mastra/workflows/qa.ts'
import {
  registerRunContext,
  type EventSink,
  type StepEventType,
} from '../../src/mastra/workflows/wrap.ts'
import { createConversation, type Payload } from '../../src/runs/conversations.ts'

export const EMBED_DELAY_MS = 20
const NODES = new Set(['router', 'retriever', 'answerer', 'verifier'])
const NESTED = 'answer-verify.'
const Vector = z.array(z.number())

type Mastra = ReturnType<typeof createMastra>
export type Embed = (text: string, options?: { abortSignal?: AbortSignal }) => Promise<number[]>
type Entry = ['update', string] | [StepEventType, Payload]
type RunResult = Awaited<
  ReturnType<Awaited<ReturnType<ReturnType<Mastra['getWorkflow']>['createRun']>>['start']>
>

/** The own fields of a workflow result's error, which Mastra hands over serialised. */
export function errorFields(error: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(error))
}

/** The timeline also holds an `update` when a node's result is published. */
export class MemorySink implements EventSink {
  readonly timeline: Entry[] = []
  /** Runs when an event arrives, before it is recorded. */
  onEmit: ((type: StepEventType, payload: Payload) => void) | null = null

  // The yield makes an emit the step does not await land after what the step does next.
  async emit(type: StepEventType, payload: Payload): Promise<void> {
    this.onEmit?.(type, payload)
    await new Promise((resolve) => setImmediate(resolve))
    this.timeline.push([type, { ...payload }])
  }

  get events(): [StepEventType, Payload][] {
    return this.timeline.flatMap((entry): [StepEventType, Payload][] =>
      entry[0] === 'update' ? [] : [entry],
    )
  }
}

export class FakeEmbedder {
  readonly queries: string[] = []
  readonly vectors = new Map<string, number[]>()

  readonly embed: Embed = async (text) => {
    this.queries.push(text)
    await sleep(EMBED_DELAY_MS)
    const vector = this.vectors.get(text)
    if (vector === undefined) throw new Error(`no vector for ${JSON.stringify(text)}`)
    return vector
  }
}

export interface Turn {
  readonly recorder: RunRecorder
  readonly sink: MemorySink
  readonly controller: AbortController
  readonly runId: string
  /** The pool the steps get, when not the harness's. */
  pool?: Pool
  /** The sink the steps get, when not `sink`. */
  eventSink?: EventSink
  result?: RunResult
}

export function newTurn(runId: string = randomUUID()): Turn {
  return {
    recorder: new RunRecorder(),
    sink: new MemorySink(),
    controller: new AbortController(),
    runId,
  }
}

/** A failed turn, raised from the run's serialised error. */
export class TurnFailed extends Error {
  readonly fields: Record<string, unknown>

  constructor(fields: Record<string, unknown>) {
    super(String(fields.message))
    this.name = String(fields.name)
    this.fields = fields
  }
}

export class Harness {
  readonly mastra: Mastra
  readonly pool: Pool
  readonly profile: Profile
  readonly embedder: FakeEmbedder

  constructor(mastra: Mastra, pool: Pool, profile: Profile, embedder: FakeEmbedder) {
    this.mastra = mastra
    this.pool = pool
    this.profile = profile
    this.embedder = embedder
  }

  get memory(): MastraMemory {
    return this.mastra.getMemory(MEMORY)
  }

  withProfile(profile: Profile): Harness {
    return new Harness(this.mastra, this.pool, profile, this.embedder)
  }

  conversation(): Promise<string> {
    return createConversation(this.memory)
  }

  async embeddingOf(key: string, lang: string): Promise<number[]> {
    const [celex, elementId] = key.split('#')
    const { rows } = await this.pool.query<{ embedding: string }>(
      'SELECT embedding::text FROM chunks WHERE celex = $1 AND element_id = $2 AND lang = $3',
      [celex, elementId, lang],
    )
    if (rows.length !== 1) throw new Error(`${key} (${lang}) is not seeded`)
    const values: unknown = JSON.parse(rows[0]!.embedding)
    return Vector.parse(values)
  }

  async embedAs(query: string, key: string, lang: string): Promise<void> {
    this.embedder.vectors.set(query, await this.embeddingOf(key, lang))
  }

  /**
   * One turn as the executor drives it: the question is saved to the thread first, then the
   * workflow runs with the turn's context registered under its run id.
   */
  async run(conversationId: string, question: string, turn: Turn): Promise<Turn> {
    await saveMessage(this.memory, conversationId, 'user', question)
    const release = registerRunContext(turn.runId, {
      profile: this.profile,
      recorder: turn.recorder,
      sink: turn.eventSink ?? turn.sink,
      pool: turn.pool ?? this.pool,
      signal: turn.controller.signal,
    })
    try {
      const run = await this.mastra.getWorkflow('qa').createRun({ runId: turn.runId })
      run.watch((event) => {
        if (event.type !== 'workflow-step-result') return
        const id = event.payload.id.replace(NESTED, '')
        if (NODES.has(id)) turn.sink.timeline.push(['update', id])
      })
      turn.result = await run.start({ inputData: { conversation_id: conversationId } })
    } finally {
      release()
    }
    return turn
  }

  async turn(conversationId: string, question: string): Promise<Turn> {
    const turn = await this.run(conversationId, question, newTurn())
    if (turn.result?.status === 'failed') throw new TurnFailed(errorFields(turn.result.error))
    return turn
  }

  async messages(
    conversationId: string,
    memory: MastraMemory = this.memory,
  ): Promise<[string, string][]> {
    const messages = await conversationMessages(memory, conversationId)
    return messages.map((message) => [message.role, message.text])
  }
}
