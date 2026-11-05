// PDF layouts for generated invoices (SPEC § 1): one Polish, one German.
//
// The seller's country picks the layout. Amounts, quantities and dates are printed the way the
// country writes them (`1 234,56` and `2026-03-14` in PL, `1.234,56` and `14.03.2026` in DE); an
// absent issue date is not printed at all. `vatGroups` is the per-rate summary as printed, so a
// generator can print a wrong VAT amount without the layout computing anything. Every page is
// marked "SAMPLE / FICTIONAL". Output is byte-identical for the same input: the document info has
// a fixed date (so the file id is fixed) and the font is the vendored Noto Sans (OFL, fonts/OFL.txt).
import { readFile } from 'node:fs/promises'
import PdfDocument from 'pdfkit'
import type { Decimal } from '../decimal.ts'
import type { Invoice, Party } from './schema.ts'

export const SAMPLE_MARK = 'SAMPLE / FICTIONAL'
const FONT = 'NotoSans'
const FONT_BOLD = 'NotoSans-Bold'
const MARK_COLOR = '#b42318'
const RULE_COLOR = '#98a2b3'
const HEAD_FILL = '#eaecf0'
const MM = 72 / 25.4
const PAGE_WIDTH = 595.2756
const PAGE_HEIGHT = 841.8898
const LEFT = 17 * MM
const RIGHT = PAGE_WIDTH - 17 * MM
const TOP = 15 * MM
const BOTTOM = PAGE_HEIGHT - 20 * MM
// A fixed creation date keeps the output byte-identical.
const CREATED = new Date(Date.UTC(2000, 0, 1))
// Noto Sans ascent per point of font size (2189 of 2048 units per em).
const NOTO_ASCENT = 2189 / 2048
const PAD_X = 6
const PAD_Y = 3

export interface VatGroup {
  readonly rate: string
  readonly net: Decimal
  readonly vat: Decimal
}

const gross = (group: VatGroup): Decimal => group.net.plus(group.vat)

let fonts: Promise<[Buffer, Buffer]> | undefined

function loadFonts(): Promise<[Buffer, Buffer]> {
  fonts ??= Promise.all([
    readFile(new URL('./fonts/NotoSans-Regular.ttf', import.meta.url)),
    readFile(new URL('./fonts/NotoSans-Bold.ttf', import.meta.url)),
  ])
  return fonts
}

// Grouped with commas (to 2 places for money), then the country's separators.
function grouped(value: Decimal, thousands: string, decimalSep: string, places?: number): string {
  return value
    .toFixed(places, true)
    .replaceAll(',', '\0')
    .replaceAll('.', decimalSep)
    .replaceAll('\0', thousands)
}

interface Locale {
  thousands: string
  decimalSep: string
  date: (iso: string) => string
  exempt: Record<string, string>
}

const money = (locale: Locale, value: Decimal): string =>
  grouped(value, locale.thousands, locale.decimalSep, 2)
const quantity = (locale: Locale, value: Decimal): string =>
  grouped(value, locale.thousands, locale.decimalSep)
const rateText = (locale: Locale, rate: string): string =>
  Object.hasOwn(locale.exempt, rate) ? locale.exempt[rate]! : `${rate} %`

const PL: Locale = {
  thousands: ' ',
  decimalSep: ',',
  date: (iso) => iso,
  exempt: { zw: 'zw', np: 'np' },
}
const DE: Locale = {
  thousands: '.',
  decimalSep: ',',
  date: (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`,
  exempt: { zw: 'steuerfrei', np: 'n. st.' },
}

interface Style {
  font: string
  size: number
  leading: number
  color: string
}

const BASE: Style = { font: FONT, size: 9, leading: 12, color: 'black' }
const SMALL: Style = { ...BASE, size: 8, leading: 10 }
const BOLD: Style = { ...BASE, font: FONT_BOLD }
const TITLE: Style = { ...BASE, font: FONT_BOLD, size: 16, leading: 20 }
const MARK: Style = { ...BASE, font: FONT_BOLD, size: 11, color: MARK_COLOR }

type Align = 'left' | 'right'

interface TableSpec {
  rows: string[][]
  widths: number[]
  align: (column: number) => Align
  font: (row: number, column: number) => [string, number]
  hAlign: Align
  head: boolean
  rules: boolean
  leftPadding?: number
  wrap?: number
}

type Block = { paragraph: string; style: Style } | { spacer: number } | { table: TableSpec }

const p = (paragraph: string, style: Style): Block => ({ paragraph, style })
const spacer = (millimetres: number): Block => ({ spacer: millimetres * MM })

// One flow of blocks down the frame, a new page when a block does not fit.
class Flow {
  readonly doc: PDFKit.PDFDocument
  y = TOP

  constructor(doc: PDFKit.PDFDocument) {
    this.doc = doc
  }

  #room(height: number): void {
    if (this.y + height <= BOTTOM || this.y === TOP) return
    this.doc.addPage()
    this.y = TOP
  }

  paragraph(text: string, style: Style): void {
    const { doc } = this
    doc.font(style.font).fontSize(style.size).fillColor(style.color)
    const options = { width: RIGHT - LEFT, lineGap: style.leading - doc.currentLineHeight(true) }
    const height = doc.heightOfString(text, options)
    this.#room(height)
    doc.text(text, LEFT, this.y, options)
    this.y += height
  }

  table(spec: TableSpec): void {
    const { doc } = this
    const total = spec.widths.reduce((sum, width) => sum + width, 0)
    const left = spec.hAlign === 'right' ? RIGHT - total : LEFT
    for (const [r, row] of spec.rows.entries()) {
      const heights = row.map((cell, c) => {
        const [font, size] = spec.font(r, c)
        doc.font(font).fontSize(size)
        const width = spec.widths[c]! - 2 * PAD_X
        return c === spec.wrap && r > 0 ? doc.heightOfString(cell, { width }) : size * 1.2
      })
      const height = Math.max(...heights) + 2 * PAD_Y
      this.#room(height)
      if (spec.head && r === 0) doc.rect(left, this.y, total, height).fill(HEAD_FILL)
      let x = left
      for (const [c, cell] of row.entries()) {
        const [font, size] = spec.font(r, c)
        doc.font(font).fontSize(size).fillColor('black')
        const width = spec.widths[c]!
        const top = this.y + (height - heights[c]!) / 2
        const pad = c === 0 && spec.leftPadding !== undefined ? spec.leftPadding : PAD_X
        if (c === spec.wrap && r > 0) {
          doc.text(cell, x + pad, top, { width: width - 2 * PAD_X })
        } else if (spec.align(c) === 'right') {
          doc.text(cell, x + width - PAD_X - doc.widthOfString(cell), top, { lineBreak: false })
        } else {
          doc.text(cell, x + pad, top, { lineBreak: false })
        }
        x += width
      }
      this.y += height
      if (spec.rules) {
        doc
          .moveTo(left, this.y)
          .lineTo(left + total, this.y)
          .lineWidth(0.5)
          .strokeColor(RULE_COLOR)
          .stroke()
      }
    }
  }
}

function linesTable(invoice: Invoice, locale: Locale, header: string[]): Block {
  const rows = [header]
  for (const [i, line] of invoice.lines.entries()) {
    rows.push([
      String(i + 1),
      line.description,
      quantity(locale, line.quantity),
      money(locale, line.unit_net!),
      rateText(locale, line.vat_rate!),
      money(locale, line.net!),
    ])
  }
  return {
    table: {
      rows,
      widths: [10, 72, 18, 28, 20, 28].map((width) => width * MM),
      align: (column) => (column >= 2 ? 'right' : 'left'),
      font: (row) => (row === 0 ? [FONT_BOLD, 8] : [FONT, 9]),
      hAlign: 'left',
      head: true,
      rules: true,
      wrap: 1,
    },
  }
}

function summaryTable(rows: string[][], widths: number[]): Block {
  const last = rows.length - 1
  return {
    table: {
      rows,
      widths: widths.map((width) => width * MM),
      align: () => 'right',
      font: (row) => {
        if (row === 0) return [FONT_BOLD, 8]
        return row === last ? [FONT_BOLD, 9] : [FONT, 9]
      },
      hAlign: 'right',
      head: true,
      rules: true,
    },
  }
}

function partyBlock(label: string, party: Party, country: string, taxLabel: string): Block[] {
  return [
    p(label, BOLD),
    p(party.name ?? '', BASE),
    p(party.address ?? '', BASE),
    p(country, BASE),
    p(`${taxLabel} ${party.tax_id ?? 'None'}`, BASE),
  ]
}

const total = (locale: Locale, value: Decimal | null): string => money(locale, value!)

function polish(invoice: Invoice, groups: readonly VatGroup[]): Block[] {
  const loc = PL
  const dates: Block[] = []
  if (invoice.issue_date !== null) {
    dates.push(p(`Data wystawienia: ${loc.date(invoice.issue_date)}`, BASE))
  }
  if (invoice.sale_date !== null) {
    dates.push(p(`Data sprzedaży: ${loc.date(invoice.sale_date)}`, BASE))
  }
  const lines = linesTable(invoice, loc, [
    'Lp.',
    'Nazwa towaru lub usługi',
    'Ilość',
    'Cena jedn. netto',
    'Stawka VAT',
    'Wartość netto',
  ])
  const summary = [['Stawka VAT', 'Wartość netto', 'Kwota VAT', 'Wartość brutto']]
  for (const group of groups) {
    summary.push([
      rateText(loc, group.rate),
      money(loc, group.net),
      money(loc, group.vat),
      money(loc, gross(group)),
    ])
  }
  summary.push([
    'Razem',
    total(loc, invoice.total_net),
    total(loc, invoice.total_vat),
    total(loc, invoice.total_gross),
  ])
  return [
    p(`${SAMPLE_MARK} – dokument przykładowy, dane fikcyjne`, MARK),
    spacer(4),
    p(`Faktura VAT nr ${invoice.number ?? 'None'}`, TITLE),
    spacer(2),
    ...dates,
    spacer(6),
    ...partyBlock('Sprzedawca', invoice.seller, 'Polska', 'NIP:'),
    spacer(4),
    ...partyBlock('Nabywca', invoice.buyer, 'Polska', 'NIP:'),
    spacer(6),
    p(`Waluta: ${invoice.currency ?? 'None'}`, SMALL),
    spacer(2),
    lines,
    spacer(6),
    summaryTable(summary, [26, 30, 30, 30]),
    spacer(6),
    p(`Do zapłaty: ${total(loc, invoice.total_gross)} ${invoice.currency ?? 'None'}`, TITLE),
    spacer(2),
    p('Termin płatności: 14 dni', BASE),
  ]
}

function german(invoice: Invoice, groups: readonly VatGroup[]): Block[] {
  const loc = DE
  const { seller } = invoice
  const sender = `${seller.name ?? 'None'} · ${seller.address ?? 'None'} · Deutschland`
  const info = [['Rechnungsnummer:', invoice.number ?? '']]
  if (invoice.issue_date !== null) info.push(['Rechnungsdatum:', loc.date(invoice.issue_date)])
  if (invoice.sale_date !== null) info.push(['Leistungsdatum:', loc.date(invoice.sale_date)])
  info.push(['Unsere USt-IdNr.:', seller.tax_id ?? ''])
  const lines = linesTable(invoice, loc, [
    'Pos.',
    'Bezeichnung',
    'Menge',
    'Einzelpreis',
    'USt.',
    'Gesamt netto',
  ])
  const totals = [['', `Betrag (${invoice.currency ?? 'None'})`]]
  totals.push(['Nettobetrag', total(loc, invoice.total_net)])
  for (const group of groups) {
    totals.push([
      `zzgl. USt. ${rateText(loc, group.rate)} auf ${money(loc, group.net)}`,
      money(loc, group.vat),
    ])
  }
  totals.push(['Umsatzsteuer gesamt', total(loc, invoice.total_vat)])
  totals.push(['Rechnungsbetrag', total(loc, invoice.total_gross)])
  return [
    p(`${SAMPLE_MARK} – Musterdokument, fiktive Daten`, MARK),
    spacer(4),
    p(sender, SMALL),
    spacer(4),
    ...partyBlock('Rechnungsempfänger', invoice.buyer, 'Deutschland', 'Ihre USt-IdNr.:'),
    spacer(8),
    p('Rechnung', TITLE),
    spacer(2),
    {
      table: {
        rows: info,
        widths: [36 * MM, 40 * MM],
        align: () => 'left',
        font: (_row, column) => (column === 0 ? [FONT_BOLD, 9] : [FONT, 9]),
        hAlign: 'left',
        head: false,
        rules: false,
        leftPadding: 0,
      },
    },
    spacer(4),
    p(`Alle Beträge in ${invoice.currency ?? 'None'}.`, SMALL),
    spacer(2),
    lines,
    spacer(6),
    summaryTable(totals, [70, 34]),
    spacer(6),
    p('Zahlbar innerhalb von 14 Tagen ohne Abzug.', BASE),
    spacer(2),
    p(
      `${seller.name ?? 'None'} · ${seller.address ?? 'None'} · USt-IdNr.: ${seller.tax_id ?? 'None'}`,
      SMALL,
    ),
  ]
}

const LAYOUTS: Record<string, (invoice: Invoice, groups: readonly VatGroup[]) => Block[]> = {
  PL: polish,
  DE: german,
}

function footer(doc: PDFKit.PDFDocument): void {
  doc.font(FONT_BOLD).fontSize(8).fillColor(MARK_COLOR)
  const x = (PAGE_WIDTH - doc.widthOfString(SAMPLE_MARK)) / 2
  // pdfkit places text by its top; the baseline sits 10 mm above the page bottom.
  const top = PAGE_HEIGHT - 10 * MM - NOTO_ASCENT * 8
  doc.text(SAMPLE_MARK, x, top, { lineBreak: false })
}

export async function renderPdf(invoice: Invoice, vatGroups: readonly VatGroup[]): Promise<Buffer> {
  const layout = LAYOUTS[invoice.seller.country ?? '']
  if (layout === undefined) throw new Error(`no layout for ${String(invoice.seller.country)}`)
  const [regular, bold] = await loadFonts()
  const doc = new PdfDocument({
    size: 'A4',
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    bufferPages: true,
    info: {
      Title: `${SAMPLE_MARK} ${invoice.number ?? 'None'}`,
      Author: 'Mokosz generator',
      Creator: 'Mokosz',
      Producer: 'Mokosz',
      CreationDate: CREATED,
    },
  })
  const chunks: Buffer[] = []
  doc.on('data', (chunk: Buffer) => chunks.push(chunk))
  const ended = new Promise<void>((resolve) => doc.on('end', resolve))
  doc.registerFont(FONT, regular)
  doc.registerFont(FONT_BOLD, bold)
  const flow = new Flow(doc)
  for (const block of layout(invoice, vatGroups)) {
    if ('paragraph' in block) flow.paragraph(block.paragraph, block.style)
    else if ('spacer' in block) flow.y += block.spacer
    else flow.table(block.table)
  }
  const { start, count } = doc.bufferedPageRange()
  for (let page = start; page < start + count; page++) {
    doc.switchToPage(page)
    footer(doc)
  }
  doc.end()
  await ended
  return Buffer.concat(chunks)
}
