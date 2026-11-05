import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AISDKError, APICallError, InvalidResponseDataError, embedMany } from 'ai'
import { createOllama } from 'ollama-ai-provider-v2'
import { z } from 'zod'
import { LangSchema } from '../ingest/acts.ts'
import { citationKey, embeddingText, type Chunk } from '../ingest/chunker.ts'
import { describe, httpClient } from '../llm/http.ts'
import { getSettings } from '../settings.ts'
import { EMBEDDING_MODEL, recallAtK, type ChunkMeta, type Matrix, type QueryMeta } from './index.ts'
import { float16Rows, npyBytes, parseNpy } from './npy.ts'

export const NUM_CTX = 4096
export const BATCH_SIZE = 64
export const RECALL_K = 5
export const QUERY_TASK =
  'Given a question about EU law, retrieve the passages of the regulation that answer it'
const INSTRUCTED_MODELS = new Set(['qwen3-embedding:0.6b'])
const TOO_LONG = 'input length exceeds the context length'
// 100 minutes for the connect, the headers and the body of one embedding request.
export const EMBED_TIMEOUT_MS = 6_000_000
// Client errors that mean auth, a missing model, a timeout or a rate limit, never a too-long input.
const NOT_INPUT_ERRORS = new Set([401, 403, 404, 408, 429])

export class EmbeddingError extends Error {
  override name = 'EmbeddingError'
}

class InputTooLong extends Error {}

export const EvalQuerySchema = z.strictObject({
  id: z.string(),
  lang: LangSchema,
  act: z.string(),
  text: z.string(),
  expected: z.array(z.string()),
})
export type EvalQuery = z.infer<typeof EvalQuerySchema>

export interface EmbeddingRun {
  directory: string
  seconds: number
}

export async function loadQueries(root: string): Promise<EvalQuery[]> {
  const path = join(root, 'evals', 'retrieval', 'queries.json')
  const items: unknown = JSON.parse(await readFile(path, 'utf8'))
  return z.array(EvalQuerySchema).parse(items)
}

export function modelSlug(model: string): string {
  return model.replaceAll(':', '-').replaceAll('/', '-')
}

export function embeddingsDir(root: string, model: string = EMBEDDING_MODEL): string {
  return join(root, 'data', 'embeddings', modelSlug(model))
}

export function queryText(model: string, text: string): string {
  if (INSTRUCTED_MODELS.has(model)) return `Instruct: ${QUERY_TASK}\nQuery:${text}`
  return text
}

export interface EmbedOptions {
  timeoutMs?: number
}

// The provider's embedding body has no `options`, so num_ctx is added on the wire.
function ollamaFetch(timeoutMs: number): typeof fetch {
  return httpClient(timeoutMs, (body) => {
    body.options = { num_ctx: NUM_CTX }
  })
}

function isBadRequest(error: APICallError): boolean {
  const status = error.statusCode
  return status !== undefined && status >= 400 && status < 500 && !NOT_INPUT_ERRORS.has(status)
}

async function embedValues(
  model: string,
  texts: string[],
  baseUrl: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<number[][]> {
  const ollama = createOllama({ baseURL: `${baseUrl}/api`, fetch: ollamaFetch(timeoutMs) })
  try {
    const { embeddings } = await embedMany({
      model: ollama.embedding(model, { truncate: false }),
      values: texts,
      maxRetries: 0,
      abortSignal,
    })
    return embeddings
  } catch (error) {
    if (InvalidResponseDataError.isInstance(error) && Array.isArray(error.data)) {
      throw new EmbeddingError(
        `Ollama returned ${error.data.length} embeddings for ${texts.length} inputs`,
      )
    }
    throw error
  }
}

async function embedBatch(
  model: string,
  texts: string[],
  baseUrl: string,
  timeoutMs: number,
): Promise<number[][]> {
  try {
    return await embedValues(model, texts, baseUrl, timeoutMs)
  } catch (error) {
    if (error instanceof EmbeddingError || !AISDKError.isInstance(error)) throw error
    const message = describe(error)
    if (APICallError.isInstance(error) && isBadRequest(error) && message.includes(TOO_LONG)) {
      throw new InputTooLong(message)
    }
    throw new EmbeddingError(`${model}: ${message}`)
  }
}

export async function embedQuery(
  text: string,
  options: EmbedOptions & { abortSignal?: AbortSignal } = {},
): Promise<number[]> {
  const texts = [queryText(EMBEDDING_MODEL, text)]
  let vectors: number[][]
  try {
    vectors = await embedValues(
      EMBEDDING_MODEL,
      texts,
      getSettings().ollamaBaseUrl,
      options.timeoutMs ?? EMBED_TIMEOUT_MS,
      options.abortSignal,
    )
  } catch (error) {
    if (error instanceof EmbeddingError || !AISDKError.isInstance(error)) throw error
    throw new EmbeddingError(`${EMBEDDING_MODEL}: ${describe(error)}`)
  }
  return vectors[0]!
}

export async function embedTexts(
  model: string,
  labels: readonly string[],
  texts: readonly string[],
  baseUrl: string,
  options: EmbedOptions = {},
): Promise<Float32Array[]> {
  const timeoutMs = options.timeoutMs ?? EMBED_TIMEOUT_MS
  if (labels.length !== texts.length) throw new Error('labels and texts differ in number')
  const rows: Float32Array[] = []
  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const batch = texts.slice(start, start + BATCH_SIZE)
    try {
      for (const vector of await embedBatch(model, batch, baseUrl, timeoutMs)) {
        rows.push(Float32Array.from(vector))
      }
    } catch (error) {
      if (!(error instanceof InputTooLong)) throw error
      for (const [i, text] of batch.entries()) {
        try {
          await embedBatch(model, [text], baseUrl, timeoutMs)
        } catch (single) {
          if (single instanceof InputTooLong) {
            throw new EmbeddingError(`${labels[start + i]}: ${single.message}`, { cause: single })
          }
          throw single
        }
      }
      throw new EmbeddingError(
        `batch ${labels[start]} .. ${labels[start + batch.length - 1]}: ${error.message}`,
        { cause: error },
      )
    }
  }
  return rows
}

function jsonBytes(rows: object[]): string {
  return `${JSON.stringify(rows, null, 1)}\n`
}

export async function writeEmbeddings(
  directory: string,
  model: string,
  corpus: readonly Chunk[],
  queries: readonly EvalQuery[],
  baseUrl: string,
): Promise<EmbeddingRun> {
  const started = performance.now()
  const chunkVectors = await embedTexts(
    model,
    corpus.map((chunk) => `${citationKey(chunk)} (${chunk.lang})`),
    corpus.map(embeddingText),
    baseUrl,
  )
  const queryVectors = await embedTexts(
    model,
    queries.map((query) => `query ${query.id}`),
    queries.map((query) => queryText(model, query.text)),
    baseUrl,
  )
  const seconds = (performance.now() - started) / 1000

  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'chunks.npy'), npyBytes(float16Rows(chunkVectors)))
  await writeFile(
    join(directory, 'chunks.json'),
    jsonBytes(corpus.map((chunk) => ({ citation_key: citationKey(chunk), lang: chunk.lang }))),
  )
  await writeFile(join(directory, 'queries.npy'), npyBytes(float16Rows(queryVectors)))
  await writeFile(
    join(directory, 'queries.json'),
    jsonBytes(queries.map((query) => ({ id: query.id, lang: query.lang }))),
  )
  return { directory, seconds }
}

async function loadMatrix(path: string): Promise<Matrix> {
  const { shape, data } = parseNpy(await readFile(path))
  if (shape.length !== 2)
    throw new Error(`${path}: expected a 2-D array, not shape (${shape.join(', ')})`)
  return { rows: shape[0]!, cols: shape[1]!, data }
}

function selectRows(matrix: Matrix, rows: number[]): Matrix {
  const data = new Float64Array(rows.length * matrix.cols)
  rows.forEach((row, i) => {
    for (let c = 0; c < matrix.cols; c++)
      data[i * matrix.cols + c] = matrix.data[row * matrix.cols + c]!
  })
  return { rows: rows.length, cols: matrix.cols, data }
}

export type RecallReport = Record<'overall' | 'en' | 'pl', number>

export async function recallReport(
  directory: string,
  queries: readonly EvalQuery[],
): Promise<RecallReport> {
  const chunks = await loadMatrix(join(directory, 'chunks.npy'))
  const chunkMeta: ChunkMeta[] = JSON.parse(await readFile(join(directory, 'chunks.json'), 'utf8'))
  const vectors = await loadMatrix(join(directory, 'queries.npy'))
  const queryMeta: QueryMeta[] = JSON.parse(await readFile(join(directory, 'queries.json'), 'utf8'))
  const expected = Object.fromEntries(queries.map((query) => [query.id, query.expected]))

  const score = (lang: string | null): number => {
    const rows = queryMeta.flatMap((meta, i) => (lang === null || meta.lang === lang ? [i] : []))
    return recallAtK(
      chunks,
      chunkMeta,
      selectRows(vectors, rows),
      rows.map((i) => queryMeta[i]!),
      expected,
      RECALL_K,
    )
  }

  return { overall: score(null), en: score('en'), pl: score('pl') }
}
