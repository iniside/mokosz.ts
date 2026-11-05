import { join, resolve } from 'node:path'
import { vi } from 'vitest'
import { main } from '../../src/cli.ts'
import { writeEmbeddings } from '../../src/retrieval/embeddings.ts'
import { getSettings } from '../../src/settings.ts'
import { describe, expect, test } from '../support/harness.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')
const COMMITTED = join(ROOT, 'data', 'embeddings', 'bge-m3')

vi.mock('../../src/retrieval/embeddings.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/retrieval/embeddings.ts')>()),
  writeEmbeddings: vi.fn(async (directory: string) => ({ directory, seconds: 1.26 })),
}))

describe('mokosz embed with the default commands', () => {
  test('embeds the corpus of the git toplevel into data/embeddings/<model> and prints its recall', async () => {
    let stdout = ''
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk)
      return true
    })
    let code: number
    try {
      code = await main(['embed'])
    } finally {
      out.mockRestore()
    }

    expect(code).toBe(0)
    const calls = vi.mocked(writeEmbeddings).mock.calls
    expect(calls).toHaveLength(1)
    const [directory, model, corpus, queries, baseUrl] = calls[0]!
    expect(resolve(directory)).toBe(COMMITTED)
    expect(model).toBe('bge-m3')
    expect(corpus).toHaveLength(3974)
    expect(queries).toHaveLength(20)
    expect(baseUrl).toBe(getSettings().ollamaBaseUrl)
    expect(stdout).toBe('bge-m3: recall@5 overall 0.8250, en 0.8500, pl 0.8000; 1.3 s\n')
  })
})
