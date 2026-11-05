import { join } from 'node:path'
import { Client } from 'pg'
import { CommandError } from '../command.ts'
import { EMBEDDING_MODEL } from '../retrieval/index.ts'
import {
  EmbeddingError,
  RECALL_K,
  embeddingsDir,
  loadQueries,
  recallReport,
  writeEmbeddings,
} from '../retrieval/embeddings.ts'
import { loadCorpus } from './chunker.ts'
import { FetchError, fetchActs, type FetchOptions } from './fetch.ts'
import { SeedError, seedChunks } from './seed.ts'

const say = (message: string): void => {
  process.stdout.write(`${message}\n`)
}

export async function fetchCommand(
  root: string,
  force: boolean,
  options: FetchOptions = {},
): Promise<void> {
  try {
    await fetchActs(join(root, 'data', 'raw'), { ...options, force, report: say })
  } catch (error) {
    if (error instanceof FetchError) throw new CommandError(`Fetch failed: ${error.message}`)
    throw error
  }
}

export async function embedCommand(
  root: string,
  ollamaBaseUrl: string,
  models: string[],
  write: typeof writeEmbeddings = writeEmbeddings,
): Promise<void> {
  const corpus = await loadCorpus(root)
  const queries = await loadQueries(root)
  for (const model of models.length > 0 ? models : [EMBEDDING_MODEL]) {
    let run
    try {
      run = await write(embeddingsDir(root, model), model, corpus, queries, ollamaBaseUrl)
    } catch (error) {
      if (error instanceof EmbeddingError) {
        throw new CommandError(`Embedding with ${model} failed: ${error.message}`)
      }
      throw error
    }
    const recall = await recallReport(run.directory, queries)
    const scores = Object.entries(recall)
      .map(([name, value]) => `${name} ${value.toFixed(4)}`)
      .join(', ')
    say(`${model}: recall@${RECALL_K} ${scores}; ${run.seconds.toFixed(1)} s`)
  }
}

export async function seedDatabase(
  databaseUrl: string,
  root: string,
  seed: typeof seedChunks = seedChunks,
): Promise<number> {
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    return await seed(client, root)
  } finally {
    await client.end()
  }
}

export async function seedCommand(
  root: string,
  databaseUrl: string,
  seed: typeof seedDatabase = seedDatabase,
): Promise<void> {
  let count: number
  try {
    count = await seed(databaseUrl, root)
  } catch (error) {
    if (error instanceof SeedError) throw new CommandError(`Seeding failed: ${error.message}`)
    throw error
  }
  say(`Seed: ${count} chunks`)
}
