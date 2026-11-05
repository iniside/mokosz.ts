import { resolve } from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'
import { label } from '../src/citations.ts'
import type { Lang } from '../src/ingest/acts.ts'
import { citationKey, loadCorpus, type Chunk } from '../src/ingest/chunker.ts'

const ROOT = resolve(import.meta.dirname, '..')
const EXPECTED_LABELS = 3974

let corpus: Chunk[]
let text: Map<string, string>

const textKey = (key: string, lang: Lang): string => `${key}\u0000${lang}`

beforeAll(async () => {
  corpus = await loadCorpus(ROOT)
  text = new Map(corpus.map((chunk) => [textKey(citationKey(chunk), chunk.lang), chunk.text]))
})

describe('label', () => {
  test.each([
    ['32024R1689#014.001', 'AI Act Art. 14(1)', 'AI Act art. 14 ust. 1'],
    ['32016R0679#art_4.pt_1', 'GDPR Art. 4(1)', 'GDPR art. 4 pkt 1'],
    ['32016R0679#art_50.pt_1', 'GDPR Art. 50(a)', 'GDPR art. 50 lit. a'],
    ['32016R0679#art_4.p_0', 'GDPR Art. 4', 'GDPR art. 4'],
    ['32024R1689#art_102.p_1', 'AI Act Art. 102', 'AI Act art. 102'],
    ['32016R0679#rct_85', 'GDPR Recital 85', 'GDPR motyw 85'],
    ['32022L2555#anx_I.r_3', 'NIS2 Annex I', 'NIS2 załącznik I'],
    ['32024R1689#anx_II.p_1', 'AI Act Annex II', 'AI Act załącznik II'],
  ] as const)('case table %s', (key, en, pl) => {
    expect(label(key, 'en', text.get(textKey(key, 'en')) ?? 'missing')).toBe(en)
    expect(label(key, 'pl', text.get(textKey(key, 'pl')) ?? 'missing')).toBe(pl)
    expect(text.has(textKey(key, 'en'))).toBe(true)
    expect(text.has(textKey(key, 'pl'))).toBe(true)
  })

  test('the point label comes from the text, not the position', () => {
    expect(label('32016R0679#art_50.pt_1', 'en', '(c) something')).toBe('GDPR Art. 50(c)')
    expect(label('32016R0679#art_50.pt_1', 'pl', 'c) coś')).toBe('GDPR art. 50 lit. c')
    expect(label('32016R0679#art_4.pt_1', 'pl', '7) coś')).toBe('GDPR art. 4 pkt 7')
  })

  test.each([
    '99999R9999#rct_1',
    '32016R0679#014',
    '32016R0679#art_4',
    '32016R0679#anx_I',
    '32016R0679',
  ])('rejects the unknown key %s', (key) => {
    expect(() => label(key, 'en', '(1) x')).toThrow(Error)
  })

  test('rejects a point without a label', () => {
    expect(() =>
      label('32016R0679#art_4.pt_1', 'en', 'personal data referred to in point (a)'),
    ).toThrow(/does not start with a point label/)
  })

  test('every corpus chunk gets a label and the EN and PL points agree', () => {
    const labels = new Map(
      corpus.map((chunk) => [
        textKey(citationKey(chunk), chunk.lang),
        label(citationKey(chunk), chunk.lang, chunk.text),
      ]),
    )
    expect(labels.size).toBe(EXPECTED_LABELS)
    const points = [
      ...new Set(corpus.map(citationKey).filter((key) => key.includes('.pt_'))),
    ].toSorted()
    expect(points.length).toBeGreaterThan(0)
    for (const key of points) {
      const en = /^.* Art\. \p{Nd}+\(([\p{L}\p{Nd}_]+)\)$/u.exec(labels.get(textKey(key, 'en'))!)
      const pl = /^.* art\. \p{Nd}+ (?:pkt|lit\.) ([\p{L}\p{Nd}_]+)$/u.exec(
        labels.get(textKey(key, 'pl'))!,
      )
      expect(en, key).not.toBeNull()
      expect(pl, key).not.toBeNull()
      expect(en![1], key).toBe(pl![1])
    }
  })
})

describe('label on explicit keys and texts', () => {
  test.each([
    ['article paragraph', '32024R1689#014.001', 'en', '', 'AI Act Art. 14(1)'],
    ['article paragraph', '32024R1689#014.001', 'pl', '', 'AI Act art. 14 ust. 1'],
    ['zero padding dropped', '32016R0679#099.002', 'en', '', 'GDPR Art. 99(2)'],
    ['zero padding dropped', '32016R0679#099.002', 'pl', '', 'GDPR art. 99 ust. 2'],
    ['numbered point', '32016R0679#art_4.pt_7', 'en', '(7) x', 'GDPR Art. 4(7)'],
    ['numbered point', '32016R0679#art_4.pt_7', 'pl', '7) x', 'GDPR art. 4 pkt 7'],
    ['lettered point', '32016R0679#art_50.pt_2', 'en', '(b) x', 'GDPR Art. 50(b)'],
    ['lettered point', '32016R0679#art_50.pt_2', 'pl', 'b) x', 'GDPR art. 50 lit. b'],
    ['point after whitespace', '32016R0679#art_50.pt_1', 'en', ' \n(a) x', 'GDPR Art. 50(a)'],
    ['article block', '32024R1689#art_102.p_1', 'en', '', 'AI Act Art. 102'],
    ['article block', '32024R1689#art_102.p_1', 'pl', '', 'AI Act art. 102'],
    ['recital', '32016R0679#rct_85', 'en', '', 'GDPR Recital 85'],
    ['recital', '32016R0679#rct_85', 'pl', '', 'GDPR motyw 85'],
    ['annex block', '32024R1689#anx_III.p_2', 'en', '', 'AI Act Annex III'],
    ['annex block', '32024R1689#anx_III.p_2', 'pl', '', 'AI Act załącznik III'],
    ['annex row', '32022L2555#anx_I.r_3', 'en', '', 'NIS2 Annex I'],
    ['annex row', '32022L2555#anx_I.r_3', 'pl', '', 'NIS2 załącznik I'],
  ] as const)('%s: %s (%s)', (_, key, lang, chunkText, expected) => {
    expect(label(key, lang, chunkText)).toBe(expected)
  })

  test.each([
    ['99999R9999#rct_1', 'en', '', 'unknown CELEX in citation key "99999R9999#rct_1"'],
    ['32016R0679#014', 'en', '', 'unknown element id in citation key "32016R0679#014"'],
    [
      '32016R0679#rct_\u0668\u0665',
      'en',
      '',
      'unknown element id in citation key "32016R0679#rct_\u0668\u0665"',
    ],
    [
      '32022L2555#anx_I.p_1x',
      'en',
      '',
      'unknown element id in citation key "32022L2555#anx_I.p_1x"',
    ],
    [
      '32024R1689#\u0661\u0664.\u0660\u0660\u0661',
      'en',
      '',
      'unknown element id in citation key "32024R1689#\u0661\u0664.\u0660\u0660\u0661"',
    ],
    [
      '32016R0679#art_4.pt_1',
      'en',
      'personal data referred to in point (a)',
      'point 32016R0679#art_4.pt_1 (en) does not start with a point label: "personal data referr"',
    ],
    [
      '32016R0679#art_4.pt_1',
      'pl',
      '(\u0661) x',
      'point 32016R0679#art_4.pt_1 (pl) does not start with a point label: "(\u0661) x"',
    ],
  ] as const)('rejects %s (%s)', (key, lang, chunkText, message) => {
    expect(() => label(key, lang, chunkText)).toThrow(new Error(message))
  })

  test('the quoted start of a point text keeps whole code points', () => {
    const emoji = String.fromCodePoint(0x1f600)
    const start = `${'x'.repeat(19)}${emoji}`

    expect(() => label('32016R0679#art_4.pt_1', 'en', `${start}tail`)).toThrow(
      new Error(`point 32016R0679#art_4.pt_1 (en) does not start with a point label: "${start}"`),
    )
  })
})
