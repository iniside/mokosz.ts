import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Client } from 'pg'
import { upgradeHead } from '../../src/db/index.ts'
import { beforeAll } from 'vitest'
import type { Lang } from '../../src/ingest/acts.ts'
import { citationKey, loadCorpus, type Chunk } from '../../src/ingest/chunker.ts'
import { embeddingsDir, loadQueries, type EvalQuery } from '../../src/retrieval/embeddings.ts'
import { EMBEDDING_DIM, recallAtK, type Matrix } from '../../src/retrieval/index.ts'
import { parseNpy, type Float16Npy } from '../../src/retrieval/npy.ts'
import { search, type Queryable, type RetrievedChunk } from '../../src/retrieval/search.ts'
import { describe, expect, test as harnessTest } from '../support/harness.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')
const DIRECTORY = embeddingsDir(ROOT)
const COLS = EMBEDDING_DIM
// pgvector accumulates cosine terms in float32, here float64: rankings agree exactly in the top 50;
// deeper down neighbours swap only when their float64 scores differ by <= 8.6e-8.
const EXACT_PREFIX = 50
const FLOAT32_TOLERANCE = 2e-7

type Meta = { citation_key: string; lang: string }
type QueryMeta = { id: string; lang: string }
type Where = (chunk: Chunk) => boolean

const corpus = await loadCorpus(ROOT)
const chunks: Float16Npy = parseNpy(await readFile(join(DIRECTORY, 'chunks.npy')))
const queries: Float16Npy = parseNpy(await readFile(join(DIRECTORY, 'queries.npy')))
const chunkMeta: Meta[] = JSON.parse(await readFile(join(DIRECTORY, 'chunks.json'), 'utf8'))
const queryMeta: QueryMeta[] = JSON.parse(await readFile(join(DIRECTORY, 'queries.json'), 'utf8'))
const evalQueries = new Map((await loadQueries(ROOT)).map((query) => [query.id, query]))
const queryRow = new Map(queryMeta.map((meta, row) => [meta.id, row]))

const EN_QUERY = 'en-gdpr-personal-data-definition'
const PL_QUERY = queryMeta.find((meta) => meta.lang === 'pl')!.id
const rowOf = new Map(corpus.map((chunk, row) => [`${citationKey(chunk)} ${chunk.lang}`, row]))

const chunkNorms = Float64Array.from({ length: corpus.length }, (_, row) => {
  let squares = 0
  for (let c = 0; c < COLS; c++) squares += chunks.data[row * COLS + c]! ** 2
  return Math.sqrt(squares)
})

const pair = (c: Chunk): string => `${c.act} ${c.article}`

function matrix(npy: Float16Npy): Matrix {
  return { rows: npy.shape[0]!, cols: npy.shape[1]!, data: npy.data }
}

async function rejectsWithPlainError(promise: Promise<unknown>, message: string): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(Error)
  expect(Object.getPrototypeOf(error)).toBe(Error.prototype)
  expect(error).toHaveProperty('name', 'Error')
  expect(error).toHaveProperty('message', message)
}

interface Spy extends Queryable {
  statements: string[]
}

function spy(conn: Client, afterFirst?: () => void): Spy {
  const statements: string[] = []
  return {
    statements,
    query(sql, params) {
      statements.push(sql)
      const pending = conn.query(sql, params)
      if (afterFirst !== undefined && statements.length === 1) {
        pending.then(afterFirst, () => {})
      }
      return pending
    },
  }
}

const isReferenced = (sql: string): boolean => sql.includes('unnest')

function evalQuery(id: string): EvalQuery {
  return evalQueries.get(id)!
}

function vector(id: string): number[] {
  const row = queryRow.get(id)!
  return Array.from(queries.data.subarray(row * COLS, (row + 1) * COLS))
}

function cosines(id: string): Float64Array {
  const query = vector(id)
  const norm = Math.sqrt(query.reduce((sum, value) => sum + value * value, 0))
  return Float64Array.from({ length: corpus.length }, (_, row) => {
    let dot = 0
    for (let c = 0; c < COLS; c++) dot += chunks.data[row * COLS + c]! * query[c]!
    return dot / (chunkNorms[row]! * norm)
  })
}

// The chunks that match by float64 cosine: descending, ties in row order.
function ranking(id: string, where: Where): string[] {
  const scores = cosines(id)
  const rows = corpus.flatMap((chunk, row) => (where(chunk) ? [row] : []))
  return rows.toSorted((a, b) => scores[b]! - scores[a]! || a - b).map((row) => keyOfRow(row))
}

function keyOfRow(row: number): string {
  return citationKey(corpus[row]!)
}

const keys = (results: readonly Chunk[]): string[] => results.map(citationKey)

function duplicateGroups(): Record<Lang, number[][]> {
  const groups = new Map<string, number[]>()
  corpus.forEach((chunk, row) => {
    const bytes = Buffer.from(chunks.data.buffer, row * COLS * 2, COLS * 2).toString('hex')
    const key = `${chunk.lang} ${bytes}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  })
  const found: Record<Lang, number[][]> = { en: [], pl: [] }
  for (const [key, rows] of groups) {
    if (rows.length > 1) found[key.startsWith('en') ? 'en' : 'pl'].push(rows)
  }
  return found
}
const DUPLICATES = duplicateGroups()

const test = harnessTest.extend(
  'conn',
  async ({ seededDatabaseUrl }, { onCleanup }): Promise<Client> => {
    const client = new Client({ connectionString: seededDatabaseUrl })
    await client.connect()
    onCleanup(() => client.end())
    return client
  },
)

interface Options {
  acts?: string[]
  articleRefs?: [string, number][]
  topK?: number
  lang?: Lang
  signal?: AbortSignal
}

async function run(conn: Client, id: string, options: Options = {}): Promise<RetrievedChunk[]> {
  return await search(conn, vector(id), {
    lang: options.lang ?? evalQuery(id).lang,
    acts: options.acts ?? [],
    articleRefs: options.articleRefs ?? [],
    topK: options.topK ?? 5,
    signal: options.signal,
  })
}

beforeAll(() => {
  expect(corpus).toHaveLength(chunks.shape[0]!)
})

describe('search', () => {
  test('committed files follow the corpus order', () => {
    expect(chunkMeta.map((meta) => meta.citation_key)).toEqual(corpus.map(citationKey))
    expect(new Set(queryRow.keys())).toEqual(new Set(evalQueries.keys()))
    expect(DUPLICATES.en.length).toBeGreaterThan(0)
    expect(DUPLICATES.pl.length).toBeGreaterThan(0)
  })

  test.for(['en', 'pl'] as const)(
    'returns only the requested language: %s',
    async (lang, { conn }) => {
      for (const id of [EN_QUERY, PL_QUERY]) {
        const results = await run(conn, id, { lang, topK: 50 })

        expect(results).toHaveLength(50)
        expect(new Set(results.map((chunk) => chunk.lang))).toEqual(new Set([lang]))
        expect(keys(results)).toEqual(ranking(id, (c) => c.lang === lang).slice(0, 50))
      }
    },
  )

  test.for([['NIS2'], ['AI Act', 'NIS2'], ['GDPR']])(
    'act filter holds: %j',
    async (acts, { conn }) => {
      const lang = evalQuery(EN_QUERY).lang
      const results = await run(conn, EN_QUERY, { acts, topK: 30 })

      expect(results).toHaveLength(30)
      expect(results.every((chunk) => acts.includes(chunk.act))).toBe(true)
      const expected = ranking(EN_QUERY, (c) => c.lang === lang && acts.includes(c.act))
      expect(keys(results)).toEqual(expected.slice(0, 30))
    },
  )

  test('an article ref comes first, then fills by similarity', async ({ conn }) => {
    const lang = evalQuery(EN_QUERY).lang
    const article = corpus.filter((c) => c.act === 'AI Act' && c.article === 14 && c.lang === lang)
    expect(article.length).toBeGreaterThan(0)
    expect(article.length).toBeLessThan(10)

    const results = await run(conn, EN_QUERY, {
      acts: ['GDPR'],
      articleRefs: [['AI Act', 14]],
      topK: 10,
    })

    const head = results.slice(0, article.length)
    const tail = results.slice(article.length)
    expect(keys(head)).toEqual(
      ranking(EN_QUERY, (c) => c.lang === lang && c.act === 'AI Act' && c.article === 14),
    )
    expect(keys(tail)).toEqual(
      ranking(EN_QUERY, (c) => c.lang === lang && c.act === 'GDPR').slice(0, 10 - article.length),
    )
    expect(results).toHaveLength(10)
    expect(new Set(keys(results)).size).toBe(10)
  })

  test('the fill skips chunks already taken by the ref', async ({ conn }) => {
    const lang = evalQuery(EN_QUERY).lang
    const article = corpus.filter((c) => c.act === 'GDPR' && c.article === 1 && c.lang === lang)
    const plain = await run(conn, EN_QUERY, { acts: ['GDPR'], topK: 200 })
    const plainKeys = new Set(keys(plain))
    expect(article.every((c) => plainKeys.has(citationKey(c)))).toBe(true)

    const results = await run(conn, EN_QUERY, {
      acts: ['GDPR'],
      articleRefs: [['GDPR', 1]],
      topK: 200,
    })

    const taken = new Set(article.map(citationKey))
    expect(new Set(keys(results.slice(0, article.length)))).toEqual(taken)
    const rest = keys(plain)
      .filter((key) => !taken.has(key))
      .slice(0, 200 - article.length)
    expect(keys(results.slice(article.length))).toEqual(rest)
    expect(new Set(keys(results)).size).toBe(200)
    expect(results).toHaveLength(200)
  })

  test('several refs match each act with its own article', async ({ conn }) => {
    const lang = evalQuery(EN_QUERY).lang
    const refs = new Set(['GDPR 4', 'AI Act 14'])
    const crossed = new Set(['GDPR 14', 'AI Act 4'])
    const referenced = corpus.filter((c) => c.lang === lang && refs.has(pair(c)))
    const crossedKeys = new Set(
      corpus.filter((c) => c.lang === lang && crossed.has(pair(c))).map(citationKey),
    )
    expect(crossedKeys.size).toBeGreaterThan(0)

    const results = await run(conn, EN_QUERY, {
      articleRefs: [
        ['AI Act', 14],
        ['GDPR', 4],
      ],
      topK: referenced.length + 5,
    })

    const head = results.slice(0, referenced.length)
    expect(keys(head)).toEqual(ranking(EN_QUERY, (c) => c.lang === lang && refs.has(pair(c))))
    expect(keys(head).some((key) => crossedKeys.has(key))).toBe(false)
    expect(new Set(head.map(pair))).toEqual(refs)
  })

  test('a GDPR article 4 ref returns the top k of its chunks', async ({ conn }) => {
    const lang = evalQuery(EN_QUERY).lang
    const article4 = corpus.filter((c) => c.act === 'GDPR' && c.article === 4 && c.lang === lang)
    expect(article4).toHaveLength(27)

    const results = await run(conn, EN_QUERY, { articleRefs: [['GDPR', 4]], topK: 5 })

    expect(results).toHaveLength(5)
    expect(results.every((chunk) => chunk.act === 'GDPR' && chunk.article === 4)).toBe(true)
    expect(keys(results)).toEqual(
      ranking(EN_QUERY, (c) => c.lang === lang && c.act === 'GDPR' && c.article === 4).slice(0, 5),
    )
  })

  test.for<[string, Options, string]>([
    [
      'unknown act',
      { acts: ['GDPR', 'DORA'] },
      'unknown act names: ["DORA"]; known: ["AI Act","GDPR","NIS2"]',
    ],
    [
      'celex as act',
      { acts: ['32016R0679'] },
      'unknown act names: ["32016R0679"]; known: ["AI Act","GDPR","NIS2"]',
    ],
    [
      'wrong-case act in a ref',
      { articleRefs: [['gdpr', 4]] },
      'unknown act names: ["gdpr"]; known: ["AI Act","GDPR","NIS2"]',
    ],
    ['topK 0', { topK: 0 }, 'topK must be at least 1, got 0'],
  ])('invalid filters raise: %s', async ([, options, message], { conn }) => {
    await rejectsWithPlainError(run(conn, EN_QUERY, options), message)
  })

  test('an unknown language raises', async ({ conn }) => {
    await rejectsWithPlainError(
      search(conn, vector(EN_QUERY), {
        // @ts-expect-error a language outside Lang
        lang: 'de',
        acts: [],
        articleRefs: [],
        topK: 5,
      }),
      'unknown language "de"; known: ["en","pl"]',
    )
  })

  test.for([EMBEDDING_DIM - 1, EMBEDDING_DIM + 1, 3, 0])(
    'a query vector of %i dimensions raises',
    async (dimensions, { conn }) => {
      await rejectsWithPlainError(
        search(conn, Array<number>(dimensions).fill(0.5), {
          lang: 'en',
          acts: [],
          articleRefs: [['GDPR', 4]],
          topK: 5,
        }),
        `query embedding has ${dimensions} dimensions, expected ${EMBEDDING_DIM}`,
      )
    },
  )

  test('the score is one minus the cosine distance', async ({ conn }) => {
    const results = await run(conn, EN_QUERY, { topK: 5 })

    const scores = cosines(EN_QUERY)
    for (const { score, ...chunk } of results) {
      const row = rowOf.get(`${citationKey(chunk)} ${chunk.lang}`)!
      expect(Math.abs(score - scores[row]!)).toBeLessThanOrEqual(FLOAT32_TOLERANCE)
      expect(chunk).toEqual(corpus[row])
    }
    const ordered = results.map((chunk) => chunk.score)
    expect(ordered).toEqual(ordered.toSorted((a, b) => b - a))
  })

  test.for([...queryRow.keys()].toSorted())(
    'the database order equals the float64 ranking: %s',
    async (id, { conn }) => {
      const lang = evalQuery(id).lang
      const expected = ranking(id, (c) => c.lang === lang)
      const scores = cosines(id)

      const results = await run(conn, id, { topK: expected.length })

      const found = keys(results)
      expect(found.slice(0, EXACT_PREFIX)).toEqual(expected.slice(0, EXACT_PREFIX))
      expect(found.toSorted()).toEqual(expected.toSorted())
      const rows = found.map((key) => rowOf.get(`${key} ${lang}`)!)
      for (let i = 1; i < rows.length; i++) {
        expect(scores[rows[i]!]! - scores[rows[i - 1]!]!).toBeLessThanOrEqual(FLOAT32_TOLERANCE)
        if (results[i - 1]!.score === results[i]!.score) expect(rows[i - 1]!).toBeLessThan(rows[i]!)
      }
      for (const group of DUPLICATES[lang]) {
        const positions = group.map((row) => rows.indexOf(row))
        expect(positions).toEqual(positions.map((_, i) => positions[0]! + i))
      }
    },
  )

  test('recall through search equals recallAtK', async ({ conn }) => {
    let total = 0
    for (const meta of queryMeta) {
      const wanted = new Set(evalQuery(meta.id).expected.map((key) => `${key} ${meta.lang}`))
      const results = await run(conn, meta.id, { topK: 5 })
      const top = new Set(results.map((chunk) => `${citationKey(chunk)} ${chunk.lang}`))
      expect(new Set(results.map((chunk) => chunk.lang))).toEqual(new Set([meta.lang]))
      total += [...wanted].filter((w) => top.has(w)).length / wanted.size
    }
    const expected = Object.fromEntries([...evalQueries].map(([id, query]) => [id, query.expected]))
    const recall = total / queryMeta.length

    expect(recall).toBe(
      recallAtK(matrix(chunks), chunkMeta, matrix(queries), queryMeta, expected, 5),
    )
    // Decision 0007 records bge-m3 recall@5 as 33/40.
    expect(recall).toBeCloseTo(33 / 40, 12)
  })

  test('a signal aborted before the call sends no statement', async ({ conn }) => {
    const reason = new Error('stop')
    const counted = spy(conn)

    await expect(
      search(counted, vector(EN_QUERY), {
        lang: 'en',
        acts: [],
        articleRefs: [['GDPR', 4]],
        topK: 5,
        signal: AbortSignal.abort(reason),
      }),
    ).rejects.toBe(reason)
    expect(counted.statements).toEqual([])
  })

  test('a signal aborted during a statement rejects while the statement is blocked', async ({
    conn,
    seededDatabaseUrl,
  }) => {
    const locker = new Client({ connectionString: seededDatabaseUrl })
    await locker.connect()
    try {
      await locker.query('BEGIN; LOCK TABLE chunks IN ACCESS EXCLUSIVE MODE')
      const controller = new AbortController()
      const pending = run(conn, EN_QUERY, { topK: 5, signal: controller.signal })
      const outcome = pending.then(
        () => 'finished',
        (error: unknown) => error,
      )
      setTimeout(() => controller.abort(new Error('shutdown')), 100)

      const settled = await outcome

      expect(settled).toBeInstanceOf(Error)
      expect(settled).toHaveProperty('message', 'shutdown')
    } finally {
      await locker.query('ROLLBACK')
      await locker.end()
    }
  })

  test('a signal aborted between the two statements stops before the second', async ({ conn }) => {
    const controller = new AbortController()
    const counted = spy(conn, () => controller.abort(new Error('between')))

    await expect(
      search(counted, vector(EN_QUERY), {
        lang: 'en',
        acts: [],
        articleRefs: [['GDPR', 4]],
        topK: 30,
        signal: controller.signal,
      }),
    ).rejects.toThrow('between')
    expect(counted.statements.map(isReferenced)).toEqual([true])
  })

  test.for([27, 5])(
    'refs that fill top_k=%i issue no similarity statement',
    async (topK, { conn }) => {
      const counted = spy(conn)

      const results = await search(counted, vector(EN_QUERY), {
        lang: 'en',
        acts: [],
        articleRefs: [['GDPR', 4]],
        topK,
      })

      expect(results).toHaveLength(topK)
      expect(counted.statements.map(isReferenced)).toEqual([true])
    },
  )

  test('refs short of top_k add a similarity statement', async ({ conn }) => {
    const counted = spy(conn)

    await search(counted, vector(EN_QUERY), {
      lang: 'en',
      acts: [],
      articleRefs: [['GDPR', 4]],
      topK: 28,
    })

    expect(counted.statements.map(isReferenced)).toEqual([true, false])
  })

  test('referenced chunks with equal distance come in id order', async ({
    throwawayDatabaseUrl,
  }) => {
    await upgradeHead(throwawayDatabaseUrl)
    const client = new Client({ connectionString: throwawayDatabaseUrl })
    await client.connect()
    try {
      const embedding = `[${vector(EN_QUERY).join(',')}]`
      for (const [id, elementId] of [
        [2, 'second'],
        [1, 'first'],
      ] as const) {
        await client.query(
          `INSERT INTO chunks (id, celex, act, lang, element_id, kind, article, heading, text, embedding)
           VALUES ($1, '32016R0679', 'GDPR', 'en', $2, 'paragraph', 4, NULL, 'text', $3::vector)`,
          [id, elementId, embedding],
        )
      }
      const heap = await client.query<{ element_id: string }>('SELECT element_id FROM chunks')
      expect(heap.rows.map((row) => row.element_id)).toEqual(['second', 'first'])

      const results = await search(client, vector(EN_QUERY), {
        lang: 'en',
        acts: [],
        articleRefs: [['GDPR', 4]],
        topK: 2,
      })

      expect(results.map((chunk) => chunk.elementId)).toEqual(['first', 'second'])
    } finally {
      await client.end()
    }
  })
})

describe('ranking cases from the eval set', () => {
  test.for<[string, Options, string]>([
    [
      'en-gdpr-personal-data-definition',
      { articleRefs: [['GDPR', 4]], topK: 1 },
      '32016R0679#art_4.pt_1',
    ],
    [
      'en-aiact-deployer-definition',
      { articleRefs: [['AI Act', 3]], topK: 1 },
      '32024R1689#art_3.pt_4',
    ],
    ['en-gdpr-breach-deadline', { acts: ['GDPR'], topK: 5 }, '32016R0679#033.001'],
    ['pl-gdpr-child-consent-age', { acts: ['GDPR'], topK: 5 }, '32016R0679#008.001'],
  ])('%s finds %j, expected key %s', async ([id, options, key], { conn }) => {
    const results = await run(conn, id, options)

    expect(results).toHaveLength(options.topK!)
    expect(keys(results)).toContain(key)
    expect(results.every((chunk) => chunk.lang === evalQuery(id).lang)).toBe(true)
    for (const chunk of results) {
      if (options.acts !== undefined) expect(options.acts).toContain(chunk.act)
      if (options.articleRefs !== undefined) {
        expect(options.articleRefs.map(([act, article]) => `${act} ${article}`)).toContain(
          pair(chunk),
        )
      }
    }
  })
})
