export const EMBEDDING_MODEL = 'bge-m3'
export const EMBEDDING_DIM = 1024

export interface Matrix {
  rows: number
  cols: number
  data: ArrayLike<number>
}

export interface ChunkMeta {
  citation_key: string
  lang: string
}

export interface QueryMeta {
  id: string
  lang: string
}

export function unitRows(matrix: Matrix): Float64Array[] {
  const rows: Float64Array[] = []
  for (let r = 0; r < matrix.rows; r++) {
    const row = Float64Array.from(
      { length: matrix.cols },
      (_, c) => matrix.data[r * matrix.cols + c]!,
    )
    let squares = 0
    for (const value of row) squares += value * value
    const norm = Math.sqrt(squares)
    if (norm === 0) throw new Error('an embedding row has zero norm')
    rows.push(row.map((value) => value / norm))
  }
  return rows
}

function dot(a: Float64Array, b: Float64Array): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!
  return sum
}

// Descending, ties in row order, NaN last.
function descending(a: number, b: number): number {
  if (Number.isNaN(a)) return Number.isNaN(b) ? 0 : 1
  if (Number.isNaN(b)) return -1
  return b - a
}

export interface Ranked {
  row: number
  score: number
}

/** The chunks of one language by cosine to a unit query vector, as recallAtK ranks them. */
export function rankChunks(
  chunkVectors: readonly Float64Array[],
  chunkMeta: readonly ChunkMeta[],
  vector: Float64Array,
  lang: string,
): Ranked[] {
  const scored: Ranked[] = []
  chunkMeta.forEach((chunk, row) => {
    if (chunk.lang === lang) scored.push({ row, score: dot(chunkVectors[row]!, vector) })
  })
  return scored.toSorted((a, b) => descending(a.score, b.score))
}

export function recallAtK(
  chunks: Matrix,
  chunkMeta: readonly ChunkMeta[],
  queries: Matrix,
  queryMeta: readonly QueryMeta[],
  expected: Readonly<Record<string, readonly string[]>>,
  k: number,
): number {
  if (chunks.rows !== chunkMeta.length || queries.rows !== queryMeta.length) {
    throw new Error('embedding rows and metadata rows differ in number')
  }
  if (queryMeta.length === 0) throw new Error('no queries to score')
  const chunkVectors = unitRows(chunks)
  const queryVectors = unitRows(queries)

  let total = 0
  queryVectors.forEach((vector, q) => {
    const meta = queryMeta[q]!
    if (!Object.hasOwn(expected, meta.id))
      throw new Error(`query ${meta.id} is not in the eval set`)
    const wanted = new Set(expected[meta.id])
    if (wanted.size === 0) throw new Error(`query ${meta.id} has no expected keys`)
    const top = rankChunks(chunkVectors, chunkMeta, vector, meta.lang).slice(0, k)
    const found = new Set(top.map(({ row }) => chunkMeta[row]!.citation_key))
    const hits = [...wanted].filter((key) => found.has(key)).length
    total += hits / wanted.size
  })
  return total / queryMeta.length
}
