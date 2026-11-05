import type { QueryResult, QueryResultRow } from 'pg'
import { ACTS, LANGUAGES, type Lang } from '../ingest/acts.ts'
import { ChunkSchema, type Chunk } from '../ingest/chunker.ts'
import { EMBEDDING_DIM } from './index.ts'

export interface Queryable {
  query<R extends QueryResultRow>(sql: string, params: unknown[]): Promise<QueryResult<R>>
}

export type RetrievedChunk = Chunk & { score: number }

const ACT_NAMES = new Set<string>(ACTS.map(([, name]) => name))
const LANGS = new Set<string>(LANGUAGES)

const COLUMNS = 'celex, act, lang, element_id, kind, article, heading, text'

const REFERENCED = `
    SELECT id, ${COLUMNS}, embedding <=> $1::vector AS distance
    FROM chunks
    WHERE lang = $2
      AND (act, article) IN (SELECT * FROM unnest($3::text[], $4::int[]))
    ORDER BY distance, id
    LIMIT $5
`

const SIMILAR = `
    SELECT id, ${COLUMNS}, embedding <=> $1::vector AS distance
    FROM chunks
    WHERE lang = $2
      AND (cardinality($3::text[]) = 0 OR act = ANY($3::text[]))
      AND id <> ALL($4::bigint[])
    ORDER BY distance, id
    LIMIT $5
`

interface Row {
  id: string
  celex: string
  act: string
  lang: string
  element_id: string
  kind: string
  article: number | null
  heading: string | null
  text: string
  distance: number
}

function sorted(items: Iterable<string>): string[] {
  return [...items].toSorted()
}

function vectorLiteral(values: readonly number[]): string {
  return `[${values.map((value) => String(value)).join(',')}]`
}

function checkActs(names: readonly string[]): void {
  const unknown = sorted(new Set(names.filter((name) => !ACT_NAMES.has(name))))
  if (unknown.length > 0) {
    throw new Error(
      `unknown act names: ${JSON.stringify(unknown)}; known: ${JSON.stringify(sorted(ACT_NAMES))}`,
    )
  }
}

function toChunk(row: Row): RetrievedChunk {
  const chunk = ChunkSchema.parse({
    celex: row.celex,
    act: row.act,
    lang: row.lang,
    elementId: row.element_id,
    kind: row.kind,
    article: row.article,
    heading: row.heading,
    text: row.text,
  })
  return { ...chunk, score: 1.0 - row.distance }
}

async function fetchRows(
  conn: Queryable,
  sql: string,
  params: unknown[],
  signal: AbortSignal | undefined,
): Promise<Row[]> {
  signal?.throwIfAborted()
  const pending = conn.query<Row>(sql, params)
  if (signal === undefined) return (await pending).rows
  // An abandoned query leaves its connection busy; the owner of the connection discards it.
  pending.catch(() => {})
  const aborted = Promise.withResolvers<never>()
  const onAbort = (): void => aborted.reject(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return (await Promise.race([pending, aborted.promise])).rows
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

export async function search(
  conn: Queryable,
  queryEmbedding: readonly number[],
  options: {
    lang: Lang
    acts: readonly string[]
    articleRefs: readonly (readonly [string, number])[]
    topK: number
    signal?: AbortSignal
  },
): Promise<RetrievedChunk[]> {
  const { lang, acts, articleRefs, topK, signal } = options
  if (!LANGS.has(lang)) {
    throw new Error(
      `unknown language ${JSON.stringify(lang)}; known: ${JSON.stringify(sorted(LANGS))}`,
    )
  }
  if (topK < 1) throw new Error(`topK must be at least 1, got ${topK}`)
  if (queryEmbedding.length !== EMBEDDING_DIM) {
    throw new Error(
      `query embedding has ${queryEmbedding.length} dimensions, expected ${EMBEDDING_DIM}`,
    )
  }
  checkActs(acts)
  checkActs(articleRefs.map(([act]) => act))

  const query = vectorLiteral(queryEmbedding)
  const refActs = articleRefs.map(([act]) => act)
  const refArticles = articleRefs.map(([, article]) => article)
  let rows: Row[] = []
  if (articleRefs.length > 0) {
    rows = await fetchRows(conn, REFERENCED, [query, lang, refActs, refArticles, topK], signal)
  }
  if (rows.length < topK) {
    const taken = rows.map((row) => row.id)
    const rest = await fetchRows(
      conn,
      SIMILAR,
      [query, lang, [...acts], taken, topK - rows.length],
      signal,
    )
    rows = [...rows, ...rest]
  }
  return rows.map(toChunk)
}
