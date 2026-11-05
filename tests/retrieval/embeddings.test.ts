import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { crc32 } from 'node:zlib'
import { vi } from 'vitest'
import { main } from '../../src/cli.ts'
import { embedCommand } from '../../src/ingest/commands.ts'
import { citationKey, embeddingText, loadCorpus, type Chunk } from '../../src/ingest/chunker.ts'
import { EMBEDDING_MODEL, recallAtK } from '../../src/retrieval/index.ts'
import {
  BATCH_SIZE,
  EmbeddingError,
  QUERY_TASK,
  EMBED_TIMEOUT_MS,
  embedQuery,
  embedTexts,
  loadQueries,
  modelSlug,
  queryText,
  recallReport,
  writeEmbeddings,
  type EmbeddingRun,
  type EvalQuery,
} from '../../src/retrieval/embeddings.ts'
import { npyBytes, parseNpy } from '../../src/retrieval/npy.ts'
import { clearSettingsCache, getSettings } from '../../src/settings.ts'
import { closedPort, portOf, spyOnSockets } from '../support/network.ts'
import { describe, expect, test as harnessTest } from '../support/harness.ts'

// Every undici Agent and the dispatcher of every undici fetch, so the timeouts in use are seen.
const agentOptions = vi.hoisted(() => new WeakMap<object, unknown>())
const fetchDispatchers = vi.hoisted((): (object | null)[] => [])
vi.mock('undici', async (importOriginal) => {
  const undici: typeof import('undici') = await importOriginal()
  class Agent extends undici.Agent {
    constructor(options?: ConstructorParameters<typeof undici.Agent>[0]) {
      super(options)
      agentOptions.set(this, options)
    }
  }
  const fetch: typeof undici.fetch = async (input, init) => {
    fetchDispatchers.push(init?.dispatcher ?? null)
    return await undici.fetch(input, init)
  }
  return { ...undici, Agent, fetch }
})

const ROOT = resolve(import.meta.dirname, '..', '..')
const DIM = 64
const TOO_LONG = '{"error":"the input length exceeds the context length"}'
const LONG_CHUNK = ['32016R0679#070.001', 'en'] as const
const POST_CALL_WAIT_MS = 500

// Deterministic per text, integers 1..16 with a sign, so float16 holds them exactly.
function fakeVector(text: string): number[] {
  let state = crc32(Buffer.from(text, 'utf8'))
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32
  }
  return Array.from({ length: DIM }, () => (next() < 0.5 ? -1 : 1) * (1 + Math.floor(next() * 16)))
}

interface Body {
  path: string
  model: string
  input: string[]
  options?: unknown
  truncate?: unknown
}

/** The body the embedding path posts for these inputs. */
function wire(input: string[]): Body {
  return { path: '/api/embed', model: 'bge-m3', input, options: { num_ctx: 4096 }, truncate: false }
}

/** The error a promise rejects with. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  const error: unknown = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  )
  if (!(error instanceof Error)) throw new Error('the promise did not reject with an Error')
  return error
}

interface FakeOllama {
  url: string
  port: number
  bodies: Body[]
  rejected: Set<string>
  aliases: Map<string, string>
  modelErrors: Map<string, [number, string]>
  delay: number[]
  short: Set<string>
  rejectBatches: boolean
  tooLongStatus: number
  vectors: Map<string, number[]>
  stallBody: boolean
  answerWithFirstExpected(model: string, queries: EvalQuery[], corpus: Chunk[]): void
}

async function startOllama(): Promise<{ ollama: FakeOllama; close: () => void }> {
  const ollama: FakeOllama = {
    url: '',
    port: 0,
    bodies: [],
    rejected: new Set(),
    aliases: new Map(),
    modelErrors: new Map(),
    delay: [],
    short: new Set(),
    rejectBatches: false,
    tooLongStatus: 400,
    vectors: new Map(),
    stallBody: false,
    answerWithFirstExpected(model, queries, corpus) {
      const texts = new Map(corpus.map((c) => [`${citationKey(c)} ${c.lang}`, embeddingText(c)]))
      for (const query of queries) {
        this.aliases.set(
          queryText(model, query.text),
          texts.get(`${query.expected[0]} ${query.lang}`)!,
        )
      }
    },
  }
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const parts: Buffer[] = []
    for await (const part of request) parts.push(Buffer.from(part))
    const body: Omit<Body, 'path'> = JSON.parse(Buffer.concat(parts).toString('utf8'))
    ollama.bodies.push({ path: request.url ?? '', ...body })
    if (ollama.delay.length > 0) await sleep(ollama.delay[0])
    let code = 200
    let payload: string
    const error = ollama.modelErrors.get(body.model)
    if (error !== undefined) {
      ;[code, payload] = error
    } else if (
      body.input.some((text) => ollama.rejected.has(text)) ||
      (ollama.rejectBatches && body.input.length > 1)
    ) {
      ;[code, payload] = [ollama.tooLongStatus, TOO_LONG]
    } else {
      const vectors = body.input.map(
        (text) => ollama.vectors.get(text) ?? fakeVector(ollama.aliases.get(text) ?? text),
      )
      payload = JSON.stringify({
        model: body.model,
        embeddings: ollama.short.has(body.model) ? vectors.slice(1) : vectors,
        total_duration: 1,
        load_duration: 1,
        prompt_eval_count: 1,
      })
    }
    response.writeHead(code, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    })
    if (ollama.stallBody) {
      response.write(payload.slice(0, 1))
      return
    }
    response.end(payload)
  }
  const server = createServer((request, response) => {
    handle(request, response).catch(() => response.destroy())
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  ollama.port = portOf(server)
  ollama.url = `http://127.0.0.1:${ollama.port}`
  return {
    ollama,
    close: () => {
      server.close()
      server.closeAllConnections()
    },
  }
}

function useOllamaUrl(url: string): () => void {
  const before = process.env.OLLAMA_BASE_URL
  process.env.OLLAMA_BASE_URL = url
  clearSettingsCache()
  return () => {
    if (before === undefined) delete process.env.OLLAMA_BASE_URL
    else process.env.OLLAMA_BASE_URL = before
    clearSettingsCache()
  }
}

const corpus = await loadCorpus(ROOT)
const queries = await loadQueries(ROOT)

const test = harnessTest
  .extend('ollama', async ({}, { onCleanup }): Promise<FakeOllama> => {
    const { ollama, close } = await startOllama()
    onCleanup(close)
    return ollama
  })
  .extend('tmp', async ({}, { onCleanup }): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'mokosz-embed-'))
    onCleanup(() => rm(dir, { recursive: true, force: true }))
    return dir
  })
  .extend('clone', async ({ ollama, tmp }, { onCleanup }): Promise<string> => {
    await cp(join(ROOT, 'data', 'raw'), join(tmp, 'data', 'raw'), { recursive: true })
    await cp(join(ROOT, 'evals', 'retrieval'), join(tmp, 'evals', 'retrieval'), {
      recursive: true,
    })
    onCleanup(useOllamaUrl(ollama.url))
    return tmp
  })
  .extend('ollamaSettings', ({ ollama }, { onCleanup }): FakeOllama => {
    onCleanup(useOllamaUrl(ollama.url))
    return ollama
  })

interface Invoked {
  code: number
  stdout: string
  stderr: string
}

async function embed(
  root: string,
  args: string[],
  write: typeof writeEmbeddings = writeEmbeddings,
): Promise<Invoked> {
  let stdout = ''
  let stderr = ''
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk)
    return true
  })
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk)
    return true
  })
  try {
    const code = await main(['embed', ...args], {
      embed: (models) => embedCommand(root, getSettings().ollamaBaseUrl, models, write),
    })
    return { code, stdout, stderr }
  } finally {
    out.mockRestore()
    err.mockRestore()
  }
}

/** The single line a failed embed prints, on stderr, with nothing on stdout. */
function singleFailureLine(result: Invoked): string {
  expect(result.code, result.stdout + result.stderr).toBe(1)
  expect(result.stdout).toBe('')
  const lines = result.stderr.split('\n').filter((line) => line !== '')
  expect(lines).toHaveLength(1)
  return lines[0]!
}

async function buryExpected(directory: string): Promise<void> {
  const chunks = parseNpy(await readFile(join(directory, 'chunks.npy')))
  const vectors = parseNpy(await readFile(join(directory, 'queries.npy')))
  const cols = chunks.shape[1]!
  const rows = new Map(corpus.map((c, i) => [`${citationKey(c)} ${c.lang}`, i]))
  queries.forEach((query, q) => {
    for (const key of query.expected) {
      const row = rows.get(`${key} ${query.lang}`)!
      for (let c = 0; c < cols; c++) chunks.data[row * cols + c] = -vectors.data[q * cols + c]!
    }
  })
  await writeFile(join(directory, 'chunks.npy'), npyBytes(chunks))
}

const writeThenBury: typeof writeEmbeddings = async (...args): Promise<EmbeddingRun> => {
  const run = await writeEmbeddings(...args)
  await buryExpected(run.directory)
  return run
}

function f16(values: number[]): number[] {
  return [...Float16Array.from(Float32Array.from(values))]
}

function rowsOf(file: { shape: number[]; data: Float16Array }): number[][] {
  const rows = file.shape[0]!
  const cols = file.shape[1]!
  return Array.from({ length: rows }, (_, r) => [...file.data.subarray(r * cols, (r + 1) * cols)])
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}

const firstHitOnly = queries.reduce((sum, q) => sum + 1 / q.expected.length, 0) / queries.length

function ranked(n: number): number[] {
  return Array.from({ length: n }, (_, i) => [Math.cos(i * 0.1), Math.sin(i * 0.1)]).flat()
}

const f16Matrix = (values: number[], rows: number) => ({
  shape: [rows, 2],
  data: Float16Array.from(values),
})
const matrix = (data: number[], cols = 2) => ({ rows: data.length / cols, cols, data })
const chunkMeta = (keys: string[], lang = 'en') => keys.map((key) => ({ citation_key: key, lang }))
const QUERY = [1, 0]
const ONE_QUERY = [{ id: 'q', lang: 'en' }]

describe('recall@k', () => {
  test.for([
    [['a'], ['a', 'x', 'y', 'z', 'w', 'v'], 1],
    [['a', 'b'], ['a', 'x', 'y', 'z', 'w', 'b'], 0.5],
    [['a'], ['x', 'y', 'z', 'w', 'v', 'a'], 0],
    [['a', 'b', 'c'], ['c', 'b', 'a', 'x', 'y', 'z'], 1],
  ] as const)('expected %j in ranking %j scores %s', ([expected, ranking, recall]) => {
    const score = recallAtK(
      matrix(ranked(6)),
      chunkMeta([...ranking]),
      matrix(QUERY),
      ONE_QUERY,
      { q: expected },
      5,
    )

    expect(score).toBe(recall)
  })

  test('recall is the mean over queries', () => {
    const ranking = ['a', 'x', 'y', 'z', 'w', 'b']
    const queryMeta = ['full', 'half', 'none'].map((id) => ({ id, lang: 'en' }))
    const expected = { full: ['a'], half: ['a', 'b'], none: ['b'] }

    const score = recallAtK(
      matrix(ranked(6)),
      chunkMeta(ranking),
      matrix([...QUERY, ...QUERY, ...QUERY]),
      queryMeta,
      expected,
      5,
    )

    expect(score).toBe(0.5)
  })

  test('recall ranks only chunks of the query language', () => {
    const meta = [...chunkMeta(['pl-best'], 'pl'), ...chunkMeta(['x', 'y', 'z', 'w', 'a'])]

    const en = recallAtK(matrix(ranked(6)), meta, matrix(QUERY), ONE_QUERY, { q: ['a'] }, 5)
    const pl = recallAtK(
      matrix(ranked(6)),
      meta,
      matrix(QUERY),
      [{ id: 'q', lang: 'pl' }],
      { q: ['a'] },
      5,
    )

    expect(en).toBe(1)
    expect(pl).toBe(0)
  })

  test.for([
    ['k12', 1],
    ['k15', 0],
  ] as const)('recall breaks ties by row order: %s scores %d', ([key, recall]) => {
    const angles = Array.from({ length: 300 }, (_, i) => [0, 0.5, 1][i % 3]!)
    const chunks = angles.flatMap((angle) => [Math.cos(angle), Math.sin(angle)])
    const keys = Array.from({ length: 300 }, (_, i) => `k${i}`)

    const score = recallAtK(
      matrix(chunks),
      chunkMeta(keys),
      matrix(QUERY),
      ONE_QUERY,
      {
        q: [key],
      },
      5,
    )

    expect(score).toBe(recall)
  })

  test('recall uses cosine, not the dot product', () => {
    const chunks = [0.01, 0.0001, 100, 100]
    const meta = chunkMeta(['near', 'long'])

    expect(recallAtK(matrix(chunks), meta, matrix(QUERY), ONE_QUERY, { q: ['near'] }, 1)).toBe(1)
    const scaled = [0.01 * 1000, 0.0001 * 1000, 100, 100]
    expect(recallAtK(matrix(scaled), meta, matrix(QUERY), ONE_QUERY, { q: ['near'] }, 1)).toBe(1)
  })

  test('recall refuses metadata of another length and no queries', () => {
    expect(() =>
      recallAtK(matrix(ranked(2)), chunkMeta(['a']), matrix(QUERY), ONE_QUERY, { q: ['a'] }, 5),
    ).toThrow('embedding rows and metadata rows differ in number')
    expect(() => recallAtK(matrix(ranked(1)), chunkMeta(['a']), matrix([]), [], {}, 5)).toThrow(
      'no queries to score',
    )
    expect(() =>
      recallAtK(matrix(ranked(1)), chunkMeta(['a']), matrix(QUERY), ONE_QUERY, { q: [] }, 5),
    ).toThrow('query q has no expected keys')
  })

  test('recall report scores the top 5', async ({ tmp }) => {
    const keys = Array.from({ length: 7 }, (_, i) => `k${i}`)
    await writeFile(join(tmp, 'chunks.npy'), npyBytes(f16Matrix([...ranked(7), ...QUERY], 8)))
    await writeFile(
      join(tmp, 'chunks.json'),
      JSON.stringify([...chunkMeta(keys), ...chunkMeta(['p0'], 'pl')]),
    )
    const cases = [
      ['rank5', 'en', 'k4'],
      ['rank6', 'en', 'k5'],
      ['pl', 'pl', 'p0'],
    ] as const
    await writeFile(
      join(tmp, 'queries.npy'),
      npyBytes(f16Matrix([...QUERY, ...QUERY, ...QUERY], 3)),
    )
    await writeFile(
      join(tmp, 'queries.json'),
      JSON.stringify(cases.map(([id, lang]) => ({ id, lang }))),
    )
    const evalQueries = cases.map(([id, lang, key]) => ({
      id,
      lang,
      act: 'GDPR',
      text: id,
      expected: [key],
    }))

    const report = await recallReport(tmp, evalQueries)

    expect(report).toEqual({ overall: 2 / 3, en: 0.5, pl: 1 })
  })
})

describe('writing the embeddings', () => {
  test('write embeddings round trip', async ({ tmp, ollama }) => {
    const run = await writeEmbeddings(join(tmp, 'bge-m3'), 'bge-m3', corpus, queries, ollama.url)

    const chunks = parseNpy(await readFile(join(run.directory, 'chunks.npy')))
    const vectors = parseNpy(await readFile(join(run.directory, 'queries.npy')))
    expect(chunks.shape).toEqual([corpus.length, DIM])
    expect(vectors.shape).toEqual([queries.length, DIM])
    expect(rowsOf(chunks)).toEqual(corpus.map((chunk) => f16(fakeVector(embeddingText(chunk)))))
    expect(rowsOf(vectors)).toEqual(queries.map((query) => f16(fakeVector(query.text))))
    expect(await readJson(join(run.directory, 'chunks.json'))).toEqual(
      corpus.map((chunk) => ({ citation_key: citationKey(chunk), lang: chunk.lang })),
    )
    expect(await readJson(join(run.directory, 'queries.json'))).toEqual(
      queries.map((query) => ({ id: query.id, lang: query.lang })),
    )
    expect(run.seconds).toBeGreaterThan(0)
  })

  test('the key list is written as json.dumps(rows, ensure_ascii=False, indent=1)', async ({
    tmp,
    ollama,
  }) => {
    const run = await writeEmbeddings(tmp, 'bge-m3', corpus, queries, ollama.url)

    expect(await readFile(join(run.directory, 'chunks.json'))).toEqual(
      await readFile(join(ROOT, 'data', 'embeddings', 'bge-m3', 'chunks.json')),
    )
    expect(await readFile(join(run.directory, 'queries.json'))).toEqual(
      await readFile(join(ROOT, 'data', 'embeddings', 'bge-m3', 'queries.json')),
    )
  })

  test('the request body pins the context, disables truncation and batches', async ({
    tmp,
    ollama,
  }) => {
    const sample = corpus.slice(0, 2 * BATCH_SIZE + 2)

    await writeEmbeddings(tmp, 'bge-m3', sample, queries, ollama.url)

    const texts = sample.map(embeddingText)
    expect(ollama.bodies).toEqual([
      wire(texts.slice(0, 64)),
      wire(texts.slice(64, 128)),
      wire(texts.slice(128)),
      wire(queries.map((query) => query.text)),
    ])
    expect(ollama.bodies.map((body) => body.input.length)).toEqual([64, 64, 2, 20])
  })

  test('qwen3 prefixes queries only', async ({ tmp, ollama }) => {
    const sample = corpus.slice(0, 3)

    await writeEmbeddings(tmp, 'qwen3-embedding:0.6b', sample, queries, ollama.url)

    const [documents, prompts] = ollama.bodies
    expect(ollama.bodies).toHaveLength(2)
    expect([documents!.model, prompts!.model]).toEqual([
      'qwen3-embedding:0.6b',
      'qwen3-embedding:0.6b',
    ])
    expect(documents!.input).toEqual(sample.map(embeddingText))
    expect(prompts!.input).toEqual(
      queries.map(
        (query) =>
          'Instruct: Given a question about EU law, retrieve the passages of the regulation' +
          ` that answer it\nQuery:${query.text}`,
      ),
    )
    expect(prompts!.input[0]).toContain(QUERY_TASK)
  })

  test('a too long input names the chunk key and language', async ({ tmp, ollama }) => {
    const [longChunk] = corpus.filter(
      (c) => citationKey(c) === LONG_CHUNK[0] && c.lang === LONG_CHUNK[1],
    )
    ollama.rejected.add(embeddingText(longChunk!))

    const error = await rejection(
      writeEmbeddings(join(tmp, 'out'), 'bge-m3', corpus, queries, ollama.url),
    )

    expect(error).toBeInstanceOf(EmbeddingError)
    expect(error.message).toMatch(/^32016R0679#070\.001 \(en\): .*exceeds the context length/)
    expect(await readdir(tmp)).toEqual([])
  })

  test('a batch refused as too long whose inputs all fit names the batch', async ({ ollama }) => {
    ollama.rejectBatches = true

    const error = await rejection(embedTexts('bge-m3', ['one', 'two'], ['a', 'b'], ollama.url))

    expect(error).toBeInstanceOf(EmbeddingError)
    expect(error.message).toMatch(/^batch one \.\. two: .*exceeds the context length/)
    expect(ollama.bodies.map((body) => body.input)).toEqual([['a', 'b'], ['a'], ['b']])
  })

  test.for([400, 402, 413, 422])(
    'a too long input answered with HTTP %i, a bad request, is diagnosed per input',
    async (status, { ollama }) => {
      ollama.rejected.add('b')
      ollama.tooLongStatus = status

      const error = await rejection(embedTexts('bge-m3', ['one', 'two'], ['a', 'b'], ollama.url))

      expect(error).toBeInstanceOf(EmbeddingError)
      expect(error.message).toMatch(/^two: .*exceeds the context length/)
      expect(ollama.bodies.map((body) => body.input)).toEqual([['a', 'b'], ['a'], ['b']])
    },
  )

  test.for([401, 403, 404, 408, 429, 500, 503])(
    'HTTP %i with the too long body is not a BadRequestError: one request, no diagnosis',
    async (status, { ollama }) => {
      ollama.rejected.add('b')
      ollama.tooLongStatus = status

      const error = await rejection(embedTexts('bge-m3', ['one', 'two'], ['a', 'b'], ollama.url))

      expect(error).toBeInstanceOf(EmbeddingError)
      expect(error.message.startsWith('bge-m3: AI_APICallError: ')).toBe(true)
      expect(error.message).toContain('exceeds the context length')
      expect(ollama.bodies).toHaveLength(1)
    },
  )

  test('a server error is not retried', async ({ ollama }) => {
    ollama.modelErrors.set('bge-m3', [500, '{"error":"boom"}'])

    const error = await rejection(embedTexts('bge-m3', ['one'], ['a'], ollama.url))

    expect(error.message).toBe('bge-m3: AI_APICallError: Internal Server Error - {"error":"boom"}')
    expect(ollama.bodies).toHaveLength(1)
  })

  test('vectors are stored as float32 then float16', async ({ tmp, ollama }) => {
    const [chunk] = corpus
    ollama.vectors.set(embeddingText(chunk!), [1 + 2 ** -11 + 2 ** -40, 3])

    const run = await writeEmbeddings(tmp, 'bge-m3', [chunk!], [], ollama.url)

    expect([...parseNpy(await readFile(join(run.directory, 'chunks.npy'))).data]).toEqual([1, 3])
  })

  test('a response slower than the timeout fails the embedding', async ({ ollama }) => {
    ollama.delay.push(3000)
    const started = performance.now()

    const error = await rejection(
      embedTexts('bge-m3', ['one'], ['a'], ollama.url, { timeoutMs: 1000 }),
    )

    expect(performance.now() - started).toBeLessThan(2500)
    expect(error).toBeInstanceOf(EmbeddingError)
    expect(error.message).toMatch(/^bge-m3: AI_APICallError: .*Headers Timeout/)
    expect(ollama.bodies).toHaveLength(1)
    // undici reconnects on a later socket close while the timed-out request is unanswered.
    await sleep(2500)
  })

  test('a response body that stalls past the timeout fails the embedding', async ({ ollama }) => {
    ollama.stallBody = true

    const error = await rejection(
      embedTexts('bge-m3', ['one'], ['a'], ollama.url, { timeoutMs: 1000 }),
    )

    expect(error).toBeInstanceOf(EmbeddingError)
    expect(error.message).toMatch(/^bge-m3: AI_APICallError: .*Body Timeout/)
  })

  test('a connection that never completes fails at the connect timeout', async () => {
    const silent = createNetServer(() => {})
    silent.listen(0, '127.0.0.1')
    await once(silent, 'listening')
    try {
      const started = performance.now()
      const error = await rejection(
        embedTexts('bge-m3', ['one'], ['a'], `https://127.0.0.1:${portOf(silent)}`, {
          timeoutMs: 1000,
        }),
      )

      expect(performance.now() - started).toBeLessThan(2500)
      expect(error).toBeInstanceOf(EmbeddingError)
      expect(error.message).toMatch(/^bge-m3: AI_APICallError: .*Connect Timeout/)
    } finally {
      silent.close()
    }
  })

  test('the default embedding timeout is 6000 s', () => {
    expect(EMBED_TIMEOUT_MS).toBe(6000 * 1000)
  })

  test('embedTexts and embedQuery without a timeout wait 6000 s to connect, for headers and for the body', async ({
    ollamaSettings,
  }) => {
    const timeouts = {
      connectTimeout: 6_000_000,
      headersTimeout: 6_000_000,
      bodyTimeout: 6_000_000,
    }
    fetchDispatchers.length = 0

    await embedTexts('bge-m3', ['one'], ['a'], ollamaSettings.url)
    await embedQuery('q')

    expect(ollamaSettings.bodies).toHaveLength(2)
    expect(
      fetchDispatchers.map((dispatcher) => dispatcher && agentOptions.get(dispatcher)),
    ).toEqual([timeouts, timeouts])
  })

  test('fewer vectors than inputs fail with both counts', async ({ ollama }) => {
    ollama.short.add('bge-m3')

    await expect(embedTexts('bge-m3', ['one', 'two'], ['a', 'b'], ollama.url)).rejects.toThrow(
      new EmbeddingError('Ollama returned 1 embeddings for 2 inputs'),
    )
  })

  test('labels and texts of another length are refused', async ({ ollama }) => {
    await expect(embedTexts('bge-m3', ['one'], [], ollama.url)).rejects.toThrow(
      'labels and texts differ in number',
    )
    expect(ollama.bodies).toEqual([])
  })

  test('the pinned model matches the committed embeddings', async () => {
    const directory = join(ROOT, 'data', 'embeddings', modelSlug(EMBEDDING_MODEL))
    const chunks = parseNpy(await readFile(join(directory, 'chunks.npy')))

    expect(EMBEDDING_MODEL).toBe('bge-m3')
    expect(chunks.data).toBeInstanceOf(Float16Array)
    expect(chunks.shape).toEqual([corpus.length, 1024])
    expect(await readJson(join(directory, 'chunks.json'))).toEqual(
      corpus.map((c) => ({ citation_key: citationKey(c), lang: c.lang })),
    )
    expect(await readdir(join(ROOT, 'data', 'embeddings'))).toEqual(['bge-m3'])
  })

  test('recall report reads the written float16 files', async ({ tmp, ollama }) => {
    ollama.answerWithFirstExpected('bge-m3', queries, corpus)
    const run = await writeEmbeddings(tmp, 'bge-m3', corpus, queries, ollama.url)
    const before = await recallReport(run.directory, queries)
    await buryExpected(run.directory)

    const after = await recallReport(run.directory, queries)

    expect(before.overall).toBeCloseTo(firstHitOnly, 12)
    expect(Object.values(after).map(String)).toEqual(['0', '0', '0'])
  })
})

describe('mokosz embed', () => {
  test('embed defaults to the pinned model', async ({ clone, ollama }) => {
    ollama.answerWithFirstExpected(EMBEDDING_MODEL, queries, corpus)

    const result = await embed(clone, [])

    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout.startsWith(`${EMBEDDING_MODEL}: recall@5 `)).toBe(true)
    expect(await readdir(join(clone, 'data', 'embeddings', modelSlug(EMBEDDING_MODEL)))).toContain(
      'chunks.npy',
    )
  })

  test('embed writes each model and prints recall from the files', async ({ clone, ollama }) => {
    for (const model of ['qwen3-embedding:0.6b', 'bge-m3']) {
      ollama.answerWithFirstExpected(model, queries, corpus)
    }
    const order = (await loadCorpus(clone)).map((c) => ({
      citation_key: citationKey(c),
      lang: c.lang,
    }))

    const result = await embed(clone, ['--model', 'qwen3-embedding:0.6b', '--model', 'bge-m3'])

    expect(result.code, result.stderr).toBe(0)
    const lines = result.stdout.split('\n').filter((line) => line !== '')
    expect(lines).toHaveLength(2)
    const models = [
      ['qwen3-embedding:0.6b', 'qwen3-embedding-0.6b'],
      ['bge-m3', 'bge-m3'],
    ] as const
    for (const [i, [model, slug]] of models.entries()) {
      const directory = join(clone, 'data', 'embeddings', slug)
      expect((await readdir(directory)).toSorted()).toEqual([
        'chunks.json',
        'chunks.npy',
        'queries.json',
        'queries.npy',
      ])
      expect(await readJson(join(directory, 'chunks.json'))).toEqual(order)
      const recall = await recallReport(directory, queries)
      const scores = Object.entries(recall)
        .map(([name, r]) => `${name} ${r.toFixed(4)}`)
        .join(', ')
      expect(lines[i]!.startsWith(`${model}: recall@5 ${scores}; `)).toBe(true)
      expect(lines[i]!.endsWith(' s')).toBe(true)
      expect(recall.overall).toBeCloseTo(firstHitOnly, 12)
    }
  })

  test('embed prints the recall of the files on disk', async ({ clone, ollama }) => {
    ollama.answerWithFirstExpected('bge-m3', queries, corpus)

    const result = await embed(clone, ['--model', 'bge-m3'], writeThenBury)

    expect(result.code, result.stderr).toBe(0)
    expect(
      result.stdout.startsWith('bge-m3: recall@5 overall 0.0000, en 0.0000, pl 0.0000; '),
    ).toBe(true)
  })

  test('embed exits 1 naming the too long chunk', async ({ clone, ollama }) => {
    const [longChunk] = corpus.filter(
      (c) => citationKey(c) === LONG_CHUNK[0] && c.lang === LONG_CHUNK[1],
    )
    ollama.rejected.add(embeddingText(longChunk!))

    const result = await embed(clone, ['--model', 'bge-m3'])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Embedding with bge-m3 failed: 32016R0679#070.001 (en): ')
    expect(result.stderr).toContain('exceeds the context length')
    expect(await readdir(join(clone, 'data'))).toEqual(['raw'])
  })

  test('embed with Ollama unreachable exits 1 with one line', async ({ clone }) => {
    const restore = useOllamaUrl(`http://127.0.0.1:${await closedPort()}`)
    try {
      const line = singleFailureLine(await embed(clone, ['--model', 'bge-m3']))

      expect(
        line.startsWith(
          'Embedding with bge-m3 failed: bge-m3: AI_APICallError: Cannot connect to API: ',
        ),
      ).toBe(true)
      expect(line).not.toContain('#')
    } finally {
      restore()
    }
  })

  test('embed with a missing model exits 1 with one line', async ({ clone, ollama }) => {
    ollama.modelErrors.set('nope:1', [404, '{"error":"model \'nope:1\' not found"}'])

    const line = singleFailureLine(await embed(clone, ['--model', 'nope:1']))

    expect(line.startsWith('Embedding with nope:1 failed: nope:1: ')).toBe(true)
    expect(line).toContain('not found')
    expect(ollama.bodies).toHaveLength(1)
  })

  test('a model level bad request does not blame a chunk', async ({ clone, ollama }) => {
    ollama.modelErrors.set('chat-only', [400, '{"error":"this model does not support embeddings"}'])

    const line = singleFailureLine(await embed(clone, ['--model', 'chat-only']))

    expect(line.startsWith('Embedding with chat-only failed: chat-only: ')).toBe(true)
    expect(line).toContain('does not support embeddings')
    expect(line).not.toContain('#')
    expect(ollama.bodies).toHaveLength(1)
  })
})

describe('importing makes no network lookup', () => {
  test.for(['src/cli.ts', 'src/retrieval/embeddings.ts'])('%s', (module) => {
    const code = `
      import dns from 'node:dns'
      import net from 'node:net'
      const hosts = []
      const refuse = (host) => { hosts.push(host); throw new Error('network disabled') }
      dns.lookup = refuse
      dns.promises.lookup = async (host) => refuse(host)
      net.Socket.prototype.connect = function (...args) { refuse(JSON.stringify(args[0])) }
      await import(${JSON.stringify(pathToFileURL(join(ROOT, module)).href)})
      console.log(JSON.stringify(hosts))
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8',
      cwd: ROOT,
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim().split('\n').at(-1)).toBe('[]')
  })
})

describe('embedding a query', () => {
  test('embed query is async and pins the context and truncation', async ({ ollamaSettings }) => {
    const vector = await embedQuery('What does Article 14 require?')

    expect(vector).toEqual(fakeVector('What does Article 14 require?'))
    expect(ollamaSettings.bodies).toEqual([
      {
        path: '/api/embed',
        model: EMBEDDING_MODEL,
        input: ['What does Article 14 require?'],
        options: { num_ctx: 4096 },
        truncate: false,
      },
    ])
  })

  test('embed query asks only the configured Ollama', async ({ ollamaSettings }) => {
    const spy = spyOnSockets()
    try {
      await embedQuery('q')
      await sleep(POST_CALL_WAIT_MS)

      expect(ollamaSettings.bodies.map((body) => body.model)).toEqual([EMBEDDING_MODEL])
      expect(spy.peers.ports()).toEqual(new Set([ollamaSettings.port]))
    } finally {
      spy.restore()
    }
  })

  test('embed query awaits without blocking the loop', async ({ ollamaSettings }) => {
    ollamaSettings.delay.push(300)
    let ticks = 0
    const loop = { stop: false }
    const ticker = (async () => {
      while (!loop.stop) {
        ticks += 1
        await sleep(10)
      }
    })()

    const pending = embedQuery('q')
    expect(pending).toBeInstanceOf(Promise)
    await pending
    loop.stop = true
    await ticker

    expect(ticks).toBeGreaterThanOrEqual(10)
  })

  test('embed query reports an unreachable Ollama', async () => {
    const port = await closedPort()
    const restore = useOllamaUrl(`http://127.0.0.1:${port}`)
    const spy = spyOnSockets()
    try {
      const error = await rejection(embedQuery('q'))
      await sleep(POST_CALL_WAIT_MS)

      expect(error).toBeInstanceOf(EmbeddingError)
      expect(
        error.message.startsWith(`${EMBEDDING_MODEL}: AI_APICallError: Cannot connect to API: `),
      ).toBe(true)
      expect(spy.peers.ports()).toEqual(new Set([port]))
    } finally {
      spy.restore()
      restore()
    }
  })

  test('an aborted query embedding rejects with the abort, not an embedding error', async ({
    ollamaSettings,
  }) => {
    ollamaSettings.delay.push(300)
    const controller = new AbortController()
    const pending = embedQuery('q', { abortSignal: controller.signal })
    await sleep(100)

    controller.abort()
    const error = await rejection(pending)

    expect(error).not.toBeInstanceOf(EmbeddingError)
    expect(error.name).toBe('AbortError')
    expect(ollamaSettings.bodies).toHaveLength(1)
    // undici reconnects on a later socket close while the aborted request is unanswered.
    await sleep(POST_CALL_WAIT_MS)
  })

  test('a query embedding slower than the timeout fails', async ({ ollamaSettings }) => {
    ollamaSettings.delay.push(3000)

    const error = await rejection(embedQuery('q', { timeoutMs: 1000 }))

    expect(error).toBeInstanceOf(EmbeddingError)
    expect(error.message).toMatch(/^bge-m3: AI_APICallError: .*Headers Timeout/)
    await sleep(2500)
  })

  test('document embedding asks only the given Ollama', async ({ ollama }) => {
    const model = `never-priced-${crypto.randomUUID()}`
    const spy = spyOnSockets()
    try {
      await embedTexts(model, ['one'], [embeddingText(corpus[0]!)], ollama.url)
      await sleep(POST_CALL_WAIT_MS)

      expect(ollama.bodies.map((body) => body.model)).toEqual([model])
      expect(spy.peers.ports()).toEqual(new Set([ollama.port]))
    } finally {
      spy.restore()
    }
  })
})
