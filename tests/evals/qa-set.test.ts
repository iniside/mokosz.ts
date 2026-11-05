import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ACTS, type Lang } from '../../src/ingest/acts.ts'
import { citationKey, loadCorpus } from '../../src/ingest/chunker.ts'
import { loadItems, type EvalItem } from '../../src/evals/qa.ts'
import { oneLine } from '../../src/text.ts'
import { describe, expect, test } from '../support/harness.ts'
import { NAMES_A_UNIT } from './units.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')
const MIN_WORDS = 6
const MIN_CHARS = 30

const items = await loadItems(ROOT)
const retrieval: { text: string }[] = JSON.parse(
  await readFile(join(ROOT, 'evals', 'retrieval', 'queries.json'), 'utf8'),
)
const textByLang = new Map<Lang, Map<string, string>>([
  ['en', new Map()],
  ['pl', new Map()],
])
for (const chunk of await loadCorpus(ROOT)) {
  textByLang.get(chunk.lang)!.set(citationKey(chunk), chunk.text)
}

/** Why a quote is not valid evidence for its key in a language, or null when it is. */
function quoteProblem(lang: Lang, key: string, quote: string): string | null {
  const text = textByLang.get(lang)!.get(key)
  if (text === undefined) return 'no such chunk'
  if (oneLine(quote) !== quote) return 'not whitespace-normalised'
  if (quote.split(/\s+/).length < MIN_WORDS || quote.length < MIN_CHARS) return 'too short'
  if (!text.includes(quote)) return 'not in the chunk'
  return null
}

const normalise = (text: string): string =>
  oneLine(text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ''))

const retrievalQueries = new Set(retrieval.map((query) => normalise(query.text)))

/** Whether a question is one of the retrieval queries, ignoring case, spacing and punctuation. */
const repeatsRetrieval = (question: string): boolean => retrievalQueries.has(normalise(question))

const counts = (values: unknown[]): Map<unknown, number> => {
  const map = new Map<unknown, number>()
  for (const value of values) map.set(value, (map.get(value) ?? 0) + 1)
  return map
}

const answerable = items.filter((item) => !item.not_found)
const celexOf = (key: string): string => key.slice(0, key.indexOf('#'))
const actsOf = (item: EvalItem): Set<string> => new Set(item.expected.map(celexOf))

describe('the Q&A eval set', () => {
  test('loads through the schema', () => {
    expect(items).toHaveLength(30)
  })

  test('splits fifteen fifteen by language, within 13 to 17 each', () => {
    const perLang = counts(items.map((item) => item.lang))
    expect(perLang).toEqual(
      new Map([
        ['en', 15],
        ['pl', 15],
      ]),
    )
    for (const n of perLang.values()) expect(n >= 13 && n <= 17).toBe(true)
  })

  test('has five unanswerable items, two EN and three PL', () => {
    const unanswerable = items.filter((item) => item.not_found)
    expect(unanswerable.length >= 4 && unanswerable.length <= 6).toBe(true)
    expect(counts(unanswerable.map((item) => item.lang))).toEqual(
      new Map([
        ['en', 2],
        ['pl', 3],
      ]),
    )
    for (const item of unanswerable) {
      expect(item.expected, item.id).toEqual([])
      expect(item.evidence, item.id).toEqual([])
    }
  })

  test('covers all three acts among the expected keys', () => {
    const perAct = counts(answerable.flatMap((item) => [...actsOf(item)]))
    expect(perAct).toEqual(
      new Map([
        ['32016R0679', 10],
        ['32024R1689', 8],
        ['32022L2555', 7],
      ]),
    )
    expect(new Set(perAct.keys())).toEqual(new Set(ACTS.map(([celex]) => celex)))
  })

  test('ids carry the item language and keys are not repeated within an item', () => {
    for (const item of items) {
      expect(item.id.startsWith(`${item.lang}-`), item.id).toBe(true)
      expect(new Set(item.expected).size, item.id).toBe(item.expected.length)
      const pairs = item.evidence.map((entry) => `${entry.key}\u0000${entry.quote}`)
      expect(new Set(pairs).size, item.id).toBe(pairs.length)
    }
  })

  test('every expected key exists in the corpus in the item language', () => {
    const missing = items.flatMap((item) =>
      item.expected
        .filter((key) => !textByLang.get(item.lang)!.has(key))
        .map((key) => `${item.id} ${key}`),
    )
    expect(missing).toEqual([])
    expect(answerable.reduce((n, item) => n + item.expected.length, 0)).toBe(56)
  })

  test('every quote is normalised, long enough and in its chunk text', () => {
    const problems = items.flatMap((item) =>
      item.evidence
        .map((entry) => [entry.key, quoteProblem(item.lang, entry.key, entry.quote)] as const)
        .filter(([, problem]) => problem !== null)
        .map(([key, problem]) => `${item.id} ${key}: ${problem}`),
    )
    expect(problems).toEqual([])
    expect(items.reduce((n, item) => n + item.evidence.length, 0)).toBe(61)
  })

  test('no question names an article, recital or annex by number', () => {
    expect(items.filter((item) => NAMES_A_UNIT.test(item.question)).map((item) => item.id)).toEqual(
      [],
    )
  })

  test('no question repeats a retrieval query', () => {
    expect(retrieval).toHaveLength(20)
    expect(retrievalQueries.size).toBe(20)
    expect(items.filter((item) => repeatsRetrieval(item.question)).map((item) => item.id)).toEqual(
      [],
    )
  })

  test('the repeat check catches a retrieval query with changed case, spacing or punctuation', () => {
    const query = retrieval[0]!.text
    expect(query.endsWith('?')).toBe(true)
    expect(query).toContain('company')
    expect(repeatsRetrieval(query.slice(0, -1))).toBe(true)
    expect(repeatsRetrieval(`  ${query.toUpperCase().replaceAll(' ', '   ')}`)).toBe(true)
    expect(repeatsRetrieval(query.replace('company', 'firm'))).toBe(false)
  })

  test('questions are unique', () => {
    expect(new Set(items.map((item) => normalise(item.question))).size).toBe(items.length)
  })
})

describe('the quote check', () => {
  const key = '32016R0679#007.003'
  const sentence = 'It shall be as easy to withdraw as to give consent.'

  test('accepts a quote copied from the chunk', () => {
    expect(quoteProblem('en', key, sentence)).toBeNull()
  })

  test('rejects a quote that is not in its chunk', () => {
    expect(quoteProblem('en', key, 'It shall be as hard to withdraw as to give consent.')).toBe(
      'not in the chunk',
    )
  })

  test('rejects a real quote attributed to another chunk', () => {
    expect(quoteProblem('en', '32016R0679#007.002', sentence)).toBe('not in the chunk')
  })

  test('rejects a quote from the other language version', () => {
    expect(quoteProblem('pl', key, sentence)).toBe('not in the chunk')
  })

  test.for([
    ['five words', 'as easy to withdraw as'],
    ['six words under thirty characters', 'It shall be as easy to'],
  ])('rejects a quote that is too short: %s', ([, quote]) => {
    expect(textByLang.get('en')!.get(key)!.includes(quote!)).toBe(true)
    expect(quoteProblem('en', key, quote!)).toBe('too short')
  })

  test('rejects a quote that is not whitespace-normalised', () => {
    expect(quoteProblem('en', key, 'It shall be as easy  to withdraw as to give consent.')).toBe(
      'not whitespace-normalised',
    )
    expect(quoteProblem('en', key, ` ${sentence}`)).toBe('not whitespace-normalised')
  })

  test('rejects a key that is not in the corpus', () => {
    expect(quoteProblem('en', '32016R0679#999.001', sentence)).toBe('no such chunk')
  })
})
