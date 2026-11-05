import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EvalSetError, itemsPath, loadItems, parseItems } from '../../src/evals/qa.ts'
import { describe, expect, test as base } from '../support/harness.ts'

const A = '32016R0679#033.001'
const B = '32016R0679#033.002'
const QUOTE = 'the controller shall without undue delay and, where feasible'

const answerable = {
  id: 'qa-en-01',
  lang: 'en',
  question: 'How fast must a breach be reported?',
  expected: [A, B],
  evidence: [
    { key: A, quote: QUOTE },
    { key: B, quote: QUOTE },
  ],
  reference: 'Within 72 hours.',
  not_found: false,
}

const unanswerable = {
  id: 'qa-en-02',
  lang: 'en',
  question: 'What is the VAT rate in Poland?',
  expected: [],
  evidence: [],
  reference: 'The three acts do not say.',
  not_found: true,
}

const test = base.extend('root', async ({}, { onCleanup }): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'mokosz-qa-'))
  onCleanup(() => rm(root, { recursive: true, force: true }))
  return root
})

function rejected(items: unknown): string {
  try {
    parseItems(items)
  } catch (error) {
    if (error instanceof EvalSetError) return error.message
    throw error
  }
  throw new Error('the set was accepted')
}

describe('the Q&A eval item schema', () => {
  test('an answerable and an unanswerable item are accepted', () => {
    expect(parseItems([answerable, unanswerable])).toEqual([answerable, unanswerable])
  })

  test.for([
    [
      'a not_found item with expected keys',
      [{ ...unanswerable, expected: [A], evidence: [{ key: A, quote: QUOTE }] }],
      '0: a not_found item must have no expected keys',
    ],
    [
      'an answerable item with no expected keys',
      [{ ...answerable, expected: [], evidence: [] }],
      '0: an answerable item needs expected keys',
    ],
    [
      'an expected key without evidence',
      [{ ...answerable, evidence: [{ key: A, quote: QUOTE }] }],
      `0: expected key ${B} has no evidence`,
    ],
    [
      'an evidence key that is not expected',
      [
        {
          ...answerable,
          expected: [A],
          evidence: [
            { key: A, quote: QUOTE },
            { key: B, quote: QUOTE },
          ],
        },
      ],
      `0: evidence key ${B} is not expected`,
    ],
    ['an unknown field', [{ ...answerable, act: 'GDPR' }], 'Unrecognized key: "act"'],
    [
      'an unknown evidence field',
      [
        {
          ...answerable,
          evidence: [
            { key: A, quote: QUOTE, page: 1 },
            { key: B, quote: QUOTE },
          ],
        },
      ],
      'Unrecognized key: "page"',
    ],
    [
      'a duplicate id',
      [answerable, { ...unanswerable, id: answerable.id }],
      'duplicate id qa-en-01',
    ],
    ['a missing field', [{ ...answerable, reference: undefined }], '0.reference'],
    ['an unknown language', [{ ...answerable, lang: 'de' }], '0.lang'],
    ['an empty question', [{ ...answerable, question: '' }], '0.question'],
  ] as const)('%s is rejected', ([, items, message]) => {
    expect(rejected(items)).toContain(message)
  })
})

describe('loading the Q&A eval set', () => {
  test('items load from evals/qa/items.json under the root', async ({ root }) => {
    await mkdir(join(root, 'evals', 'qa'), { recursive: true })
    await writeFile(itemsPath(root), JSON.stringify([answerable]), 'utf8')

    expect(itemsPath(root)).toBe(join(root, 'evals', 'qa', 'items.json'))
    expect(await loadItems(root)).toEqual([answerable])
  })

  test('a missing file is an eval set error', async ({ root }) => {
    await expect(loadItems(root)).rejects.toThrow(
      new EvalSetError(`${itemsPath(root)} does not exist`),
    )
  })

  test('a file that is not JSON is an eval set error', async ({ root }) => {
    await mkdir(join(root, 'evals', 'qa'), { recursive: true })
    await writeFile(itemsPath(root), '[{', 'utf8')

    await expect(loadItems(root)).rejects.toThrow(EvalSetError)
    await expect(loadItems(root)).rejects.toThrow(`${itemsPath(root)}: `)
  })

  test('an invalid set names the file and the issue', async ({ root }) => {
    await mkdir(join(root, 'evals', 'qa'), { recursive: true })
    await writeFile(itemsPath(root), JSON.stringify([answerable, answerable]), 'utf8')

    await expect(loadItems(root)).rejects.toThrow(
      new EvalSetError(`${itemsPath(root)}: duplicate id qa-en-01`),
    )
  })
})
