import { cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from 'pg'
import { seedDatabase } from '../../src/ingest/commands.ts'
import { upgradeHead } from '../../src/db/index.ts'
import { loadCorpus, type Chunk } from '../../src/ingest/chunker.ts'
import { replace, seedChunks } from '../../src/ingest/seed.ts'
import { embeddingsDir } from '../../src/retrieval/embeddings.ts'
import { EMBEDDING_DIM } from '../../src/retrieval/index.ts'
import { npyBytes, parseNpy, type Float16Npy } from '../../src/retrieval/npy.ts'
import { afterAll, beforeAll } from 'vitest'
import { describe, expect, test } from '../support/harness.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')
const ROWS =
  'SELECT id::int AS id, celex, act, lang, element_id, kind, article, heading, text FROM chunks ORDER BY id'

type Row = {
  id: number
  celex: string
  act: string
  lang: string
  element_id: string
  kind: string
  article: number | null
  heading: string | null
  text: string
}
type Meta = { citation_key: string; lang: string }[]

let corpus: Chunk[]
const roots: string[] = []

beforeAll(async () => {
  corpus = await loadCorpus(ROOT)
})

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

async function withClient<T>(url: string, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    return await run(client)
  } finally {
    await client.end()
  }
}

async function seed(url: string, root: string): Promise<number> {
  return await withClient(url, (client) => seedChunks(client, root))
}

async function rows(url: string): Promise<Row[]> {
  return await withClient(url, async (client) => (await client.query<Row>(ROWS)).rows)
}

function content(row: Row): Omit<Row, 'id'> {
  return {
    celex: row.celex,
    act: row.act,
    lang: row.lang,
    element_id: row.element_id,
    kind: row.kind,
    article: row.article,
    heading: row.heading,
    text: row.text,
  }
}

function chunkRow(chunk: Chunk): Omit<Row, 'id'> {
  return {
    celex: chunk.celex,
    act: chunk.act,
    lang: chunk.lang,
    element_id: chunk.elementId,
    kind: chunk.kind,
    article: chunk.article,
    heading: chunk.heading,
    text: chunk.text,
  }
}

const swapFirstTwo = (m: Meta): Meta => [m[1]!, m[0]!, ...m.slice(2)]
const relabelFirst = (m: Meta): Meta => [{ ...m[0]!, lang: 'pl' }, ...m.slice(1)]

function dropColumn(npy: Float16Npy): Float16Npy {
  const [r = 0, c = 0] = npy.shape
  const data = new Float16Array(r * (c - 1))
  for (let i = 0; i < r; i++) data.set(npy.data.subarray(i * c, i * c + c - 1), i * (c - 1))
  return { shape: [r, c - 1], data }
}

function dropRow(npy: Float16Npy): Float16Npy {
  const [r = 0, c = 0] = npy.shape
  return { shape: [r - 1, c], data: npy.data.slice(0, (r - 1) * c) }
}

async function rootWith(
  vectors: (npy: Float16Npy) => Float16Npy = (npy) => npy,
  meta: (listed: Meta) => Meta = (listed) => listed,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mokosz-seed-'))
  roots.push(root)
  await cp(join(ROOT, 'data', 'raw'), join(root, 'data', 'raw'), { recursive: true })
  const source = embeddingsDir(ROOT)
  const target = embeddingsDir(root)
  await mkdir(target, { recursive: true })
  const array = parseNpy(await readFile(join(source, 'chunks.npy')))
  await writeFile(
    join(target, 'chunks.npy'),
    npyBytes(vectors({ shape: [...array.shape], data: array.data.slice() })),
  )
  const listed: Meta = JSON.parse(await readFile(join(source, 'chunks.json'), 'utf8'))
  await writeFile(join(target, 'chunks.json'), JSON.stringify(meta(listed)))
  return root
}

describe('seed_chunks', () => {
  test('seed inserts the corpus in order with its embeddings', async ({
    throwawayDatabaseUrl: url,
  }) => {
    await upgradeHead(url)

    expect(await seedDatabase(url, ROOT)).toBe(corpus.length)

    const stored = await rows(url)
    expect(stored.map((row) => row.id)).toEqual(corpus.map((_, i) => i + 1))
    expect(stored.map(content)).toEqual(corpus.map(chunkRow))

    const texts = await withClient(
      url,
      async (client) =>
        (
          await client.query<{ embedding: string }>(
            'SELECT embedding::text AS embedding FROM chunks ORDER BY id',
          )
        ).rows,
    )
    const committed = parseNpy(await readFile(join(embeddingsDir(ROOT), 'chunks.npy')))
    expect(committed.shape).toEqual([corpus.length, EMBEDDING_DIM])
    expect(texts).toHaveLength(corpus.length)
    texts.forEach(({ embedding }, r) => {
      const vector: number[] = JSON.parse(embedding)
      expect(vector).toHaveLength(EMBEDDING_DIM)
      const stale = vector.findIndex(
        // pgvector prints float4 text; fround is the float32 compared against. Object.is keeps the sign of zero.
        (value, c) => !Object.is(Math.fround(value), committed.data[r * EMBEDDING_DIM + c]),
      )
      expect(stale, `row ${r}`).toBe(-1)
    })
  })

  test('seed rerun replaces the content', async ({ throwawayDatabaseUrl: url }) => {
    await upgradeHead(url)
    await seed(url, ROOT)
    const first = await rows(url)

    expect(await seed(url, ROOT)).toBe(corpus.length)

    expect(await rows(url)).toEqual(first)
  })

  test.for([
    ['json-order', undefined, swapFirstTwo, 'chunks.json'],
    ['json-missing-key', undefined, (m: Meta) => m.slice(0, -1), 'chunks.json'],
    ['json-wrong-lang', undefined, relabelFirst, 'chunks.json'],
    ['npy-width', dropColumn, undefined, 'chunks.npy'],
    ['npy-rows', dropRow, undefined, 'chunks.npy'],
  ] as const)(
    'seed rejects mismatched files without writing: %s',
    async ([, vectors, meta, message], { throwawayDatabaseUrl: url }) => {
      await upgradeHead(url)
      await seed(url, ROOT)
      const before = await rows(url)
      const root = await rootWith(vectors, meta)

      await expect(seed(url, root)).rejects.toMatchObject({
        name: 'SeedError',
        message: expect.stringContaining(message),
      })
      expect(await rows(url)).toEqual(before)
    },
  )

  test('seed rejects wrong width on an empty table', async ({ throwawayDatabaseUrl: url }) => {
    await upgradeHead(url)
    const root = await rootWith(dropColumn)

    await expect(seed(url, root)).rejects.toThrow(/chunks\.npy/)

    expect(await rows(url)).toEqual([])
  })

  test('seed failing mid-copy keeps the previous content', async ({
    throwawayDatabaseUrl: url,
  }) => {
    await upgradeHead(url)
    await seed(url, ROOT)
    const before = await rows(url)
    const root = await rootWith((npy) => {
      npy.data[npy.data.length - EMBEDDING_DIM] = Number.NaN
      return npy
    })

    await withClient(url, async (client) => {
      await expect(seedChunks(client, root)).rejects.toMatchObject({
        code: expect.stringMatching(/^22/),
        message: expect.stringContaining('NaN'),
      })
      // A missing ROLLBACK would leave this client in an aborted transaction.
      expect((await client.query('SELECT 1 AS one')).rows).toEqual([{ one: 1 }])
    })
    expect(await rows(url)).toEqual(before)
  })

  test('seeded test database holds the corpus counts', async ({ seededDatabaseUrl: url }) => {
    const counted = await withClient(
      url,
      async (client) =>
        (
          await client.query<{ lang: string; act: string; n: number }>(
            'SELECT lang, act, count(*)::int AS n FROM chunks GROUP BY 1, 2',
          )
        ).rows,
    )

    const expected = new Map<string, number>()
    for (const chunk of corpus) {
      const key = `${chunk.lang}/${chunk.act}`
      expected.set(key, (expected.get(key) ?? 0) + 1)
    }
    expect(new Map(counted.map((row) => [`${row.lang}/${row.act}`, row.n]))).toEqual(expected)
  })

  test.for(['chunks.npy', 'chunks.json'])(
    'seed names a missing embedding file: %s',
    async (name, { throwawayDatabaseUrl: url }) => {
      await upgradeHead(url)
      const root = await rootWith()
      await unlink(join(embeddingsDir(root), name))

      await expect(seed(url, root)).rejects.toThrow(new RegExp(`${name} is missing`))

      expect(await rows(url)).toEqual([])
    },
  )

  test('seed on an unmigrated database asks for setup', async ({ throwawayDatabaseUrl: url }) => {
    await expect(seed(url, ROOT)).rejects.toMatchObject({
      name: 'SeedError',
      message: 'chunks table missing; run mokosz setup',
    })
  })
})

const synthetic = (overrides: Partial<Chunk>): Chunk => ({
  celex: '32016R0679',
  act: 'GDPR',
  lang: 'en',
  elementId: 'rct_1',
  kind: 'recital',
  article: null,
  heading: null,
  text: 'x',
  ...overrides,
})

describe('the COPY text format', () => {
  const SPECIAL = 'a\\b\tc\rd\be\ff\vg\nh \\N \\t end'

  test('backslashes, control characters and a literal \\N come back exactly', async ({
    throwawayDatabaseUrl: url,
  }) => {
    await upgradeHead(url)
    const chunks = [
      synthetic({ text: SPECIAL, heading: SPECIAL, article: 7 }),
      synthetic({ elementId: 'rct_2', text: '\\N', heading: '\\N' }),
      synthetic({ elementId: 'rct_3', text: 'plain', heading: null }),
    ]
    await withClient(url, (client) => replace(client, chunks, new Float16Array(3 * EMBEDDING_DIM)))

    const stored = await rows(url)

    expect(stored.map((row) => [row.text, row.heading, row.article])).toEqual([
      [SPECIAL, SPECIAL, 7],
      ['\\N', '\\N', null],
      ['plain', null, null],
    ])
  })

  test('a negative zero is stored as -0', async ({ throwawayDatabaseUrl: url }) => {
    await upgradeHead(url)
    const data = new Float16Array(EMBEDDING_DIM)
    data[0] = -0
    data[1] = 0.5
    await withClient(url, (client) => replace(client, [synthetic({})], data))

    const [stored] = await withClient(
      url,
      async (client) =>
        (
          await client.query<{ embedding: string }>(
            'SELECT embedding::text AS embedding FROM chunks',
          )
        ).rows,
    )

    const vector: number[] = JSON.parse(stored!.embedding)
    expect(Object.is(vector[0], -0)).toBe(true)
    expect(vector[1]).toBe(0.5)
  })
})
