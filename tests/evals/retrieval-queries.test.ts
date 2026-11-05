import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ACTS } from '../../src/ingest/acts.ts'
import { citationKey, loadCorpus } from '../../src/ingest/chunker.ts'
import { describe, expect, test } from '../support/harness.ts'
import { NAMES_A_UNIT } from './units.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')
const QUERIES = join(ROOT, 'evals', 'retrieval', 'queries.json')
const CELEX_BY_ACT = new Map<string, string>(ACTS.map(([celex, act]) => [act, celex]))
const FIELDS = ['act', 'expected', 'id', 'lang', 'text']

interface Item {
  id: string
  lang: string
  act: string
  text: string
  expected: string[]
}

const queries: Item[] = JSON.parse(await readFile(QUERIES, 'utf8'))
const keysByLang = new Map<string, Set<string>>([
  ['en', new Set()],
  ['pl', new Set()],
])
for (const chunk of await loadCorpus(ROOT)) keysByLang.get(chunk.lang)!.add(citationKey(chunk))

const counts = (values: unknown[]): Map<unknown, number> => {
  const map = new Map<unknown, number>()
  for (const value of values) map.set(value, (map.get(value) ?? 0) + 1)
  return map
}

describe('the retrieval eval queries', () => {
  test('items have the contract schema', () => {
    expect(queries).toHaveLength(20)
    for (const item of queries) {
      expect(Object.keys(item).toSorted(), JSON.stringify(item)).toEqual(FIELDS)
      expect(typeof item.id === 'string' && item.id !== '').toBe(true)
      expect(['en', 'pl']).toContain(item.lang)
      expect(CELEX_BY_ACT.has(item.act)).toBe(true)
      expect(typeof item.text === 'string' && item.text.trim() !== '').toBe(true)
      const expected = item.expected
      expect(Array.isArray(expected), item.id).toBe(true)
      const keys = item.expected
      expect(keys.length >= 1 && keys.length <= 3, item.id).toBe(true)
      expect(keys.every((key) => typeof key === 'string')).toBe(true)
      expect(new Set(keys).size, item.id).toBe(keys.length)
    }
  })

  test('ids are unique', () => {
    const ids = counts(queries.map((item) => item.id))
    expect([...ids].filter(([, n]) => n > 1).map(([id]) => id)).toEqual([])
  })

  test('languages split ten ten', () => {
    expect(counts(queries.map((item) => item.lang))).toEqual(
      new Map([
        ['en', 10],
        ['pl', 10],
      ]),
    )
  })

  test('every act has at least five queries', () => {
    const perAct = counts(queries.map((item) => item.act))
    expect(
      Object.fromEntries([...CELEX_BY_ACT.keys()].map((act) => [act, (perAct.get(act) ?? 0) >= 5])),
    ).toEqual(Object.fromEntries([...CELEX_BY_ACT.keys()].map((act) => [act, true])))
  })

  test('expected keys belong to the query act', () => {
    for (const item of queries) {
      const celex = CELEX_BY_ACT.get(item.act)!
      for (const key of item.expected) {
        expect(key.startsWith(`${celex}#`), `${item.id} ${key}`).toBe(true)
      }
    }
  })

  test('expected keys exist in the corpus language', () => {
    const missing = queries.flatMap((item) =>
      item.expected
        .filter((key) => !keysByLang.get(item.lang)!.has(key))
        .map((key) => [item.id, key]),
    )
    expect(missing).toEqual([])
  })

  test('no query names a unit by number', () => {
    const offending = queries.filter((item) => NAMES_A_UNIT.test(item.text)).map((item) => item.id)
    expect(offending).toEqual([])
  })

  test.for([
    'What does Article 33 say?',
    'see art. 6',
    'Art.17 erasure',
    'Co mówi artykuł 5?',
    'zgodnie z artykułem 83',
    'recital 85',
    'motywie 44',
    'Annex III list',
    'załącznika I',
    'recitals 85 and 87',
    'annexes I and III',
    'Article (5)',
    'Articles 12 to 22',
    'Art. V',
    'Artykuł 5',
    'w artykule 33',
    'artykułu 5',
    'Arts. 15 to 22',
  ])('the unit number guard catches %j', (text) => {
    expect(NAMES_A_UNIT.test(text)).toBe(true)
  })

  test.for([
    'artificial intelligence',
    'articles of association',
    'motywacji pracowników',
    'motywie pracowników',
    'załączniki do umowy',
    'art i kultura',
    'załącznik i formularz',
    'the annex lists',
    'NIS2 directive',
  ])('the unit number guard ignores %j', (text) => {
    expect(NAMES_A_UNIT.test(text)).toBe(false)
  })

  test('the guard matches word boundaries after a non-ASCII letter', () => {
    expect(NAMES_A_UNIT.test('załącznikI')).toBe(false)
    expect(NAMES_A_UNIT.test('artykuł 5')).toBe(true)
    expect(NAMES_A_UNIT.test('xartykuł 5')).toBe(false)
  })
})
