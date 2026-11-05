import { Client } from 'pg'
import { z } from 'zod'

export const AI_14_1 = '32024R1689#014.001'

/** asyncio.Event for the tests: set once, awaited any number of times. */
export class Flag {
  readonly #flag = Promise.withResolvers<void>()
  isSet = false

  set(): void {
    this.isSet = true
    this.#flag.resolve()
  }

  wait(): Promise<void> {
    return this.#flag.promise
  }
}

/**
 * Returns one seeded chunk's embedding; can hold the retriever
 * or make it fail. A held call ends when the run's signal aborts.
 */
export class GatedEmbedder {
  readonly vector: number[]
  gated = false
  error: Error | null = null
  readonly entered = new Flag()
  readonly release = new Flag()
  readonly queries: string[] = []

  constructor(vector: number[]) {
    this.vector = vector
  }

  readonly embed = async (
    text: string,
    options?: { abortSignal?: AbortSignal },
  ): Promise<number[]> => {
    this.queries.push(text)
    this.entered.set()
    if (this.gated) {
      const signal = options?.abortSignal
      signal?.throwIfAborted()
      const aborted = Promise.withResolvers<never>()
      const onAbort = (): void => aborted.reject(signal?.reason)
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        await Promise.race([this.release.wait(), aborted.promise])
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
    }
    if (this.error !== null) throw this.error
    return this.vector
  }
}

/** The gated_embedder fixture's vector: AI_14_1's English embedding from the seeded table. */
export async function ai14Vector(databaseUrl: string): Promise<number[]> {
  const [celex, elementId] = AI_14_1.split('#')
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    const { rows } = await client.query<{ embedding: string }>(
      "SELECT embedding::text FROM chunks WHERE celex = $1 AND element_id = $2 AND lang = 'en'",
      [celex, elementId],
    )
    if (rows.length !== 1) throw new Error(`${AI_14_1} (en) is not seeded`)
    return z.array(z.number()).parse(JSON.parse(rows[0]!.embedding))
  } finally {
    await client.end()
  }
}
