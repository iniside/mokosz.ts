import { describe, expect, test } from 'vitest'
import type { Answer, Claim } from '../../src/mastra/workflows/state.ts'
import { NOT_FOUND, reply, verify } from '../../src/mastra/workflows/qa.ts'

const K1 = '32024R1689#014.001'
const K2 = '32024R1689#014.002'
const K9 = '32024R1689#099.009'

function answer(notFound: boolean, ...claims: string[][]): Answer {
  const items: Claim[] = claims.map((citations, i) => ({ text: `claim ${i}`, citations }))
  return { lang: 'en', not_found: notFound, claims: items }
}

function said(lang: Answer['lang'], notFound: boolean, ...texts: string[]): Answer {
  return { lang, not_found: notFound, claims: texts.map((text) => ({ text, citations: [K1] })) }
}

describe('verifier', () => {
  // SPEC §3 verifier: a claim without a citation, a cited key not retrieved, and not_found
  // disagreeing with the claims each fail the answer.
  test.for<[string, Answer, string[], string[]]>([
    ['a valid claim', answer(false, [K1]), [K1], []],
    ['two valid claims', answer(false, [K1], [K2]), [K1, K2], []],
    [
      'a claim without citation, numbered from 1',
      answer(false, [K1], []),
      [K1],
      ['claim 2 has no citation'],
    ],
    ['a citation not retrieved', answer(false, [K9]), [K1], [`${K9} was not retrieved`]],
    ['an empty citation key', answer(false, ['']), [K1], [' was not retrieved']],
    ['an empty answer', answer(false), [K1], ['no claims but not_found is false']],
    [
      'claims although not found',
      answer(true, [K1]),
      [K1],
      ['claims present but not_found is true'],
    ],
    ['not found without claims', answer(true), [K1], []],
    ['not found with nothing retrieved', answer(true), [], []],
    [
      'every failure in order',
      answer(true, [], [K9, K1, K9]),
      [K1],
      [
        'claim 1 has no citation',
        `${K9} was not retrieved`,
        'claims present but not_found is true',
      ],
    ],
    [
      'a key repeated in one claim counts once, in each claim again',
      answer(false, [K9, K9], [K9], [K2, K1]),
      [K1],
      [`${K9} was not retrieved`, `${K9} was not retrieved`, `${K2} was not retrieved`],
    ],
  ])('%s', ([, draft, retrieved, reasons]) => {
    expect(verify(draft, new Set(retrieved))).toEqual(reasons)
  })
})

describe('reply', () => {
  test.for<[string, Answer, string]>([
    ['claims joined with a space', said('en', false, 'claim 0', 'claim 1'), 'claim 0 claim 1'],
    ['one claim', said('pl', false, 'Jedno.'), 'Jedno.'],
    ['texts kept as written', said('en', false, ' a ', 'b\n'), ' a  b\n'],
    ['empty texts', said('en', false, '', ''), ' '],
    ['no claims', said('en', false), ''],
    ['not found in English', said('en', true), 'Not found in the sources.'],
    ['not found in Polish', said('pl', true), 'Nie znaleziono w źródłach.'],
    ['not found ignores claims', said('en', true, 'ignored'), 'Not found in the sources.'],
  ])('%s', ([, draft, text]) => {
    expect(reply(draft)).toBe(text)
  })

  test('the not-found texts cover both languages', () => {
    expect(NOT_FOUND).toEqual({ en: 'Not found in the sources.', pl: 'Nie znaleziono w źródłach.' })
  })
})
