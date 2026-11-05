import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DOMParser, MIME_TYPE, ParseError, type Element, type Node } from '@xmldom/xmldom'
import { z } from 'zod'
import { ACTS, LANGUAGES, LangSchema, type Lang } from './acts.ts'
import { rawPath } from './fetch.ts'

export const KindSchema = z.enum(['paragraph', 'point', 'recital', 'annex'])
export type Kind = z.infer<typeof KindSchema>

export const ChunkSchema = z
  .strictObject({
    celex: z.string(),
    act: z.string(),
    lang: LangSchema,
    elementId: z.string(),
    kind: KindSchema,
    article: z.int().nullable(),
    heading: z.string().nullable(),
    text: z.string(),
  })
  .readonly()
export type Chunk = z.infer<typeof ChunkSchema>

export function citationKey(chunk: Chunk): string {
  return `${chunk.celex}#${chunk.elementId}`
}

export class ChunkingError extends Error {
  override readonly name = 'ChunkingError'
}

const NS = 'http://www.w3.org/1999/xhtml'
const ELEMENT = 1
const TEXT = 3
const CDATA = 4
const BLOCK_TAGS = new Set([
  'p',
  'div',
  'table',
  'tr',
  'td',
  'th',
  'li',
  'ul',
  'ol',
  'hr',
  'br',
  'col',
])
const ROW_GROUPS = new Set(['tbody', 'thead', 'tfoot'])

const UNIT_ID = /^(?:rct_(\d+)|art_(\d+)|anx_([IVXLC]+))$/
const PARAGRAPH_ID = /^(\d{3})\.\d{3}$/
const POINT_LABEL = /^\(?(?:\d+|[a-z]+)\)$/
const WHOLE_NUMBER = /^\d+$/

// NIS2 Annexes I and II are sector tables chunked per top-level row (SPEC § 1, rule 4).
const ROW_SPLIT_ANNEXES = new Set(['32022L2555 I', '32022L2555 II'])

const LABELS = {
  article: { en: 'Article', pl: 'Artykuł' },
  recital: { en: 'Recital', pl: 'Motyw' },
  annex: { en: 'Annex', pl: 'Załącznik' },
} as const

function isElement(node: Node): node is Element {
  return node.nodeType === ELEMENT
}

function* iter(el: Element): Generator<Element> {
  yield el
  for (const child of children(el)) yield* iter(child)
}

function ancestors(el: Element): Element[] {
  const found: Element[] = []
  for (let node = el.parentNode; node !== null && isElement(node); node = node.parentNode) {
    found.push(node)
  }
  return found
}

function is(el: Element, tag: string): boolean {
  return el.namespaceURI === NS && el.localName === tag
}

function attr(el: Element, name: string): string {
  return el.getAttributeNS(null, name) ?? ''
}

function words(text: string): string[] {
  return text.split(/\s+/).filter((word) => word !== '')
}

function classes(el: Element): string[] {
  return words(attr(el, 'class'))
}

function isText(node: Node): boolean {
  return node.nodeType === TEXT || node.nodeType === CDATA
}

// Only the text nodes before the next node of any other kind, so text after a comment or a
// processing instruction belongs to no element.
function leadingText(el: Element): string {
  let text = ''
  for (const node of el.childNodes) {
    if (!isText(node)) break
    text += node.nodeValue ?? ''
  }
  return text
}

function tail(el: Element): string {
  let text = ''
  for (let node = el.nextSibling; node !== null && isText(node); node = node.nextSibling) {
    text += node.nodeValue ?? ''
  }
  return text
}

function children(el: Element): Element[] {
  return [...el.childNodes].filter(isElement)
}

function isBlank(text: string): boolean {
  return text.trim() === ''
}

function texts(el: Element, out: string[]): void {
  out.push(leadingText(el))
  for (const child of children(el)) {
    const block = child.namespaceURI === NS && BLOCK_TAGS.has(child.localName ?? '')
    if (block) out.push(' ')
    texts(child, out)
    if (block) out.push(' ')
    out.push(tail(child))
  }
}

function flat(el: Element): string {
  const out: string[] = []
  texts(el, out)
  return words(out.join('')).join(' ')
}

function rows(table: Element): Element[] {
  const found: Element[] = []
  for (const child of children(table)) {
    if (is(child, 'tr')) found.push(child)
    else if (child.namespaceURI === NS && ROW_GROUPS.has(child.localName ?? '')) {
      found.push(...children(child).filter((row) => is(row, 'tr')))
    }
  }
  return found
}

function cells(row: Element): Element[] {
  return children(row).filter((cell) => is(cell, 'td'))
}

function isDataTable(el: Element): boolean {
  return is(el, 'table') && classes(el).includes('oj-table')
}

function rowText(rowCells: Element[]): string {
  return words(rowCells.map(flat).join(' | ')).join(' ')
}

function lines(el: Element): string[] {
  if (isDataTable(el)) return rows(el).map((row) => rowText(cells(row)))
  const kids = children(el)
  const wrapper =
    is(el, 'div') &&
    kids.length > 0 &&
    isBlank(leadingText(el)) &&
    kids.every((child) => isBlank(tail(child)))
  if (wrapper) return kids.flatMap(lines)
  const text = flat(el)
  return text ? [text] : []
}

function blockText(blocks: Element[]): string {
  return blocks.flatMap(lines).join('\n')
}

function singleRowCells(el: Element): Element[] | null {
  if (!is(el, 'table') || isDataTable(el)) return null
  const found = rows(el)
  if (found.length !== 1) return null
  const own = cells(found[0]!)
  return own.length === 2 ? own : null
}

function isPoint(el: Element): boolean {
  const own = singleRowCells(el)
  return own !== null && POINT_LABEL.test(flat(own[0]!))
}

function isSectionHeading(el: Element): boolean {
  return is(el, 'p') && classes(el).includes('oj-ti-grseq-1')
}

function isDashItem(el: Element): boolean {
  const own = singleRowCells(el)
  return own !== null && flat(own[0]!) === '—'
}

function isHeaderRow(rowCells: Element[]): boolean {
  const paragraphs = rowCells.flatMap((cell) => [...iter(cell)].filter((el) => is(el, 'p')))
  return paragraphs.length > 0 && paragraphs.every((p) => classes(p).includes('oj-tbl-hdr'))
}

function rowspan(cell: Element): number {
  const text = (attr(cell, 'rowspan') || '1').trim()
  if (!WHOLE_NUMBER.test(text)) {
    throw new ChunkingError(`rowspan ${JSON.stringify(text)} is not a whole number`)
  }
  return Number(text)
}

function sectorRows(table: Element): Element[][] {
  const spanning = new Map<number, [Element, number]>()
  const result: Element[][] = []
  for (const row of rows(table)) {
    const own = cells(row)
    if (isHeaderRow(own)) continue
    const rowCells: Element[] = []
    let col = 0
    let next = 0
    while (next < own.length || [...spanning.keys()].some((c) => c >= col)) {
      const span = spanning.get(col)
      if (span !== undefined) {
        const [cell, left] = span
        rowCells.push(cell)
        if (left > 1) spanning.set(col, [cell, left - 1])
        else spanning.delete(col)
      } else if (next < own.length) {
        const cell = own[next]!
        rowCells.push(cell)
        const height = rowspan(cell)
        if (height > 1) spanning.set(col, [cell, height - 1])
        next += 1
      }
      col += 1
    }
    result.push(rowCells)
  }
  if (spanning.size > 0) throw new ChunkingError('a rowspan runs past the end of its table')
  return result
}

function units(root: Element): [Element, RegExpExecArray][] {
  const found: [Element, RegExpExecArray][] = []
  for (const el of iter(root)) {
    if (!is(el, 'div')) continue
    const match = UNIT_ID.exec(attr(el, 'id'))
    if (match === null) continue
    if (ancestors(el).some((a) => UNIT_ID.test(attr(a, 'id')))) {
      throw new ChunkingError(`${el.getAttributeNS(null, 'id')} is nested inside another unit`)
    }
    found.push([el, match])
  }
  return found
}

class Builder {
  readonly chunks: Chunk[] = []
  readonly celex: string
  readonly act: string
  readonly lang: Lang

  constructor(celex: string, act: string, lang: Lang) {
    this.celex = celex
    this.act = act
    this.lang = lang
  }

  add(
    elementId: string,
    kind: Kind,
    article: number | null,
    heading: string | null,
    text: string,
  ): void {
    if (!text) throw new ChunkingError(`${this.celex}#${elementId} (${this.lang}) has no text`)
    const { celex, act, lang } = this
    this.chunks.push(
      ChunkSchema.parse({ celex, act, lang, elementId, kind, article, heading, text }),
    )
  }

  recital(el: Element): void {
    this.add(attr(el, 'id'), 'recital', null, null, blockText([el]))
  }

  article(el: Element, number: number): void {
    let heading: string | null = null
    const body: Element[] = []
    for (const child of children(el)) {
      const own = classes(child)
      if (own.includes('oj-ti-art')) continue
      if (own.includes('eli-title')) {
        heading = flat(child)
        continue
      }
      body.push(child)
    }
    if (!heading) throw new ChunkingError(`${this.celex} art_${number} (${this.lang}) has no title`)
    const paragraphIds: string[] = []
    for (const d of [...iter(el)].slice(1)) {
      const match = PARAGRAPH_ID.exec(attr(d, 'id'))
      if (match !== null && Number(match[1]) === number) paragraphIds.push(match[0])
    }
    if (paragraphIds.length > 0) this.rule1(body, number, heading, paragraphIds)
    else this.rule2(body, number, heading)
  }

  rule1(body: Element[], number: number, heading: string, paragraphIds: string[]): void {
    const ids = body.map((child) => child.getAttributeNS(null, 'id'))
    if (ids.length !== paragraphIds.length || ids.some((id, i) => id !== paragraphIds[i])) {
      throw new ChunkingError(
        `${this.celex} art_${number} (${this.lang}) mixes paragraph ids with other blocks`,
      )
    }
    for (const child of body) {
      this.add(attr(child, 'id'), 'paragraph', number, heading, blockText([child]))
    }
  }

  rule2(body: Element[], number: number, heading: string): void {
    const firstPoint = body.findIndex(isPoint)
    if (firstPoint === -1) {
      body.forEach((child, i) => {
        this.add(`art_${number}.p_${i + 1}`, 'paragraph', number, heading, blockText([child]))
      })
      return
    }
    if (firstPoint > 0) {
      this.add(
        `art_${number}.p_0`,
        'paragraph',
        number,
        heading,
        blockText(body.slice(0, firstPoint)),
      )
    }
    body.slice(firstPoint).forEach((child, i) => {
      if (!isPoint(child)) {
        throw new ChunkingError(
          `${this.celex} art_${number} (${this.lang}) has a block after its points`,
        )
      }
      this.add(`art_${number}.pt_${i + 1}`, 'point', number, heading, blockText([child]))
    })
  }

  annex(el: Element, roman: string): void {
    const titles: Element[] = []
    const body: Element[] = []
    for (const child of children(el)) {
      const own = classes(child)
      if (own.includes('oj-doc-ti')) titles.push(child)
      else if (!own.includes('oj-note')) body.push(child)
    }
    const heading = titles.length > 1 ? flat(titles[1]!) : ''
    if (!heading) throw new ChunkingError(`${this.celex} anx_${roman} (${this.lang}) has no title`)
    if (ROW_SPLIT_ANNEXES.has(`${this.celex} ${roman}`)) {
      if (body.length !== 1 || !isDataTable(body[0]!)) {
        throw new ChunkingError(
          `${this.celex} anx_${roman} (${this.lang}) is not a single sector table`,
        )
      }
      sectorRows(body[0]!).forEach((rowCells, j) => {
        this.add(`anx_${roman}.r_${j + 1}`, 'annex', null, heading, rowText(rowCells))
      })
      return
    }
    this.annexGroups(body, roman).forEach((group, k) => {
      this.add(`anx_${roman}.p_${k + 1}`, 'annex', null, heading, blockText(group))
    })
  }

  annexGroups(body: Element[], roman: string): Element[][] {
    const groups: Element[][] = []
    let openHeading = false
    for (const child of body) {
      if (openHeading || (isDashItem(child) && groups.length > 0)) groups.at(-1)!.push(child)
      else if (isDashItem(child)) {
        throw new ChunkingError(`${this.celex} anx_${roman} (${this.lang}) starts with a dash item`)
      } else groups.push([child])
      openHeading = isSectionHeading(child)
    }
    if (openHeading) {
      throw new ChunkingError(
        `${this.celex} anx_${roman} (${this.lang}) ends with a section heading`,
      )
    }
    return groups
  }
}

const DECLARED_ENCODING =
  /^<\?xml[\t\n\r ]+version[\t\n\r ]*=[\t\n\r ]*(["'])[^"']*\1[\t\n\r ]+encoding[\t\n\r ]*=[\t\n\r ]*(["'])([A-Za-z][A-Za-z0-9._-]*)\2/
const ASCII = new Set(['us-ascii', 'ascii'])
const ISO_8859 = /^(?:iso[-_]?8859-(\d+)|latin1|l1)$/

function bytesToCodePoints(source: Uint8Array): string {
  let text = ''
  for (const byte of source) text += String.fromCharCode(byte)
  return text
}

// TextDecoder reads some ISO-8859 labels as the windows-125x code page; the two agree except on
// 0x80-0x9F, which ISO-8859 maps to the C1 controls.
function decodeIso8859(part: string, source: Uint8Array): string {
  const c1 = source.map((byte) => (byte >= 0x80 && byte <= 0x9f ? 0x20 : byte))
  const text = new TextDecoder(`iso-8859-${part}`, { fatal: true }).decode(c1)
  let out = ''
  for (let i = 0; i < source.length; i++) {
    const byte = source[i]!
    out += byte >= 0x80 && byte <= 0x9f ? String.fromCharCode(byte) : text[i]
  }
  return out
}

function decodeWith(encoding: string, source: Uint8Array): string {
  if (encoding === 'utf-8' || encoding === 'utf8') {
    return new TextDecoder('utf-8', { fatal: true }).decode(source)
  }
  if (ASCII.has(encoding)) {
    if (source.some((byte) => byte > 0x7f)) throw new Error('input is not proper US-ASCII')
    return bytesToCodePoints(source)
  }
  const iso = ISO_8859.exec(encoding)
  if (iso !== null && iso[1] !== '12') return decodeIso8859(iso[1] ?? '1', source)
  throw new Error(`unsupported encoding ${encoding}`)
}

// A UTF-16 BOM or the UTF-16 form of "<?", else the declared encoding (also after a UTF-8 BOM),
// else UTF-8.
function decode(source: Uint8Array): string {
  const [a, b, c, d] = source
  if ((a === 0xff && b === 0xfe) || (a === 0x3c && b === 0 && c === 0x3f && d === 0)) {
    return new TextDecoder('utf-16le', { fatal: true }).decode(source)
  }
  if ((a === 0xfe && b === 0xff) || (a === 0 && b === 0x3c && c === 0 && d === 0x3f)) {
    return new TextDecoder('utf-16be', { fatal: true }).decode(source)
  }
  const body = a === 0xef && b === 0xbb && c === 0xbf ? source.subarray(3) : source
  const head = bytesToCodePoints(body.subarray(0, 256))
  const declared = DECLARED_ENCODING.exec(head)?.[3]?.toLowerCase() ?? 'utf-8'
  return decodeWith(declared, body)
}

const NOT_CHAR = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u
const MARKUP_OR_CDATA_END =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE(?:[^>[]|\[[\s\S]*?\])*>|<(?:[^>"']|"[^"]*"|'[^']*')*>|(\]\]>)/g

// XML 1.0 well-formedness that xmldom does not check: the Char production in text and attribute
// values (raw or from character references; xmldom rejects it in markup), and "]]>" in character data.
function checkCharacters(node: Node): void {
  if (isText(node) && NOT_CHAR.test(node.nodeValue ?? '')) {
    throw new Error('character outside the XML Char production')
  }
  if (isElement(node)) {
    for (const attribute of node.attributes) {
      if (NOT_CHAR.test(attribute.value)) {
        throw new Error('character outside the XML Char production')
      }
    }
  }
  for (const child of node.childNodes) checkCharacters(child)
}

function wellFormed(text: string): Element {
  for (const match of text.matchAll(MARKUP_OR_CDATA_END)) {
    if (match[1] !== undefined) throw new Error("']]>' in character data")
  }
  const parser = new DOMParser({
    // XML 1.0 line ends; the default also maps U+0085, U+2028 and U+2029 (XML 1.1).
    normalizeLineEndings: (source) => source.replace(/\r\n?/g, '\n'),
    // xmldom recovers from some malformed input with only a warning.
    onError: (level, message) => {
      // A literal U+FFFD is text; invalid bytes were already rejected by the fatal decoder.
      if (level === 'warning' && message.startsWith('Unicode replacement character detected'))
        return
      throw new Error(`${level}: ${message}`)
    },
  })
  const root = parser.parseFromString(text, MIME_TYPE.XML_TEXT).documentElement
  if (root === null) throw new Error('no document element')
  checkCharacters(root)
  return root
}

export function parseXhtml(source: Uint8Array): Element {
  try {
    return wellFormed(decode(source))
  } catch (error) {
    if (error instanceof ParseError) throw error
    throw new ParseError(
      error instanceof Error ? error.message : String(error),
      undefined,
      error instanceof Error ? error : undefined,
    )
  }
}

export async function chunkAct(
  path: string,
  celex: string,
  act: string,
  lang: Lang,
): Promise<Chunk[]> {
  const root = parseXhtml(await readFile(path))
  const builder = new Builder(celex, act, lang)
  for (const [el, match] of units(root)) {
    const [, recital, article, annex] = match
    if (recital !== undefined) builder.recital(el)
    else if (article !== undefined) builder.article(el, Number(article))
    else builder.annex(el, annex!)
  }
  return builder.chunks
}

// The committed embeddings were computed with this placeholder for a missing heading or article.
const MISSING = 'None'
const orMissing = (value: string | number | null): string =>
  value === null ? MISSING : String(value)

export function embeddingText(chunk: Chunk): string {
  if (chunk.kind === 'recital') {
    const number = chunk.elementId.replace(/^rct_/, '')
    return `${chunk.act} ${LABELS.recital[chunk.lang]} ${number}\n${chunk.text}`
  }
  if (chunk.kind === 'annex') {
    const roman = chunk.elementId.replace(/^anx_/, '').split('.')[0]!
    const label = LABELS.annex[chunk.lang]
    return `${chunk.act} ${label} ${roman} ${orMissing(chunk.heading)}\n${chunk.text}`
  }
  const label = LABELS.article[chunk.lang]
  return `${chunk.act} ${label} ${orMissing(chunk.article)} ${orMissing(chunk.heading)}\n${chunk.text}`
}

export async function loadCorpus(root: string): Promise<Chunk[]> {
  const rawDir = join(root, 'data', 'raw')
  const corpus: Chunk[] = []
  for (const [celex, act] of ACTS) {
    for (const lang of LANGUAGES) {
      corpus.push(...(await chunkAct(rawPath(rawDir, celex, lang), celex, act, lang)))
    }
  }
  return corpus
}
