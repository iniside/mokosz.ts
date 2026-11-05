import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { loadQueries, recallReport } from '../../src/retrieval/embeddings.ts'
import {
  EMBEDDING_DIM,
  rankChunks,
  recallAtK,
  unitRows,
  type ChunkMeta,
  type Matrix,
  type QueryMeta,
} from '../../src/retrieval/index.ts'
import { float16Rows, npyBytes, parseNpy } from '../../src/retrieval/npy.ts'
import { describe, expect, test } from '../support/harness.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')
const DIRECTORY = join(ROOT, 'data', 'embeddings', 'bge-m3')

// The committed embeddings and the eval queries they were computed for.
const COMMITTED: Record<string, string> = {
  'data/embeddings/bge-m3/chunks.json':
    'b2fa2c1475b0eafb6fdbeb62a6a6bbae9efc820ec606307a8094dd6c6c22b94c',
  'data/embeddings/bge-m3/chunks.npy':
    '761c6d9de0bb548516eaa5fa0b287b4fc5076b375d256105895b21fab050d182',
  'data/embeddings/bge-m3/queries.json':
    '4270eb9d5cd15ea17ba5650ada9d2e56e529e72d0d2ed8384f8d29265c78f827',
  'data/embeddings/bge-m3/queries.npy':
    '97daac97b066b3ed9bbfd18077002a7c890a4c212c40c9bcc7b11e27583d1808',
  'evals/retrieval/queries.json':
    '729f17149036b54ff7ce61fa7669e0b0ec22a09716364fa44ba509db65eebccc',
}

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')
const bitsOf = (data: Float16Array): number[] => [...new Uint16Array(data.buffer)]
const fromBits = (bits: number[]): Float16Array => new Float16Array(Uint16Array.from(bits).buffer)

async function committed(name: string): Promise<Matrix> {
  const { shape, data } = parseNpy(await readFile(join(DIRECTORY, name)))
  return { rows: shape[0]!, cols: shape[1]!, data }
}

async function meta<T>(name: string): Promise<T[]> {
  return JSON.parse(await readFile(join(DIRECTORY, name), 'utf8'))
}

// The .npy format: magic, version, header length, a dict padded with spaces and ended by a newline
// so that the data starts on a 64-byte boundary.
const DICT_2_3 = "{'descr': '<f2', 'fortran_order': False, 'shape': (2, 3), }"
const DATA_2_3 = [0x3c00, 0x4000, 0x4200, 0xbc00, 0x3800, 0x0000]
const VALUES_2_3 = [1, 2, 3, -1, 0.5, 0]

function handBuilt(major: 1 | 2, dict: string, bits: number[]): Buffer {
  const lengthBytes = major === 1 ? 2 : 4
  const headerLength = 128 - 8 - lengthBytes
  const length = Buffer.alloc(lengthBytes)
  if (major === 1) length.writeUInt16LE(headerLength)
  else length.writeUInt32LE(headerLength)
  return Buffer.concat([
    Buffer.from([0x93, ...Buffer.from('NUMPY'), major, 0]),
    length,
    Buffer.from(`${dict.padEnd(headerLength - 1, ' ')}\n`, 'latin1'),
    Buffer.from(Uint16Array.from(bits).buffer),
  ])
}

describe('float16 storage', () => {
  test.each([
    [1, 0x3c00],
    [-2, 0xc000],
    [0.5, 0x3800],
    [0.1, 0x2e66],
    [1 / 3, 0x3555],
    [65504, 0x7bff],
    [65520, 0x7c00],
    [2 ** -24, 0x0001],
    [-0, 0x8000],
  ])('%d is stored as float16 bits %i', (value, bits) => {
    expect(bitsOf(float16Rows([Float32Array.from([value])]).data)).toEqual([bits])
  })

  test('a float half way between float16 values after float32 rounding rounds to even', () => {
    const { data } = float16Rows([Float32Array.from([1 + 2 ** -11 + 2 ** -40])])

    expect(data[0]).toBe(1)
  })

  test('rows of different length are refused', () => {
    expect(() => float16Rows([Float32Array.from([1, 2]), Float32Array.from([1])])).toThrow(
      'rows differ in length',
    )
  })
})

describe('.npy files', () => {
  test('a hand-built version 1.0 file of shape (2, 3)', () => {
    const bytes = handBuilt(1, DICT_2_3, DATA_2_3)

    expect(npyBytes({ shape: [2, 3], data: Float16Array.from(VALUES_2_3) })).toEqual(bytes)
    const array = parseNpy(bytes)
    expect(array.shape).toEqual([2, 3])
    expect([...array.data]).toEqual(VALUES_2_3)
  })

  test('a hand-built version 1.0 file of 1-D shape (3,)', () => {
    const dict = "{'descr': '<f2', 'fortran_order': False, 'shape': (3,), }"
    const bytes = handBuilt(1, dict, [0x3c00, 0xbc00, 0x3400])

    const written = npyBytes({ shape: [3], data: Float16Array.from([1, -1, 0.25]) })

    expect(written).toEqual(bytes)
    expect(written.toString('latin1')).toContain("'shape': (3,)")
  })

  test('a hand-built version 2.0 file reads the same', () => {
    const array = parseNpy(handBuilt(2, DICT_2_3, DATA_2_3))

    expect(array.shape).toEqual([2, 3])
    expect([...array.data]).toEqual(VALUES_2_3)
  })

  test.for([
    [[0], []],
    [[3], [1, -1, 0.25]],
    [[2, 3], VALUES_2_3],
    [[1, EMBEDDING_DIM], Array.from({ length: EMBEDDING_DIM }, (_, i) => (i % 7) - 3)],
    [[4, 0], []],
  ] as [number[], number[]][])('shape %j writes and reads back', ([shape, values]) => {
    const bytes = npyBytes({ shape, data: Float16Array.from(values) })

    expect(bytes.length % 64).toBe((values.length * 2) % 64)
    const array = parseNpy(bytes)
    expect(array.shape).toEqual(shape)
    expect([...array.data]).toEqual(values)
  })

  test.for(['chunks.npy', 'queries.npy'])(
    'the committed %s reads and writes back byte for byte',
    async (name) => {
      const bytes = await readFile(join(DIRECTORY, name))

      const array = parseNpy(bytes)

      expect(array.shape[1]).toBe(EMBEDDING_DIM)
      expect(npyBytes(array).equals(bytes)).toBe(true)
    },
  )

  test('a file shorter than its shape is refused', () => {
    const bytes = handBuilt(1, DICT_2_3, DATA_2_3)

    expect(() => parseNpy(bytes.subarray(0, bytes.length - 1))).toThrow('fewer than the 6 values')
  })

  test('a float32 file is refused', () => {
    const bytes = handBuilt(1, DICT_2_3.replace("'<f2'", "'<f4'"), DATA_2_3)

    expect(() => parseNpy(bytes)).toThrow('only C-order <f2 arrays')
  })

  test('a Fortran-order file is refused', () => {
    const bytes = handBuilt(1, DICT_2_3.replace('False', 'True'), DATA_2_3)

    expect(() => parseNpy(bytes)).toThrow('fortran_order=True')
  })

  test('a file without the magic string is refused', () => {
    expect(() => parseNpy(Buffer.from('not an array'))).toThrow('magic string is not correct')
  })
})

describe('ranking and recall', () => {
  test('the committed files are unchanged', async () => {
    expect((await readdir(DIRECTORY)).toSorted()).toEqual([
      'chunks.json',
      'chunks.npy',
      'queries.json',
      'queries.npy',
    ])
    for (const [path, hash] of Object.entries(COMMITTED)) {
      expect(sha256(await readFile(join(ROOT, path))), path).toBe(hash)
    }
  })

  test.each([
    [
      [3, 4],
      [0.6, 0.8],
    ],
    [
      [0, 0, 2],
      [0, 0, 1],
    ],
    [
      [-1, 0, 0],
      [-1, 0, 0],
    ],
  ])('unit row of %j is %j', (row, unit) => {
    const [only] = unitRows({ rows: 1, cols: row.length, data: row })

    unit.forEach((value, c) => expect(only![c]).toBeCloseTo(value, 15))
  })

  test('a zero row is refused', () => {
    expect(() => unitRows({ rows: 2, cols: 2, data: [1, 0, 0, 0] })).toThrow(
      'an embedding row has zero norm',
    )
  })

  test('rows rank by descending cosine, ties in row order, NaN scores last in row order', () => {
    const data = fromBits([
      0x0000,
      0x3c00, // [0, 1]: cosine 0
      0x7c00,
      0x0000, // [inf, 0]: NaN
      0x3c00,
      0x0000, // [1, 0]: cosine 1
      0x3c00,
      0x3c00, // [1, 1]: cosine 0.707
      0x0000,
      0x7c00, // [0, inf]: NaN
      0x3c00,
      0x3c00, // [1, 1]: cosine 0.707
    ])
    const chunks = unitRows({ rows: 6, cols: 2, data })
    const keys = chunks.map((_, i) => ({ citation_key: `k${i}`, lang: 'en' }))

    const ranked = rankChunks(chunks, keys, Float64Array.from([1, 0]), 'en')

    expect(ranked.map((r) => r.row)).toEqual([2, 3, 5, 0, 1, 4])
    expect(ranked.map((r) => Number.isNaN(r.score))).toEqual([
      false,
      false,
      false,
      false,
      true,
      true,
    ])
  })

  test('only chunks of the query language are ranked', () => {
    const chunks = unitRows({ rows: 3, cols: 2, data: [1, 0, 1, 0, 0, 1] })
    const keys = [
      { citation_key: 'a', lang: 'en' },
      { citation_key: 'a', lang: 'pl' },
      { citation_key: 'b', lang: 'pl' },
    ]

    const ranked = rankChunks(chunks, keys, Float64Array.from([1, 0]), 'pl')

    expect(ranked.map((r) => r.row)).toEqual([1, 2])
  })

  test.each([
    [{}, 'query q is not in the eval set'],
    [{ q: [] }, 'query q has no expected keys'],
  ])('recall refuses a query without expected keys: %j', (expected, message) => {
    const chunks = { rows: 1, cols: 1, data: [1] }
    const meta1 = [{ citation_key: 'a', lang: 'en' }]
    const queries = { rows: 1, cols: 1, data: [1] }

    expect(() => recallAtK(chunks, meta1, queries, [{ id: 'q', lang: 'en' }], expected, 1)).toThrow(
      message,
    )
  })

  test('recall over the whole language of the committed files is 1', async () => {
    const queries = await loadQueries(ROOT)
    const chunkMeta = await meta<ChunkMeta>('chunks.json')
    const expected = Object.fromEntries(queries.map((query) => [query.id, query.expected]))

    const score = recallAtK(
      await committed('chunks.npy'),
      chunkMeta,
      await committed('queries.npy'),
      await meta<QueryMeta>('queries.json'),
      expected,
      chunkMeta.length,
    )

    expect(score).toBe(1)
  })

  test('recall@5 of the committed files is 33/40: EN 17/20, PL 16/20 (decision 0007)', async () => {
    const report = await recallReport(DIRECTORY, await loadQueries(ROOT))

    expect(report.overall).toBeCloseTo(33 / 40, 12)
    expect(report.en).toBeCloseTo(17 / 20, 12)
    expect(report.pl).toBeCloseTo(16 / 20, 12)
  })
})
