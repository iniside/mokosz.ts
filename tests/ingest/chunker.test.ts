import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ParseError, type Element, type Node } from '@xmldom/xmldom'
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { ACTS, type Lang } from '../../src/ingest/acts.ts'
import {
  ChunkingError,
  ChunkSchema,
  chunkAct,
  citationKey,
  embeddingText,
  loadCorpus,
  parseXhtml,
  type Chunk,
} from '../../src/ingest/chunker.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')
const RULE_1 = /^\d{3}\.\d{3}$/
const LANGS = ['en', 'pl'] as const
const XHTML = 'http://www.w3.org/1999/xhtml'
const split = (text: string): string[] => text.split(/\s+/).filter((word) => word !== '')

const sha256 = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex')

let corpus: Chunk[]

beforeAll(async () => {
  corpus = await loadCorpus(ROOT)
})

const of = (act: string, lang: Lang = 'en'): Chunk[] =>
  corpus.filter((c) => c.act === act && c.lang === lang)
const ids = (chunks: Chunk[]): string[] => chunks.map((c) => c.elementId)
const byId = (chunks: Chunk[]): Map<string, Chunk> => new Map(chunks.map((c) => [c.elementId, c]))
const get = (chunks: Chunk[], id: string): Chunk => {
  const chunk = byId(chunks).get(id)
  if (chunk === undefined) throw new Error(`no chunk ${id}`)
  return chunk
}
const words = (chunk: Chunk): number => split(chunk.text).length
const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i)
const raw = (celex: string, lang: Lang): string =>
  join(ROOT, 'data', 'raw', `${celex}.${lang}.xhtml`)

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mokosz-chunker-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function chunkText(
  xhtml: string | Uint8Array,
  celex = '32024R1689',
  act = 'AI Act',
  lang: Lang = 'en',
) {
  const path = join(dir, 'act.xhtml')
  await writeFile(path, xhtml)
  return chunkAct(path, celex, act, lang)
}

describe('the committed corpus', () => {
  test.each([
    ['32016R0679.en.xhtml', '962539af03738bf552319ff4ce42d69e5f95a576307c4dfed7bf87e81b646b9d'],
    ['32016R0679.pl.xhtml', '4b44ea95933447cc42eb0c0bae62d27bda5855732ee929692b2e241775c78b2d'],
    ['32024R1689.en.xhtml', '8f0b656302f9864cc87e040c371f209a9d65ae1a6cecc25ca5eb737e872d721a'],
    ['32024R1689.pl.xhtml', '37b91c6f5fdc6c2286285af5c87c8473496685ace62b9c9c3c5afc5a0b257360'],
    ['32022L2555.en.xhtml', '6ee66d5c419d9a056fb98d94083cacf9b818803bd6b416435718e0d4919cb589'],
    ['32022L2555.pl.xhtml', '7fd741c8309df320be28a958a71acee3a30d2c1639b3ccfbacac6024d32ee61c'],
  ])('raw file %s is unchanged', async (name, digest) => {
    expect(sha256(await readFile(join(ROOT, 'data', 'raw', name)))).toBe(digest)
  })

  // Pins the chunk text data/embeddings/bge-m3/chunks.npy was embedded from.
  test('chunk text and embedding text digest', () => {
    const lines = corpus
      .map((c) => `${citationKey(c)}\t${c.lang}\t${c.text}\t${embeddingText(c)}`)
      .toSorted()
    expect(corpus).toHaveLength(3974)
    expect(sha256(lines.join('\n'))).toBe(
      '8ff758b7dae43ba00dbd73270896fc1defc28c802b002365832daf48a7e7c300',
    )
  })

  test('the key list equals data/embeddings/bge-m3/chunks.json', async () => {
    const path = join(ROOT, 'data', 'embeddings', 'bge-m3', 'chunks.json')

    expect(corpus.map((c) => ({ citation_key: citationKey(c), lang: c.lang }))).toEqual(
      JSON.parse(await readFile(path, 'utf8')),
    )
  })
})

const GDPR = ['32016R0679', 'GDPR'] as const
const NIS2 = ['32022L2555', 'NIS2'] as const
const chunkFields = (chunks: Chunk[]) =>
  chunks.map((c) => [c.elementId, c.kind, c.article, c.heading, c.text])
const articleDoc = (number: number, body: string, title = 'Title'): string =>
  `<div id="art_${number}"><p class="oj-ti-art">Article ${number}</p>` +
  `<p class="oj-sti-art eli-title">${title}</p>${body}</div>`
const annexDoc = (roman: string, body: string): string =>
  `<div id="anx_${roman}"><p class="oj-doc-ti">ANNEX ${roman}</p>` +
  `<p class="oj-doc-ti">Title</p>${body}</div>`
const sectorTable = (body: string): string =>
  '<table class="oj-table"><tbody><tr><td><p class="oj-tbl-hdr">Sector</p></td>' +
  `<td><p class="oj-tbl-hdr">Entity</p></td></tr>${body}</tbody></table>`

const recitalBytes = (text: string | Buffer): Buffer =>
  Buffer.concat([
    Buffer.from(`<html xmlns="${XHTML}"><body><div id="rct_1"><p>`),
    typeof text === 'string' ? Buffer.from(text) : text,
    Buffer.from('</p></div></body></html>'),
  ])
const declared = (encoding: string, bytes: number[]): Buffer =>
  Buffer.concat([
    Buffer.from(`<?xml version="1.0" encoding="${encoding}"?>`),
    recitalBytes(Buffer.from(bytes)),
  ])
const utf16le = (text: string): Buffer => Buffer.from(`\ufeff${text}`, 'utf16le')

describe('chunking rules on small documents', () => {
  test.each([
    ['whitespace runs collapse to one space', '<p> a \t b\n\u00a0c\u3000d </p>', 'a b c d'],
    ['a zero-width space is not whitespace', '<p>x\u200by z</p>', 'x\u200by z'],
    [
      'text after a comment or a processing instruction is dropped',
      '<p>a<!-- c -->b<i>i</i>t<?pi x?>u</p><p>x<!--y--></p>',
      'ait\nx',
    ],
    ['CDATA is text', '<p>a<![CDATA[<b>]]>c</p>', 'a<b>c'],
    [
      'inline elements join, block elements separate',
      '<p>a<span>b</span>c<br/>d<em>e</em><li>f</li>g</p>',
      'abc de f g',
    ],
    [
      'a wrapper div gives one line per child',
      '<div> <p>one</p> <p>two</p>\n</div><div>x<p>three</p></div>',
      'one\ntwo\nx three',
    ],
    [
      'elements outside the XHTML namespace are not blocks or units',
      '<p>a<x:div xmlns:x="urn:x">b</x:div>c</p><x:div xmlns:x="urn:x" id="rct_2">d</x:div>',
      'abc\nd',
    ],
  ])('recital text: %s', async (_, body, text) => {
    const chunks = await chunkText(doc(`<div id="rct_1">${body}</div>`), ...GDPR)
    expect(chunkFields(chunks)).toEqual([['rct_1', 'recital', null, null, text]])
  })

  test('unit ids take ASCII digits only', async () => {
    const chunks = await chunkText(
      doc('<div id="rct_\u0661"><p>no</p></div><div id="rct_2"><p>yes</p></div>'),
      ...GDPR,
    )
    expect(chunkFields(chunks)).toEqual([['rct_2', 'recital', null, null, 'yes']])
  })

  test('rule 1: paragraph ids of the enclosing article give one chunk each', async () => {
    const body =
      '<p class=" oj-ti-art ">Article 3</p><p class="oj-sti-art\teli-title">Scope</p>' +
      '<div id="003.001"><p>One.</p></div><div id="003.002"><p>Two.</p></div>'
    const chunks = await chunkText(doc(`<div id="art_3">${body}</div>`), ...GDPR)
    expect(chunkFields(chunks)).toEqual([
      ['003.001', 'paragraph', 3, 'Scope', 'One.'],
      ['003.002', 'paragraph', 3, 'Scope', 'Two.'],
    ])
  })

  test('rule 2: a lead-in and points', async () => {
    const chunks = await chunkText(
      doc(articleDoc(4, para('Lead:') + item('(1)', para('one')) + item('b)', para('two')))),
      ...GDPR,
    )
    expect(chunkFields(chunks)).toEqual([
      ['art_4.p_0', 'paragraph', 4, 'Title', 'Lead:'],
      ['art_4.pt_1', 'point', 4, 'Title', '(1) one'],
      ['art_4.pt_2', 'point', 4, 'Title', 'b) two'],
    ])
  })

  test('rule 2: blocks without points are numbered from 1', async () => {
    const chunks = await chunkText(doc(articleDoc(5, para('One.') + para('Two.'))), ...GDPR)
    expect(chunkFields(chunks)).toEqual([
      ['art_5.p_1', 'paragraph', 5, 'Title', 'One.'],
      ['art_5.p_2', 'paragraph', 5, 'Title', 'Two.'],
    ])
  })

  test('rule 2: paragraph ids of another article are quoted text', async () => {
    const chunks = await chunkText(
      doc(articleDoc(7, `<div id="005.001">${para('quoted')}</div>${para('own')}`)),
      ...GDPR,
    )
    expect(chunkFields(chunks)).toEqual([
      ['art_7.p_1', 'paragraph', 7, 'Title', 'quoted'],
      ['art_7.p_2', 'paragraph', 7, 'Title', 'own'],
    ])
  })

  test('annex notes are skipped and a data table gives one line per row', async () => {
    const table =
      '<table class="oj-table"><tbody><tr><td><p>a</p></td><td><p>b</p></td></tr>' +
      '<tr><td><p>c</p></td><td><p>d</p></td></tr></tbody></table>'
    const chunks = await chunkText(
      doc(annexDoc('IV', `<p class="oj-note">note</p>${para('body')}${table}`)),
      ...GDPR,
    )
    expect(chunkFields(chunks)).toEqual([
      ['anx_IV.p_1', 'annex', null, 'Title', 'body'],
      ['anx_IV.p_2', 'annex', null, 'Title', 'a | b\nc | d'],
    ])
  })

  test('a NIS2 sector annex gives one chunk per row, a rowspan repeats its cell', async () => {
    const body =
      '<tr><td rowspan=" 2 "><p>1. Energy</p></td><td><p>a</p></td></tr>' +
      '<tr><td><p>b</p></td></tr><tr><td><p>2. Other</p></td><td><p>c</p></td></tr>'
    const chunks = await chunkText(doc(annexDoc('I', sectorTable(body))), ...NIS2)
    expect(chunkFields(chunks)).toEqual([
      ['anx_I.r_1', 'annex', null, 'Title', '1. Energy | a'],
      ['anx_I.r_2', 'annex', null, 'Title', '1. Energy | b'],
      ['anx_I.r_3', 'annex', null, 'Title', '2. Other | c'],
    ])
  })

  test.each([
    [
      'a rowspan that is not a whole number',
      NIS2,
      annexDoc('I', sectorTable('<tr><td rowspan="x"><p>1</p></td><td><p>a</p></td></tr>')),
      'rowspan "x" is not a whole number',
    ],
    [
      'a blank rowspan',
      NIS2,
      annexDoc('I', sectorTable('<tr><td rowspan=" "><p>1</p></td><td><p>a</p></td></tr>')),
      'rowspan "" is not a whole number',
    ],
    [
      'a rowspan past the end of the table',
      NIS2,
      annexDoc('I', sectorTable('<tr><td rowspan="3"><p>1</p></td><td><p>a</p></td></tr>')),
      'a rowspan runs past the end of its table',
    ],
    [
      'a NIS2 sector annex that is not one table',
      NIS2,
      annexDoc('I', para('x')),
      '32022L2555 anx_I (en) is not a single sector table',
    ],
    [
      'a nested unit',
      GDPR,
      '<div id="rct_1"><div id="rct_2"><p>x</p></div></div>',
      'rct_2 is nested inside another unit',
    ],
    [
      'an empty recital',
      GDPR,
      '<div id="rct_9"><p>   </p></div>',
      '32016R0679#rct_9 (en) has no text',
    ],
    [
      'an article without a title',
      GDPR,
      '<div id="art_3"><p>x</p></div>',
      '32016R0679 art_3 (en) has no title',
    ],
    [
      'an article mixing paragraph ids with other blocks',
      GDPR,
      articleDoc(6, `<div id="006.001">${para('x')}</div>${para('y')}`),
      '32016R0679 art_6 (en) mixes paragraph ids with other blocks',
    ],
    [
      'an article with a block after its points',
      GDPR,
      articleDoc(9, para('Lead:') + item('(a)', para('one')) + para('after')),
      '32016R0679 art_9 (en) has a block after its points',
    ],
    [
      'an annex without a title',
      GDPR,
      `<div id="anx_V"><p class="oj-doc-ti">ANNEX V</p>${para('x')}</div>`,
      '32016R0679 anx_V (en) has no title',
    ],
  ] as const)('rejects %s', async (_, [celex, act], body, message) => {
    const run = chunkText(doc(body), celex, act)
    await expect(run).rejects.toThrow(ChunkingError)
    await expect(run).rejects.toThrow(message)
  })

  test.each([
    ['an unquoted attribute', '<div id=rct_1><p>x</p></div>'],
    ['an unclosed element', '<div id="rct_1"><p>x</div>'],
    ['an undefined entity', '<div id="rct_1"><p>&nbsp;</p></div>'],
    ['a duplicate attribute', '<div id="rct_1" id="rct_2"><p>x</p></div>'],
    ['a bare less-than', '<div id="rct_1"><p>a < b</p></div>'],
    ['a raw U+0001 in text', '<div id="rct_1"><p>\u0001</p></div>'],
    ['a raw U+0001 in an attribute', '<div id="rct_1" title="\u0001"><p>x</p></div>'],
    ['&#0; in text', '<div id="rct_1"><p>&#0;</p></div>'],
    ['&#xFFFE; in text', '<div id="rct_1"><p>&#xFFFE;</p></div>'],
    ['&#xD800; in text', '<div id="rct_1"><p>&#xD800;</p></div>'],
    [']]> in character data', '<div id="rct_1"><p>a]]>b</p></div>'],
  ])('malformed XML is a ParseError: %s', async (_, body) => {
    await expect(chunkText(doc(body), ...GDPR)).rejects.toThrow(ParseError)
  })

  test.each([
    ['ISO-8859-2: 0xB1 0xB3 are ą ł', declared('ISO-8859-2', [0xb1, 0xb3]), 'ął'],
    ['ISO-8859-1: 0xE9 is é and 0x80 is U+0080', declared('ISO-8859-1', [0xe9, 0x80]), 'é\u0080'],
    [
      'a UTF-8 BOM',
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), recitalBytes('zażółć')]),
      'zażółć',
    ],
    ['a UTF-16LE BOM', utf16le(recitalBytes('zażółć').toString('utf8')), 'zażółć'],
    ['a UTF-16BE BOM', utf16le(recitalBytes('zażółć').toString('utf8')).swap16(), 'zażółć'],
  ])('decodes %s', async (_, source, text) => {
    const chunks = await chunkText(source, ...GDPR)
    expect(chunkFields(chunks)).toEqual([['rct_1', 'recital', null, null, text]])
  })

  test.each([
    ['US-ASCII declared with a byte above 0x7F', declared('US-ASCII', [0xe9])],
    ['an unsupported declared encoding', declared('windows-1250', [0x61])],
    ['no declaration and bytes that are not UTF-8', recitalBytes(Buffer.from([0xb1]))],
  ])('rejects %s as a ParseError', async (_, source) => {
    await expect(chunkText(source, ...GDPR)).rejects.toThrow(ParseError)
  })
})

describe('more chunking rules', () => {
  test('a wrapper div whose child has a tail is one line', async () => {
    const chunks = await chunkText(
      doc('<div id="rct_1"><div><p>one</p>tail<p>two</p></div></div>'),
      ...GDPR,
    )
    expect(chunkFields(chunks)).toEqual([['rct_1', 'recital', null, null, 'one tail two']])
  })

  test('a row mixing header and plain paragraphs is a data row', async () => {
    const body =
      '<tr><td><p class="oj-tbl-hdr">S</p><p>x</p></td><td><p class="oj-tbl-hdr">E</p></td></tr>' +
      '<tr><td><p>1. A</p></td><td><p>b</p></td></tr>'
    const chunks = await chunkText(doc(annexDoc('I', sectorTable(body))), ...NIS2)
    expect(chunkFields(chunks)).toEqual([
      ['anx_I.r_1', 'annex', null, 'Title', 'S x | E'],
      ['anx_I.r_2', 'annex', null, 'Title', '1. A | b'],
    ])
  })

  const utf16Declared = `<?xml version="1.0" encoding="UTF-16"?>${recitalBytes('zażółć').toString('utf8')}`

  test.each([
    ['UTF-16LE without a BOM, declared UTF-16', Buffer.from(utf16Declared, 'utf16le'), 'zażółć'],
    [
      'UTF-16BE without a BOM, declared UTF-16',
      Buffer.from(utf16Declared, 'utf16le').swap16(),
      'zażółć',
    ],
    ['the label latin1: 0xE9 is é', declared('latin1', [0xe9]), 'é'],
    ['the label L1: 0xE9 is é', declared('L1', [0xe9]), 'é'],
    ['the label ISO8859-2: 0xB1 is ą', declared('ISO8859-2', [0xb1]), 'ą'],
    ['the label iso_8859-16: 0xAA is Ș', declared('iso_8859-16', [0xaa]), 'Ș'],
    [
      'a UTF-8 BOM then an ISO-8859-2 declaration: the declaration decides, 0xB1 is ą',
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), declared('ISO-8859-2', [0xb1])]),
      'ą',
    ],
    [
      'a UTF-16LE BOM then an ISO-8859-2 declaration: the BOM decides',
      utf16le(
        `<?xml version="1.0" encoding="ISO-8859-2"?>${recitalBytes('zażółć').toString('utf8')}`,
      ),
      'zażółć',
    ],
  ])('decodes %s', async (_, source, text) => {
    const chunks = await chunkText(source, ...GDPR)
    expect(chunkFields(chunks)).toEqual([['rct_1', 'recital', null, null, text]])
  })

  test('the label iso-8859-12 is unsupported', async () => {
    await expect(chunkText(declared('iso-8859-12', [0x61]), ...GDPR)).rejects.toThrow(ParseError)
  })
})

describe('whitespace and digits are the JavaScript ones', () => {
  test.each([
    ['U+0085 is not whitespace', '<p>a\u0085b c</p>', 'a\u0085b c'],
    ['U+FEFF is whitespace', '<p>a\ufeffb</p>', 'a b'],
  ])('%s', async (_, body, text) => {
    const chunks = await chunkText(doc(`<div id="rct_1">${body}</div>`), ...GDPR)
    expect(chunkFields(chunks)).toEqual([['rct_1', 'recital', null, null, text]])
  })

  test('a label with Arabic-Indic digits is not a point', async () => {
    const chunks = await chunkText(
      doc(articleDoc(4, para('Lead:') + item('(\u0661)', para('one')))),
      ...GDPR,
    )
    expect(chunkFields(chunks)).toEqual([
      ['art_4.p_1', 'paragraph', 4, 'Title', 'Lead:'],
      ['art_4.p_2', 'paragraph', 4, 'Title', '(\u0661) one'],
    ])
  })

  test('a paragraph id with Arabic-Indic digits is not a rule 1 id', async () => {
    const chunks = await chunkText(
      doc(articleDoc(3, `<div id="003.\u0660\u0660\u0661">${para('One.')}</div>`)),
      ...GDPR,
    )
    expect(chunkFields(chunks)).toEqual([['art_3.p_1', 'paragraph', 3, 'Title', 'One.']])
  })
})

describe('chunker', () => {
  describe.each(LANGS)('%s', (lang) => {
    test.each([
      ['GDPR', 99, 372, 173, 0, 17],
      ['AI Act', 113, 500, 180, 13, 19],
      ['NIS2', 46, 189, 144, 3, 10],
    ] as const)(
      'counts match the spec: %s',
      (act, articles, rule1, recitals, annexes, rule2Articles) => {
        const chunks = of(act, lang)
        const articleChunks = chunks.filter((c) => c.article !== null)
        expect(new Set(articleChunks.map((c) => c.article)).size).toBe(articles)
        expect(chunks.filter((c) => RULE_1.test(c.elementId))).toHaveLength(rule1)
        expect(chunks.filter((c) => c.kind === 'recital')).toHaveLength(recitals)
        const annexNumbers = new Set(
          chunks.filter((c) => c.kind === 'annex').map((c) => c.elementId.split('.')[0]),
        )
        expect(annexNumbers.size).toBe(annexes)
        const rule2 = articleChunks.filter((c) => c.elementId.startsWith('art_'))
        expect(new Set(rule2.map((c) => c.article)).size).toBe(rule2Articles)
      },
    )

    test.each([
      ['GDPR', 593, 0],
      ['AI Act', 946, 134],
      ['NIS2', 448, 63],
    ] as const)('chunk totals: %s', (act, total, annexChunks) => {
      const chunks = of(act, lang)
      expect(chunks).toHaveLength(total)
      expect(chunks.filter((c) => c.kind === 'annex')).toHaveLength(annexChunks)
    })

    test('rule 1 ids belong to their article', () => {
      for (const chunk of corpus) {
        if (chunk.lang === lang && RULE_1.test(chunk.elementId)) {
          expect(Number(chunk.elementId.slice(0, 3)), citationKey(chunk)).toBe(chunk.article)
        }
      }
    })

    test('AI Act quoted ids are not rule 1 chunks', () => {
      const chunks = of('AI Act', lang)
      const count = (id: string): number => ids(chunks).filter((i) => i === id).length
      expect(count('005.012')).toBe(0)
      expect(count('008.005')).toBe(0)
      for (const real of ['005.004', '011.003', '017.003', '043.004', '047.003', '058.003']) {
        expect(count(real)).toBe(1)
        expect(get(chunks, real).article).toBe(Number(real.slice(0, 3)))
      }
      expect(count('019.004')).toBe(0)
      for (const article of [102, 103, 104, 105, 106, 107, 109, 110]) {
        expect(ids(chunks.filter((c) => c.article === article))).toEqual([
          `art_${article}.p_1`,
          `art_${article}.p_2`,
        ])
      }
      const quoting = chunks.filter(
        (c) => c.article !== null && c.article >= 105 && c.article < 110,
      )
      expect(quoting.length).toBeGreaterThan(0)
      for (const chunk of quoting) {
        expect(chunk.elementId).toMatch(new RegExp(`^art_${chunk.article}\\.(p|pt)_\\d+$`))
      }
      expect(ids(quoting.filter((c) => c.article === 108))).toEqual([
        'art_108.p_0',
        ...range(1, 6).map((k) => `art_108.pt_${k}`),
      ])
    })

    test.each([
      ['GDPR', 4, 26],
      ['AI Act', 3, 68],
      ['GDPR', 50, 4],
      ['AI Act', 16, 12],
    ] as const)('articles split by point: %s %i', (act, article, points) => {
      const chunks = of(act, lang).filter((c) => c.article === article)
      expect(ids(chunks)).toEqual([
        `art_${article}.p_0`,
        ...range(1, points).map((k) => `art_${article}.pt_${k}`),
      ])
      expect(chunks.map((c) => c.kind)).toEqual(['paragraph', ...Array(points).fill('point')])
    })

    test.each([
      ['I', 48],
      ['II', 14],
    ] as const)('NIS2 sector annex %s splits by row', (annex, rows) => {
      const chunks = of('NIS2', lang).filter((c) => c.elementId.startsWith(`anx_${annex}.`))
      expect(ids(chunks)).toEqual(range(1, rows).map((j) => `anx_${annex}.r_${j}`))
      for (const chunk of chunks) {
        const parts = chunk.text.split('|').map((part) => part.trim())
        expect(parts, citationKey(chunk)).toHaveLength(3)
        const [sector, , entity] = parts
        expect(sector, citationKey(chunk)).toMatch(/^\p{Nd}+\. /u)
        expect(entity).toBeTruthy()
      }
    })

    test('NIS2 energy rows keep their sector', () => {
      const energy = lang === 'en' ? 'Energy' : 'Energetyka'
      const rows = of('NIS2', lang).filter((c) => c.elementId.startsWith('anx_I.r_'))
      const inEnergy = rows.filter((c) => c.text.startsWith('1. '))
      expect(inEnergy).toHaveLength(17)
      expect(inEnergy.every((c) => c.text.startsWith(`1. ${energy} | `))).toBe(true)
      expect(new Set(inEnergy.map((c) => c.text.split(' | ')[1])).size).toBe(5)
    })

    test('NIS2 correlation table is one chunk', () => {
      const chunks = of('NIS2', lang).filter((c) => c.elementId.startsWith('anx_III.'))
      expect(ids(chunks)).toEqual(['anx_III.p_1'])
      const lines = chunks[0]!.text.split('\n')
      expect(lines).toHaveLength(76)
      expect(lines.every((line) => line.split(' | ').length - 1 === 1)).toBe(true)
    })

    test('AI Act annex tables are one chunk each', () => {
      const annexI = of('AI Act', lang).filter((c) => c.elementId.startsWith('anx_I.'))
      expect(annexI).toHaveLength(20)
      const section = lang === 'en' ? 'Section' : 'Sekcja'
      annexI.forEach((chunk, i) => {
        const k = i + 1
        const headings = chunk.text.split('\n')
        const entry = headings.pop()!
        expect(entry.startsWith(`${k}. `), citationKey(chunk)).toBe(true)
        const letter = k === 1 ? 'A' : 'B'
        expect(headings.every((h) => h.startsWith(`${section} ${letter}. `))).toBe(true)
      })
      expect(annexI.flatMap((c, i) => (c.text.includes('\n') ? [i + 1] : []))).toEqual([1, 13])
    })

    test.each([
      ['I', 20],
      ['II', 1],
      ['VII', 16],
      ['VIII', 30],
      ['X', 12],
      ['XI', 6],
    ] as const)('AI Act annex %s with headings or dashes', (annex, chunks) => {
      const found = ids(of('AI Act', lang)).filter((i) => i.startsWith(`anx_${annex}.`))
      expect(found).toEqual(range(1, chunks).map((k) => `anx_${annex}.p_${k}`))
    })

    describe.each(ACTS)('%s', (celex, act) => {
      test('annex headings stay with their content', async () => {
        const headings = await annexHeadings(raw(celex, lang))
        const annex = of(act, lang).filter((c) => c.kind === 'annex')
        for (const heading of headings) {
          const holders = annex.filter((c) => c.text.split('\n').includes(heading))
          expect(holders, heading).toHaveLength(1)
          expect(headings, citationKey(holders[0]!)).not.toContain(
            holders[0]!.text.split('\n').at(-1),
          )
        }
        expect(headings).toHaveLength(act === 'AI Act' ? 21 : 0)
      })

      test('no annex chunk is only headings or dash items', async () => {
        const headings = new Set(await annexHeadings(raw(celex, lang)))
        for (const chunk of of(act, lang).filter((c) => c.kind === 'annex')) {
          const lines = chunk.text.split('\n')
          expect(
            lines.every((line) => headings.has(line)),
            citationKey(chunk),
          ).toBe(false)
          expect(
            lines.every((line) => line.startsWith('— ')),
            citationKey(chunk),
          ).toBe(false)
        }
      })
    })
  })

  test('points and lead-in keep their text', () => {
    const gdpr = of('GDPR')
    expect(get(gdpr, 'art_4.p_0').text).toBe('For the purposes of this Regulation:')
    expect(get(gdpr, 'art_4.pt_1').text.startsWith('(1) ')).toBe(true)
    expect(get(gdpr, 'art_4.pt_1').text).toContain('personal data')
    expect(get(gdpr, 'art_4.pt_26').text.startsWith('(26) ')).toBe(true)
    expect(get(gdpr, 'art_50.pt_1').text.startsWith('(a) develop international cooperation')).toBe(
      true,
    )
    const gdprPl = of('GDPR', 'pl')
    expect(get(gdprPl, 'art_4.pt_26').text.startsWith('26) ')).toBe(true)
    expect(get(gdprPl, 'art_50.pt_1').text.startsWith('a) wypracowania mechanizmów')).toBe(true)
  })

  test.each([
    [
      'GDPR',
      'en',
      'rct_1',
      '(1) The protection of natural persons in relation to the processing of personal' +
        ' data is a fundamental right.',
    ],
    [
      'GDPR',
      'pl',
      'rct_1',
      '(1) Ochrona osób fizycznych w związku z przetwarzaniem danych osobowych jest' +
        ' jednym z praw podstawowych.',
    ],
    ['AI Act', 'en', '014.001', '1. High-risk AI systems shall be designed and developed'],
    ['AI Act', 'pl', '014.001', '1. Systemy AI wysokiego ryzyka projektuje się i rozwija'],
    [
      'GDPR',
      'en',
      '002.002',
      '2. This Regulation does not apply to the processing of personal data:\n' +
        '(a) in the course of an activity',
    ],
    [
      'GDPR',
      'pl',
      '002.002',
      '2. Niniejsze rozporządzenie nie ma zastosowania do przetwarzania danych' +
        ' osobowych:\na) w ramach działalności',
    ],
  ] as const)('chunk text follows the Official Journal: %s %s %s', (act, lang, id, prefix) => {
    expect(get(of(act, lang), id).text.startsWith(prefix)).toBe(true)
  })

  test('NIS2 energy rows contain Energy', () => {
    const rows = of('NIS2').filter((c) => c.elementId.startsWith('anx_I.r_'))
    expect(rows.slice(0, 17).every((c) => c.text.includes('Energy'))).toBe(true)
    expect(rows[17]!.text).not.toContain('Energy')
  })

  test.each([
    [
      'en',
      'Criminal offences referred to in Article 5(1), first subparagraph, point (h)(iii):',
      ['— terrorism,', '— sabotage,', '— rape,'],
    ],
    [
      'pl',
      'Przestępstwa, o których mowa w art. 5 ust. 1 akapit pierwszy lit. h) ppkt (iii):',
      ['— terroryzm,', '— sabotaż,', '— zgwałcenie,'],
    ],
  ] as const)('AI Act annex II is one chunk: %s', (lang, leadIn, offences) => {
    const chunks = of('AI Act', lang).filter((c) => c.elementId.startsWith('anx_II.'))
    expect(ids(chunks)).toEqual(['anx_II.p_1'])
    const lines = chunks[0]!.text.split('\n')
    expect(lines[0]).toBe(leadIn)
    expect(lines).toHaveLength(17)
    expect(lines.slice(1).every((line) => line.startsWith('— '))).toBe(true)
    for (const offence of offences) expect(lines).toContain(offence)
  })

  test.each([
    ['en', 'anx_X.p_1', '1. Schengen Information System\n(a) Regulation (EU) 2018/1860'],
    ['pl', 'anx_X.p_1', '1. System Informacyjny Schengen:\na) rozporządzenie'],
    ['en', 'anx_VII.p_1', '1. Introduction\nConformity based on an assessment'],
    [
      'en',
      'anx_XI.p_1',
      'Section 1\nInformation to be provided by all providers of general-purpose AI' +
        ' models\nThe technical documentation referred to in Article 53(1)',
    ],
    ['pl', 'anx_XI.p_4', 'Sekcja 2\nDodatkowe informacje przekazywane przez dostawców'],
  ] as const)('annex heading joins the block after it: %s %s', (lang, id, prefix) => {
    expect(get(of('AI Act', lang), id).text.startsWith(prefix)).toBe(true)
  })

  test('short annex chunks are genuine items', () => {
    const short = corpus
      .filter((c) => c.kind === 'annex' && words(c) <= 5)
      .map((c) => `${citationKey(c)} ${c.lang} ${c.text}`)
    expect(new Set(short)).toEqual(
      new Set([
        '32024R1689#anx_VIII.p_20 pl 5. Opis przeznaczenia systemu AI;',
        '32024R1689#anx_XIII.p_2 pl a) liczbę parametrów modelu;',
        '32024R1689#anx_XIII.p_8 pl g) liczbę zarejestrowanych użytkowników końcowych.',
      ]),
    )
  })

  test.each([
    [
      para('Lead.') +
        sectionHeading('1. A') +
        sectionHeading('2. B') +
        para('Body.') +
        para('Tail.'),
      ['Lead.', '1. A\n2. B\nBody.', 'Tail.'],
    ],
    [para('Lead.') + dash('x,') + dash('y,') + para('Tail.'), ['Lead.\n— x,\n— y,', 'Tail.']],
    [
      sectionHeading('1. A') + para('Lead.') + dash('x,') + sectionHeading('2. B') + para('Tail.'),
      ['1. A\nLead.\n— x,', '2. B\nTail.'],
    ],
    [para('Lead.') + item('(a)', para('Point.'), dash('y,')), ['Lead.', '(a) Point. — y,']],
  ])('annex grouping rules %#', async (body, texts) => {
    const chunks = await chunkText(annexDocument(body))
    expect(chunks.map((c) => c.text)).toEqual(texts)
    expect(ids(chunks)).toEqual(range(1, texts.length).map((k) => `anx_IV.p_${k}`))
  })

  test.each([
    [para('Lead.') + sectionHeading('1. A'), 'ends with a section heading'],
    [dash('x,') + para('Tail.'), 'starts with a dash item'],
  ])('annex grouping rejects orphans %#', async (body, message) => {
    const run = chunkText(annexDocument(body))
    await expect(run).rejects.toThrow(ChunkingError)
    await expect(run).rejects.toThrow(message)
  })

  test('the longest non-table chunk is GDPR 70(1)', () => {
    expect(words(get(of('GDPR'), '070.001'))).toBe(865)
    const nonTable = corpus.filter((c) => c.lang === 'en' && !c.text.includes(' | '))
    const longest = nonTable.reduce((best, c) => (words(c) > words(best) ? c : best))
    expect(citationKey(longest)).toBe('32016R0679#070.001')
  })

  test.each(ACTS)('keys are unique and equal across languages: %s', (celex, act) => {
    const keys: Record<string, string[]> = {}
    for (const lang of LANGS) {
      const chunks = of(act, lang)
      expect(chunks.every((c) => c.celex === celex)).toBe(true)
      const langKeys = chunks.map(citationKey)
      expect(new Set(langKeys).size).toBe(langKeys.length)
      keys[lang] = langKeys
    }
    expect(keys.en).toEqual(keys.pl)
  })

  test('every chunk has text, kind and heading', () => {
    for (const chunk of corpus) {
      const key = citationKey(chunk)
      expect(chunk.text.trim(), key).not.toBe('')
      expect(chunk.text, key).toBe(
        chunk.text
          .split('\n')
          .map((line) => split(line).join(' '))
          .join('\n'),
      )
      if (chunk.elementId.startsWith('rct_')) {
        expect([chunk.kind, chunk.article, chunk.heading], key).toEqual(['recital', null, null])
      } else if (chunk.elementId.startsWith('anx_')) {
        expect(chunk.kind, key).toBe('annex')
        expect(chunk.article, key).toBeNull()
        expect(chunk.heading, key).toBeTruthy()
      } else {
        expect(chunk.article, key).not.toBeNull()
        expect(chunk.heading, key).toBeTruthy()
        expect(chunk.kind, key).toBe(chunk.elementId.includes('.pt_') ? 'point' : 'paragraph')
      }
    }
  })

  test('headings come from the document', () => {
    expect(get(of('GDPR'), 'art_4.p_0').heading).toBe('Definitions')
    expect(get(of('GDPR', 'pl'), '001.001').heading).toBe('Przedmiot i cele')
    expect(get(of('NIS2'), 'anx_I.r_1').heading).toBe('SECTORS OF HIGH CRITICALITY')
  })

  test('corpus order', async () => {
    const expected: Chunk[] = []
    for (const [celex, act] of ACTS) {
      for (const lang of LANGS)
        expected.push(...(await chunkAct(raw(celex, lang), celex, act, lang)))
    }
    expect(corpus).toEqual(expected)
    const blocks = [...new Set(corpus.map((c) => `${c.act}|${c.lang}`))]
    expect(blocks).toEqual(ACTS.flatMap(([, act]) => LANGS.map((lang) => `${act}|${lang}`)))
    const gdpr = ids(of('GDPR'))
    expect(gdpr[0]).toBe('rct_1')
    expect(gdpr.indexOf('rct_173')).toBeLessThan(gdpr.indexOf('001.001'))
    expect(gdpr.indexOf('001.001')).toBeLessThan(gdpr.indexOf('099.002'))
    expect(ids(of('AI Act')).at(-1)!.startsWith('anx_XIII.')).toBe(true)
  })

  test('citation key', () => {
    expect(citationKey(get(of('AI Act'), '014.001'))).toBe('32024R1689#014.001')
  })

  test.each([
    [{}, 'AI Act Article 14 Human oversight\nBody.'],
    [{ lang: 'pl', heading: 'Nadzór' }, 'AI Act Artykuł 14 Nadzór\nBody.'],
    [
      { elementId: 'art_3.pt_1', kind: 'point', article: 3, heading: 'Definitions' },
      'AI Act Article 3 Definitions\nBody.',
    ],
    [
      { elementId: 'rct_27', kind: 'recital', article: null, heading: null },
      'AI Act Recital 27\nBody.',
    ],
    [
      { elementId: 'rct_27', kind: 'recital', article: null, heading: null, lang: 'pl' },
      'AI Act Motyw 27\nBody.',
    ],
    [
      { elementId: 'anx_III.p_2', kind: 'annex', article: null, heading: 'H' },
      'AI Act Annex III H\nBody.',
    ],
    [
      { elementId: 'anx_I.r_3', kind: 'annex', article: null, heading: 'H', lang: 'pl' },
      'AI Act Załącznik I H\nBody.',
    ],
  ])('embedding text %#', (fields, expected) => {
    expect(embeddingText(makeChunk(fields))).toBe(expected)
  })

  // A missing heading or article is written as None in the embedded text.
  test.each([
    [
      { elementId: 'anx_III.p_2', kind: 'annex', article: null, heading: null },
      'AI Act Annex III None\nBody.',
    ],
    [{ article: null, heading: null }, 'AI Act Article None None\nBody.'],
  ])('embedding text prints null as None %#', (fields, expected) => {
    expect(embeddingText(makeChunk(fields))).toBe(expected)
  })

  test('Chunk rejects unknown fields and kinds', () => {
    expect(() => makeChunk({ extra: 'x' })).toThrow()
    expect(() => makeChunk({ kind: 'section' })).toThrow()
  })
})

function makeChunk(fields: Record<string, unknown>): Chunk {
  return ChunkSchema.parse({
    celex: '32024R1689',
    act: 'AI Act',
    lang: 'en',
    elementId: '014.001',
    kind: 'paragraph',
    article: 14,
    heading: 'Human oversight',
    text: 'Body.',
    ...fields,
  })
}

const isElement = (node: Node): node is Element => node.nodeType === 1

function* iter(el: Element, tag: string): Generator<Element> {
  if (el.namespaceURI === XHTML && el.localName === tag) yield el
  for (const child of [...el.childNodes].filter(isElement)) yield* iter(child, tag)
}

async function annexHeadings(path: string): Promise<string[]> {
  return [...iter(parseXhtml(await readFile(path)), 'div')]
    .filter((div) => /^anx_[IVXLC]+$/.test(div.getAttribute('id') ?? ''))
    .flatMap((div) => [...iter(div, 'p')])
    .filter((p) => split(p.getAttribute('class') ?? '').includes('oj-ti-grseq-1'))
    .map((p) => split(p.textContent ?? '').join(' '))
}

function annexDocument(body: string): string {
  return (
    '<html xmlns="http://www.w3.org/1999/xhtml"><body><div id="anx_IV">' +
    `<p class="oj-doc-ti">ANNEX IV</p><p class="oj-doc-ti">Title</p>${body}</div></body></html>`
  )
}

function sectionHeading(text: string): string {
  return `<p class="oj-ti-grseq-1">${text}</p>`
}

function para(text: string): string {
  return `<p class="oj-normal">${text}</p>`
}

function item(label: string, ...content: string[]): string {
  return (
    `<table><col/><col/><tbody><tr><td>${para(label)}</td>` +
    `<td>${content.join('')}</td></tr></tbody></table>`
  )
}

function dash(text: string): string {
  return item('—', para(text))
}

function doc(body: string): string {
  return `<html xmlns="${XHTML}"><body>${body}</body></html>`
}
