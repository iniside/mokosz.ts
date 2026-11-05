import type { MastraMemory } from '@mastra/core/memory'
import { label } from '../citations.ts'
import type { Lang } from '../ingest/acts.ts'
import type { Payload, RunStatus } from './conversations.ts'
import {
  conversationExists,
  isoUtc,
  transaction,
  type Database,
  type Options,
  type Query,
} from './transaction.ts'

export interface TurnMetrics {
  path: string[]
  models: string[]
  tokens_in: number
  tokens_out: number
  cost_usd: string
  latency_ms: number | null
}

export interface Citation {
  label: string
  act: string
  article: number | null
  heading: string | null
}

export interface Turn {
  run_id: string
  question: string
  answer: Payload | null
  status: RunStatus
  created_at: string
  metrics: TurnMetrics
  citations: Record<string, Citation>
}

interface FinalAnswer {
  lang: Lang
  claims: { citations: string[] }[]
}

const TURNS = `
    SELECT r.id, r.question, r.status,
           ${isoUtc('r.created_at')} AS created_at,
           r.path, r.models, r.tokens_in, r.tokens_out, r.cost_usd, r.latency_ms,
           e.payload AS answer
    FROM runs r
    LEFT JOIN run_events e ON e.run_id = r.id AND e.type = 'final'
    WHERE r.conversation_id = $1
    ORDER BY r.created_at, r.id
`

const CITED_CHUNKS = `
    SELECT celex, element_id, lang, act, article, heading, text
    FROM chunks
    WHERE (celex, element_id, lang)
        IN (SELECT * FROM unnest($1::text[], $2::text[], $3::text[]))
`

function cited(answer: FinalAnswer): Set<string> {
  return new Set(answer.claims.flatMap((claim) => claim.citations))
}

function partition(key: string): [string, string] {
  const at = key.indexOf('#')
  return at < 0 ? [key, ''] : [key.slice(0, at), key.slice(at + 1)]
}

const wantedKey = (key: string, lang: string): string => JSON.stringify([key, lang])

interface ChunkRow {
  celex: string
  element_id: string
  lang: Lang
  act: string
  article: number | null
  heading: string | null
  text: string
}

async function citedChunks(query: Query, parts: [string, string, Lang][]): Promise<ChunkRow[]> {
  return await query<ChunkRow>(CITED_CHUNKS, [
    parts.map((p) => p[0]),
    parts.map((p) => p[1]),
    parts.map((p) => p[2]),
  ])
}

async function citations(
  query: Query,
  wanted: Map<string, [string, Lang]>,
): Promise<Map<string, Citation>> {
  const found = new Map<string, Citation>()
  if (wanted.size === 0) return found
  const parts = [...wanted.values()].map(([key, lang]): [string, string, Lang] => [
    ...partition(key),
    lang,
  ])
  for (const row of await citedChunks(query, parts)) {
    const key = `${row.celex}#${row.element_id}`
    found.set(wantedKey(key, row.lang), {
      label: label(key, row.lang, row.text),
      act: row.act,
      article: row.article,
      heading: row.heading,
    })
  }
  return found
}

export interface CitationText extends Citation {
  text: string
}

export async function citationText(
  db: Database,
  celex: string,
  elementId: string,
  lang: Lang,
): Promise<CitationText | null> {
  const client = await db.connect()
  const query: Query = async (sql, params) => (await client.query(sql, params)).rows
  const [row] = await citedChunks(query, [[celex, elementId, lang]]).finally(() => client.release())
  if (row === undefined) return null
  return {
    label: label(`${celex}#${elementId}`, lang, row.text),
    act: row.act,
    article: row.article,
    heading: row.heading,
    text: row.text,
  }
}

interface TurnRow {
  id: string
  question: string
  status: RunStatus
  created_at: string
  path: string[]
  models: string[]
  tokens_in: number
  tokens_out: number
  cost_usd: string
  latency_ms: number | null
  answer: (Payload & FinalAnswer) | null
}

export async function turns(
  db: Database,
  memory: MastraMemory,
  conversationId: string,
  options: Options = {},
): Promise<Turn[] | null> {
  const { signal } = options
  if (!(await conversationExists(memory, conversationId, signal))) return null
  const [rows, found] = await transaction(db, signal, async (query) => {
    const read = await query<TurnRow>(TURNS, [conversationId])
    const wanted = new Map<string, [string, Lang]>()
    for (const { answer } of read) {
      if (answer === null) continue
      for (const key of cited(answer)) wanted.set(wantedKey(key, answer.lang), [key, answer.lang])
    }
    return [read, await citations(query, wanted)] as const
  })
  return rows.map((row) => {
    const answer = row.answer
    const byKey: Record<string, Citation> = {}
    if (answer !== null) {
      for (const key of [...cited(answer)].toSorted()) {
        const citation = found.get(wantedKey(key, answer.lang))
        if (citation !== undefined) byKey[key] = citation
      }
    }
    return {
      run_id: row.id,
      question: row.question,
      answer,
      status: row.status,
      created_at: row.created_at,
      metrics: {
        path: row.path,
        models: row.models,
        tokens_in: row.tokens_in,
        tokens_out: row.tokens_out,
        cost_usd: row.cost_usd,
        latency_ms: row.latency_ms,
      },
      citations: byKey,
    }
  })
}
