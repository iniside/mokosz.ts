import { resolve } from 'node:path'
import { citationKey, loadCorpus } from '../../src/ingest/chunker.ts'
import { z } from 'zod'
import { describe, expect, test as harnessTest } from '../support/harness.ts'
import { jsonOf, serve, type Served } from './streaming.ts'

const Text = z.object({ text: z.string(), heading: z.string().nullable() })

const ROOT = resolve(import.meta.dirname, '..', '..')
const CHUNKS = new Map(
  (await loadCorpus(ROOT)).map((chunk) => [`${citationKey(chunk)} ${chunk.lang}`, chunk]),
)
const AI_14_1 = '32024R1689#014.001'
const GDPR_50_A = '32016R0679#art_50.pt_1'

const test = harnessTest.extend(
  'servedApi',
  async ({ seededDatabaseUrl: _, unreachableOllama: __, testSettings }, { onCleanup }) => {
    const served: Served = await serve(testSettings)
    onCleanup(() => served.close())
    return served
  },
)

describe('citation endpoint', () => {
  test.for([
    [AI_14_1, 'en', 'AI Act Art. 14(1)', 14],
    [AI_14_1, 'pl', 'AI Act art. 14 ust. 1', 14],
    [GDPR_50_A, 'pl', 'GDPR art. 50 lit. a', 50],
  ] as const)(
    'a citation returns its text, heading and label (%s %s)',
    async ([key, lang, label, article], { servedApi: { client } }) => {
      const path = key.replace('#', '/')
      const source = CHUNKS.get(`${key} ${lang}`)!

      const response = await client.get(
        `/api/citations/${path}?${new URLSearchParams({ lang }).toString()}`,
      )

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        citation_key: key,
        lang,
        act: source.act,
        article,
        heading: source.heading,
        label,
        text: source.text,
      })
    },
  )

  test('the EN and PL texts differ', async ({ servedApi: { client } }) => {
    const url = '/api/citations/32024R1689/014.001'

    const en = await jsonOf(await client.get(`${url}?lang=en`), Text)
    const pl = await jsonOf(await client.get(`${url}?lang=pl`), Text)

    expect(en.text.startsWith('1. High-risk AI systems')).toBe(true)
    expect(en.heading).toBe('Human oversight')
    expect(pl.text !== en.text && pl.heading !== en.heading).toBe(true)
  })

  test.for([
    '/api/citations/32024R1689/999.001?lang=en',
    '/api/citations/39999R0001/014.001?lang=en',
  ])('an unknown citation is 404 (%s)', async (url, { servedApi: { client } }) => {
    expect((await client.get(url)).status).toBe(404)
  })

  test.for(['/api/citations/32024R1689/014.001', '/api/citations/32024R1689/014.001?lang=de'])(
    'a missing or unknown lang is 422 (%s)',
    async (url, { servedApi: { client } }) => {
      expect((await client.get(url)).status).toBe(422)
    },
  )
})
