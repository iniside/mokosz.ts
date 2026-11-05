import { randomUUID } from 'node:crypto'
import type { MastraMemory } from '@mastra/core/memory'
import { DatabaseError } from 'pg'
import { abortable } from '../abort.ts'
import type { Decimal } from '../decimal.ts'
import { ConversationNotFound, RESOURCE_ID } from '../mastra/memory.ts'
import type { StepEventType } from '../mastra/workflows/wrap.ts'
import {
  conversationExists,
  transaction,
  type Database,
  type Options,
  type Query,
} from './transaction.ts'

export type RunStatus = 'running' | 'pending_review' | 'done' | 'failed'
export type EventType = StepEventType | 'interrupt' | 'final' | 'error'

export const INTERRUPTED = 'interrupted by restart'
export const ONE_RUNNING_INDEX = 'runs_one_running_per_conversation'

export class RunConflict extends Error {
  override name = 'RunConflict'
}

export class RunNotRunning extends Error {
  override name = 'RunNotRunning'
}

export interface RunTotals {
  readonly tokensIn: number
  readonly tokensOut: number
  readonly costUsd: Decimal
  readonly latencyMs: number
  readonly path: readonly string[]
  readonly models: readonly string[]
}

export type Payload = Record<string, unknown>

export interface RunEvent {
  seq: number
  type: EventType
  payload: Payload
}

export interface RunEvents {
  status: RunStatus
  events: RunEvent[]
}

const APPEND = `
    INSERT INTO run_events (run_id, seq, type, payload)
    SELECT $1::uuid, coalesce(max(seq), 0) + 1, $2::text, $3::jsonb
    FROM run_events WHERE run_id = $1::uuid
    RETURNING seq
`

// Adds a segment to the persisted totals: a resumed run never overwrites what came before.
const CLOSE = `
    UPDATE runs SET status = $2, error = $3,
        finished_at = CASE WHEN $2 = 'pending_review' THEN NULL ELSE now() END,
        tokens_in = tokens_in + $4,
        tokens_out = tokens_out + $5,
        cost_usd = cost_usd + $6,
        latency_ms = coalesce(latency_ms, 0) + $7,
        path = path || $8::text[],
        models = ARRAY(
            SELECT m FROM unnest(models || $9::text[]) WITH ORDINALITY AS t (m, n)
            GROUP BY m ORDER BY min(n)
        )
    WHERE id = $1
`

export async function lockRunning(
  query: Query,
  runId: string,
): Promise<{ status: string; kind: string; invoice_id: string | null }> {
  const [row] = await query<{ status: string; kind: string; invoice_id: string | null }>(
    'SELECT status, kind, invoice_id FROM runs WHERE id = $1 FOR UPDATE',
    [runId],
  )
  if (row === undefined) throw new RunNotRunning(`run ${runId} does not exist`)
  if (row.status !== 'running') throw new RunNotRunning(`run ${runId} is ${row.status}`)
  return row
}

export async function append(
  query: Query,
  runId: string,
  type: EventType,
  payload: Payload,
): Promise<number> {
  const [row] = await query<{ seq: number }>(APPEND, [runId, type, JSON.stringify(payload)])
  return row!.seq
}

export async function createConversation(
  memory: MastraMemory,
  options: Options = {},
): Promise<string> {
  const threadId = randomUUID()
  await abortable(() => memory.createThread({ threadId, resourceId: RESOURCE_ID }), options.signal)
  return threadId
}

export async function startRun(
  db: Database,
  memory: MastraMemory,
  run: { conversationId: string; question: string; profile: string } & Options,
): Promise<string> {
  const { conversationId, question, profile, signal } = run
  if (!(await conversationExists(memory, conversationId, signal))) {
    throw new ConversationNotFound(`conversation ${conversationId} does not exist`)
  }
  try {
    return await transaction(db, signal, async (query) => {
      const [row] = await query<{ id: string }>(
        'INSERT INTO runs (kind, thread_id, conversation_id, question, status, profile)' +
          " VALUES ('qa', $1, $2, $3, 'running', $4) RETURNING id",
        [conversationId, conversationId, question, profile],
      )
      return row!.id
    })
  } catch (error) {
    if (error instanceof DatabaseError && error.constraint === ONE_RUNNING_INDEX) {
      throw new RunConflict(`conversation ${conversationId} has a running run`, { cause: error })
    }
    throw error
  }
}

export async function appendEvent(
  db: Database,
  runId: string,
  type: StepEventType,
  payload: Payload,
  options: Options = {},
): Promise<number> {
  if (type !== 'step_started' && type !== 'step_finished') {
    throw new Error(
      `${JSON.stringify(type)} is not a step event; terminal events come from finishRun`,
    )
  }
  return transaction(db, options.signal, async (query) => {
    await lockRunning(query, runId)
    return append(query, runId, type, payload)
  })
}

export async function close(
  query: Query,
  runId: string,
  status: RunStatus,
  totals: RunTotals | null,
  error: string | null,
): Promise<void> {
  if (totals === null) {
    await query('UPDATE runs SET status = $1, error = $2, finished_at = now() WHERE id = $3', [
      status,
      error,
      runId,
    ])
    return
  }
  await query(CLOSE, [
    runId,
    status,
    error,
    totals.tokensIn,
    totals.tokensOut,
    totals.costUsd.toString(),
    totals.latencyMs,
    [...totals.path],
    [...totals.models],
  ])
}

export async function terminate(
  query: Query,
  runId: string,
  totals: RunTotals | null,
  final: Payload | undefined,
  error: string | undefined,
): Promise<number> {
  if (final !== undefined) {
    await close(query, runId, 'done', totals, null)
    return append(query, runId, 'final', final)
  }
  await close(query, runId, 'failed', totals, error ?? null)
  return append(query, runId, 'error', { message: error })
}

export async function finishRun(
  db: Database,
  runId: string,
  totals: RunTotals,
  outcome: { final?: Payload; error?: string } & Options,
): Promise<number> {
  const { final, error, signal } = outcome
  if ((final === undefined) === (error === undefined)) {
    throw new Error('finishRun needs exactly one of final or error')
  }
  return transaction(db, signal, async (query) => {
    const run = await lockRunning(query, runId)
    if (run.kind !== 'qa') {
      throw new Error(`run ${runId} is an extraction run; it ends with its invoice`)
    }
    return terminate(query, runId, totals, final, error)
  })
}

export async function failInterruptedRuns(db: Database, options: Options = {}): Promise<string[]> {
  return transaction(db, options.signal, async (query) => {
    const rows = await query<{ id: string }>(
      "SELECT id FROM runs WHERE status = 'running' ORDER BY created_at, id FOR UPDATE",
    )
    const ids = rows.map((row) => row.id)
    await query("UPDATE invoices SET status = 'failed' WHERE run_id = ANY($1::uuid[])", [ids])
    for (const runId of ids) await terminate(query, runId, null, undefined, INTERRUPTED)
    return ids
  })
}

export async function eventsAfter(
  db: Database,
  runId: string,
  after: number,
  options: Options = {},
): Promise<RunEvents | null> {
  return transaction(db, options.signal, async (query) => {
    // Status before events: a terminal status read first guarantees its terminal event is
    // visible to the later read, since both are committed together.
    const [found] = await query<{ status: RunStatus }>('SELECT status FROM runs WHERE id = $1', [
      runId,
    ])
    if (found === undefined) return null
    const events = await query<RunEvent>(
      'SELECT seq, type, payload FROM run_events WHERE run_id = $1 AND seq > $2 ORDER BY seq',
      [runId, after],
    )
    return { status: found.status, events }
  })
}
