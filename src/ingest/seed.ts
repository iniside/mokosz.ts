import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { isDeepStrictEqual } from 'node:util'
import type { Client } from 'pg'
import { from as copyFrom } from 'pg-copy-streams'
import { embeddingsDir } from '../retrieval/embeddings.ts'
import { EMBEDDING_DIM } from '../retrieval/index.ts'
import { parseNpy, shapeRepr } from '../retrieval/npy.ts'
import { citationKey, loadCorpus, type Chunk } from './chunker.ts'

export const COPY_CHUNKS =
  'COPY chunks (celex, act, lang, element_id, kind, article, heading, text, embedding) FROM STDIN'

const UNDEFINED_TABLE = '42P01'

export class SeedError extends Error {
  override readonly name = 'SeedError'
}

function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

async function readOrMissing<T>(path: string, read: (path: string) => Promise<T>): Promise<T> {
  try {
    return await read(path)
  } catch (error) {
    if (codeOf(error) === 'ENOENT') {
      throw new SeedError(`${path} is missing`, { cause: error })
    }
    throw error
  }
}

export async function seedChunks(client: Client, root: string): Promise<number> {
  const corpus = await loadCorpus(root)
  const directory = embeddingsDir(root)
  const npyPath = join(directory, 'chunks.npy')
  const jsonPath = join(directory, 'chunks.json')
  const npy = await readOrMissing(npyPath, (path) => readFile(path))
  const meta: unknown = JSON.parse(await readOrMissing(jsonPath, (path) => readFile(path, 'utf8')))
  const { shape, data } = parseNpy(npy)

  const expected = corpus.map((chunk) => ({ citation_key: citationKey(chunk), lang: chunk.lang }))
  if (!isDeepStrictEqual(meta, expected)) {
    throw new SeedError(`${jsonPath} does not list the corpus keys in order`)
  }
  if (shape.length !== 2 || shape[0] !== corpus.length || shape[1] !== EMBEDDING_DIM) {
    throw new SeedError(
      `${npyPath} has shape ${shapeRepr(shape)}, expected ${shapeRepr([corpus.length, EMBEDDING_DIM])}`,
    )
  }

  try {
    await replace(client, corpus, data)
  } catch (error) {
    if (codeOf(error) === UNDEFINED_TABLE) {
      throw new SeedError('chunks table missing; run mokosz setup', { cause: error })
    }
    throw error
  }
  return corpus.length
}

// String(-0) is '0'; the sign of zero is kept.
function vectorText(data: Float16Array, row: number): string {
  const values: string[] = []
  for (let c = 0; c < EMBEDDING_DIM; c++) {
    const value = data[row * EMBEDDING_DIM + c]!
    values.push(Object.is(value, -0) ? '-0' : String(value))
  }
  return `[${values.join(',')}]`
}

const COPY_ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\v': '\\v',
}

function copyField(value: string | number | null): string {
  if (value === null) return '\\N'
  return String(value).replace(/[\\\b\f\n\r\t\v]/g, (char) => COPY_ESCAPES[char]!)
}

function* copyRows(corpus: readonly Chunk[], data: Float16Array): Generator<string> {
  for (const [row, chunk] of corpus.entries()) {
    yield `${[
      chunk.celex,
      chunk.act,
      chunk.lang,
      chunk.elementId,
      chunk.kind,
      chunk.article,
      chunk.heading,
      chunk.text,
      vectorText(data, row),
    ]
      .map(copyField)
      .join('\t')}\n`
  }
}

export async function replace(
  client: Client,
  corpus: readonly Chunk[],
  data: Float16Array,
): Promise<void> {
  await client.query('BEGIN')
  try {
    await client.query('TRUNCATE chunks RESTART IDENTITY')
    const copy = client.query(copyFrom(COPY_CHUNKS))
    await pipeline(Readable.from(copyRows(corpus, data)), copy)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}
