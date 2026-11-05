import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { main } from '../../src/cli.ts'
import { Decimal } from '../../src/decimal.ts'
import { ExtractedInvoice, validate } from '../../src/invoices/index.ts'
import {
  GenerationError,
  generate,
  sameInvoice,
  selfCheck,
  writeSet,
} from '../../src/invoices/generator.ts'
import { nipValid, ustIdnrValid } from '../../src/invoices/taxid.ts'
import { pdfLines } from './pdf-text.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')
const COMMITTED = join(ROOT, 'data', 'invoices')
const CLI = join(ROOT, 'src', 'cli.ts')
const execute = (file: string, args: string[], cwd: string) =>
  promisify(execFile)(file, args, { cwd })
const MARK = 'SAMPLE / FICTIONAL'
const EXPECTED_RULE: Record<number, string> = {
  1: 'lines_total',
  2: 'vat_total',
  3: 'tax_id',
  4: 'required_fields',
  5: 'vat_rate_country',
}
const CURRENCY: Record<string, string> = { PL: 'PLN', DE: 'EUR' }
const TAX_ID_CHECK: Record<string, (value: string) => boolean> = {
  PL: nipValid,
  DE: ustIdnrValid,
}
const RATES: Record<string, Set<string>> = {
  PL: new Set(['23', '8', '5', '0', 'zw', 'np']),
  DE: new Set(['19', '7', '0']),
}
const MONEY = /^-?[0-9]+\.[0-9]{2}$/
const QUANTITY = /^[0-9]+(?:\.[0-9]+)?$/
const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/

interface Entry {
  id: string
  country: string
  defect: number | null
}

interface JsonLine {
  description: string
  quantity: string
  unit_net: string
  vat_rate: string
  net: string
}

interface JsonParty {
  name: string
  tax_id: string
  country: string
  address: string
}

interface JsonInvoice {
  number: string
  issue_date: string | null
  sale_date: string
  currency: string
  seller: JsonParty
  buyer: JsonParty
  lines: JsonLine[]
  total_net: string
  total_vat: string
  total_gross: string
}

interface Truth {
  invoice: JsonInvoice
  defect: number | null
  expected_failed_rules: string[]
}

const temporary: string[] = []

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mokosz-invoices-'))
  temporary.push(directory)
  return directory
}

let generated: string

beforeAll(async () => {
  generated = await scratch()
  await writeSet(generated)
})

afterAll(async () => {
  await Promise.all(temporary.map((directory) => rm(directory, { recursive: true, force: true })))
})

async function files(directory: string): Promise<Map<string, Buffer>> {
  const names = (await readdir(directory)).toSorted()
  const entries = await Promise.all(
    names.map(async (name) => [name, await readFile(join(directory, name))] as const),
  )
  return new Map(entries)
}

async function expectSameFiles(actual: string, expected: string): Promise<void> {
  const [mine, theirs] = [await files(actual), await files(expected)]
  expect([...mine.keys()]).toEqual([...theirs.keys()])
  for (const [name, bytes] of mine) {
    expect(bytes.equals(theirs.get(name)!), name).toBe(true)
  }
}

async function index(directory: string): Promise<Entry[]> {
  const entries: Entry[] = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8'))
  return entries
}

async function truth(directory: string, id: string): Promise<Truth> {
  const data: Truth = JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8'))
  return data
}

function grouped(whole: string, country: string): string {
  const groups: string[] = []
  let rest = whole
  while (rest.length > 3) {
    groups.unshift(rest.slice(-3))
    rest = rest.slice(0, -3)
  }
  groups.unshift(rest)
  return groups.join(country === 'PL' ? ' ' : '.')
}

function printedMoney(value: string | Decimal, country: string): string {
  const [whole = '', cents = ''] = new Decimal(String(value)).toFixed(2).split('.')
  return `${grouped(whole, country)},${cents}`
}

function printedQuantity(value: string, country: string): string {
  const [whole = '', fraction = ''] = value.split('.')
  return grouped(whole, country) + (fraction ? `,${fraction}` : '')
}

function printedRate(rate: string, country: string): string {
  if (rate === 'zw' || rate === 'np') {
    return country === 'PL' ? rate : { zw: 'steuerfrei', np: 'n. st.' }[rate]
  }
  return `${rate} %`
}

function printedDate(value: string, country: string): string {
  return country === 'PL'
    ? value
    : `${value.slice(8, 10)}.${value.slice(5, 7)}.${value.slice(0, 4)}`
}

function lineRows(invoice: JsonInvoice, country: string): string[] {
  return invoice.lines.map(
    (line, i) =>
      `${i + 1} ${line.description} ${printedQuantity(line.quantity, country)}` +
      ` ${printedMoney(line.unit_net, country)} ${printedRate(line.vat_rate, country)}` +
      ` ${printedMoney(line.net, country)}`,
  )
}

const rateValue = (rate: string): Decimal =>
  rate === 'zw' || rate === 'np' ? new Decimal(0) : new Decimal(rate)

const exempt = (rate: string): number => Number(rate === 'zw' || rate === 'np')

function rateGroups(invoice: JsonInvoice): [string, Decimal][] {
  const nets = new Map<string, Decimal>()
  for (const line of invoice.lines) {
    nets.set(line.vat_rate, (nets.get(line.vat_rate) ?? new Decimal(0)).plus(new Decimal(line.net)))
  }
  const order = [...nets.keys()].toSorted(
    (a, b) =>
      exempt(a) - exempt(b) || rateValue(b).cmp(rateValue(a)) || (a < b ? -1 : a > b ? 1 : 0),
  )
  return order.map((rate) => [rate, nets.get(rate)!])
}

function partyLines(label: string, party: JsonParty, countryName: string, tax: string): string[] {
  return [label, party.name, party.address, countryName, `${tax} ${party.tax_id}`]
}

function expectedPage(invoice: JsonInvoice, country: string): [string[], string[]] {
  const { seller, buyer, currency } = invoice
  const [net, vat, gross] = [invoice.total_net, invoice.total_vat, invoice.total_gross].map(
    (value) => printedMoney(value, country),
  )
  const issue = invoice.issue_date
  const sale = printedDate(invoice.sale_date, country)
  if (country === 'PL') {
    const before = [
      `${MARK} – dokument przykładowy, dane fikcyjne`,
      `Faktura VAT nr ${invoice.number}`,
      ...(issue ? [`Data wystawienia: ${printedDate(issue, country)}`] : []),
      `Data sprzedaży: ${sale}`,
      ...partyLines('Sprzedawca', seller, 'Polska', 'NIP:'),
      ...partyLines('Nabywca', buyer, 'Polska', 'NIP:'),
      `Waluta: ${currency}`,
      'Lp. Nazwa towaru lub usługi Ilość Cena jedn. netto Stawka VAT Wartość netto',
      ...lineRows(invoice, country),
      'Stawka VAT Wartość netto Kwota VAT Wartość brutto',
    ]
    const after = [
      `Razem ${net} ${vat} ${gross}`,
      `Do zapłaty: ${gross} ${currency}`,
      'Termin płatności: 14 dni',
      MARK,
    ]
    return [before, after]
  }
  const before = [
    `${MARK} – Musterdokument, fiktive Daten`,
    `${seller.name} · ${seller.address} · Deutschland`,
    ...partyLines('Rechnungsempfänger', buyer, 'Deutschland', 'Ihre USt-IdNr.:'),
    'Rechnung',
    `Rechnungsnummer: ${invoice.number}`,
    ...(issue ? [`Rechnungsdatum: ${printedDate(issue, country)}`] : []),
    `Leistungsdatum: ${sale}`,
    `Unsere USt-IdNr.: ${seller.tax_id}`,
    `Alle Beträge in ${currency}.`,
    'Pos. Bezeichnung Menge Einzelpreis USt. Gesamt netto',
    ...lineRows(invoice, country),
    `Betrag (${currency})`,
    `Nettobetrag ${net}`,
  ]
  const after = [
    `Umsatzsteuer gesamt ${vat}`,
    `Rechnungsbetrag ${gross}`,
    'Zahlbar innerhalb von 14 Tagen ohne Abzug.',
    `${seller.name} · ${seller.address} · USt-IdNr.: ${seller.tax_id}`,
    MARK,
  ]
  return [before, after]
}

function printedGroupVat(row: string, rate: string, net: Decimal, country: string): Decimal {
  const [shownRate, shownNet] = [printedRate(rate, country), printedMoney(net, country)]
  const prefix =
    country === 'PL' ? `${shownRate} ${shownNet} ` : `zzgl. USt. ${shownRate} auf ${shownNet} `
  expect(row.startsWith(prefix), `${row} | ${prefix}`).toBe(true)
  const rest = row.slice(prefix.length).split(' ')
  const end = rest.findIndex((token) => token.includes(',')) + 1
  const vat = new Decimal(rest.slice(0, end).join(' ').replace(/[ .]/g, '').replace(',', '.'))
  const tail = [printedMoney(vat, country)]
  if (country === 'PL') tail.push(printedMoney(net.plus(vat), country))
  expect(row, row).toBe(prefix + tail.join(' '))
  return vat
}

const halfUp = (value: Decimal): Decimal => value.quantize(new Decimal('0.01'), 'HALF_UP')

async function capturing(run: () => Promise<number>): Promise<{ code: number; output: string }> {
  let output = ''
  const capture = (chunk: unknown): boolean => {
    output += String(chunk)
    return true
  }
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(capture)
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(capture)
  try {
    return { code: await run(), output }
  } finally {
    out.mockRestore()
    err.mockRestore()
  }
}

async function sellerNames(directory: string): Promise<Set<string>> {
  const names = new Set<string>()
  for (const entry of await index(directory)) {
    names.add((await truth(directory, entry.id)).invoice.seller.name)
  }
  return names
}

describe('the generated invoice set', () => {
  test('two runs are byte identical', async () => {
    const again = await scratch()
    await writeSet(again)

    await expectSameFiles(again, generated)
  })

  test('the committed set is reproduced', async () => {
    await expectSameFiles(COMMITTED, generated)
  })

  test('counts per country and class', async () => {
    const entries = await index(generated)
    const names = new Set(await readdir(generated))
    const ids = entries.map((entry) => entry.id)

    expect(entries).toHaveLength(150)
    expect(new Set(ids).size).toBe(150)
    expect(names).toEqual(
      new Set(['index.json', ...ids.flatMap((id) => [`${id}.pdf`, `${id}.json`])]),
    )
    const count = (match: (entry: Entry) => boolean): number => entries.filter(match).length
    expect(count((entry) => entry.country === 'PL')).toBe(75)
    expect(count((entry) => entry.country === 'DE')).toBe(75)
    for (const country of ['PL', 'DE']) {
      expect(count((entry) => entry.country === country && entry.defect === null)).toBe(50)
      for (const defect of [1, 2, 3, 4, 5]) {
        expect(count((entry) => entry.country === country && entry.defect === defect)).toBe(5)
      }
    }
    for (const entry of entries) {
      expect((await truth(generated, entry.id)).defect).toBe(entry.defect)
    }
  })

  test('the ground truth is canonical', async () => {
    const numbers = new Set<string>()
    for (const entry of await index(generated)) {
      const data = await truth(generated, entry.id)
      const { invoice } = data
      const { country } = entry
      numbers.add(invoice.number)
      expect(Object.keys(data).toSorted()).toEqual(['defect', 'expected_failed_rules', 'invoice'])
      expect(invoice.currency).toBe(CURRENCY[country])
      expect([invoice.seller.country, invoice.buyer.country]).toEqual([country, country])
      expect(invoice.sale_date).toMatch(ISO_DATE)
      if (entry.defect === 4) expect(invoice.issue_date).toBeNull()
      else expect(invoice.issue_date).toMatch(ISO_DATE)
      expect(invoice.lines.length).toBeGreaterThanOrEqual(1)
      expect(invoice.lines.length).toBeLessThanOrEqual(6)
      for (const line of invoice.lines) {
        expect(line.quantity).toMatch(QUANTITY)
        expect(line.unit_net).toMatch(MONEY)
        expect(line.net).toMatch(MONEY)
        if (entry.defect !== 5) expect(RATES[country]!.has(line.vat_rate), line.vat_rate).toBe(true)
      }
      for (const total of [invoice.total_net, invoice.total_vat, invoice.total_gross]) {
        expect(total).toMatch(MONEY)
      }
    }
    expect(numbers.size).toBe(150)
  })

  test('clean invoices pass and defective ones fail exactly their rule', async () => {
    for (const entry of await index(generated)) {
      const data = await truth(generated, entry.id)
      const { defect } = entry
      const expected = defect === null ? [] : [EXPECTED_RULE[defect]]

      const result = validate(ExtractedInvoice.parse(data.invoice))
      const fields = result.failures.map((failure) => failure.fields)

      expect(data.expected_failed_rules, entry.id).toEqual(expected)
      expect(result.failedRules, entry.id).toEqual(expected)
      if (defect === 4) expect(fields).toEqual([['issue_date']])
      if (defect === 3) expect(fields).toEqual([['seller.tax_id']])
      if (defect === 1) expect(fields).toEqual([['total_net']])
      if (defect === 2) expect(fields).toEqual([['total_vat']])
      if (defect === 5) {
        const foreign = data.invoice.lines.flatMap((line, k) =>
          RATES[entry.country]!.has(line.vat_rate) ? [] : [`lines[${k}].vat_rate`],
        )
        expect(foreign, entry.id).toHaveLength(1)
        expect(fields).toEqual([foreign])
      }
    }
  })

  test('tax ids pass their checksum except the class 3 seller', async () => {
    for (const entry of await index(generated)) {
      const { invoice } = await truth(generated, entry.id)
      const check = TAX_ID_CHECK[entry.country]!

      expect(check(invoice.buyer.tax_id), entry.id).toBe(true)
      expect(check(invoice.seller.tax_id), entry.id).toBe(entry.defect !== 3)
    }
  })

  test('the PDF text prints every ground-truth field in its place', async () => {
    for (const entry of await index(generated)) {
      const { invoice } = await truth(generated, entry.id)
      const { country } = entry
      const [before, after] = expectedPage(invoice, country)
      const groups = rateGroups(invoice)

      const lines = await pdfLines(await readFile(join(generated, `${entry.id}.pdf`)))

      expect(lines.length, `${entry.id} ${JSON.stringify(lines)}`).toBe(
        before.length + groups.length + after.length,
      )
      expect(lines.slice(0, before.length), entry.id).toEqual(before)
      expect(lines.slice(lines.length - after.length), entry.id).toEqual(after)
      const rows = lines.slice(before.length, before.length + groups.length)
      const vats = rows.map((row, i) => printedGroupVat(row, groups[i]![0], groups[i]![1], country))
      const sum = vats.reduce((total, vat) => total.plus(vat), new Decimal(0))
      expect(sum.equals(new Decimal(invoice.total_vat)), entry.id).toBe(true)
      const wrong = groups.filter(
        ([rate, net], i) =>
          !vats[i]!.equals(halfUp(rateValue(rate).times(net).div(new Decimal(100)))),
      )
      expect(wrong, entry.id).toHaveLength(entry.defect === 2 ? 1 : 0)
    }
  })
})

describe('mokosz generate-invoices', () => {
  test('the CLI writes the set', async () => {
    const out = await scratch()

    const { code, output } = await capturing(() => main(['generate-invoices', '--out', out]))

    expect(code, output).toBe(0)
    expect(output).toContain('150 invoices (100 clean, 50 defective)')
    await expectSameFiles(out, generated)
  })

  test('the CLI seed changes the set', async () => {
    const out = await scratch()

    const { code, output } = await capturing(() =>
      main(['generate-invoices', '--out', out, '--seed', '7']),
    )

    expect(code, output).toBe(0)
    const [mine, theirs] = [await files(out), await files(generated)]
    expect(mine.get('index.json')!.equals(theirs.get('index.json')!)).toBe(false)
    expect(await sellerNames(out)).not.toEqual(await sellerNames(generated))
  })

  test('the CLI defaults to data/invoices in the repository', async () => {
    const root = await scratch()
    await execute('git', ['init', '--quiet'], root)

    const { stdout } = await execute(process.execPath, [CLI, 'generate-invoices'], root)

    expect(stdout).toContain('150 invoices (100 clean, 50 defective)')
    await expectSameFiles(join(root, 'data', 'invoices'), generated)
  }, 120_000)
})

describe('the self-check', () => {
  const invoices = generate()
  const clean = invoices.find((item) => item.defect === null)!
  const classTwo = invoices.find((item) => item.defect === 2)!

  test('a clean invoice that fails a rule names the failed rules', () => {
    const wrong = {
      ...clean,
      invoice: { ...clean.invoice, total_vat: clean.invoice.total_vat!.plus(new Decimal(1)) },
    }

    expect(() => selfCheck(wrong)).toThrow(
      new GenerationError(
        `${clean.id}: defect null fails ["vat_total","gross_total"], expected []`,
      ),
    )
  })

  test('a defective invoice that fails another rule names both lists', () => {
    expect(() => selfCheck({ ...classTwo, defect: 1 })).toThrow(
      new GenerationError(`${classTwo.id}: defect 1 fails ["vat_total"], expected ["lines_total"]`),
    )
  })

  test('the round trip compares decimals by value', () => {
    const fine = new Decimal('0.0001')
    const rescaled = {
      ...clean.invoice,
      lines: clean.invoice.lines.map((line) => ({
        ...line,
        quantity: line.quantity.quantize(fine, 'HALF_EVEN'),
        net: line.net!.quantize(fine, 'HALF_EVEN'),
      })),
      total_net: clean.invoice.total_net!.quantize(fine, 'HALF_EVEN'),
    }
    expect(JSON.stringify(rescaled)).not.toBe(JSON.stringify(clean.invoice))

    expect(sameInvoice(rescaled, clean.invoice)).toBe(true)
    expect(() => selfCheck({ ...clean, invoice: rescaled })).not.toThrow()
    expect(
      sameInvoice(
        { ...rescaled, total_net: rescaled.total_net.plus(new Decimal('0.01')) },
        clean.invoice,
      ),
    ).toBe(false)
    expect(sameInvoice({ ...rescaled, total_net: null }, clean.invoice)).toBe(false)
    expect(sameInvoice({ ...rescaled, lines: rescaled.lines.slice(1) }, clean.invoice)).toBe(false)
    expect(
      sameInvoice({ ...rescaled, buyer: { ...rescaled.buyer, name: 'Other' } }, clean.invoice),
    ).toBe(false)
  })

  test('the round trip does not depend on the order of the fields', () => {
    const { number, issue_date, sale_date, currency, seller, buyer, lines } = clean.invoice
    const { total_net, total_vat, total_gross } = clean.invoice
    const reordered = {
      total_gross,
      total_vat,
      total_net,
      lines,
      buyer,
      seller,
      currency,
      sale_date,
      issue_date,
      number,
    }
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(clean.invoice))

    expect(() => selfCheck({ ...clean, invoice: reordered })).not.toThrow()
  })

  test('an extra field or undefined for null is not the same invoice', () => {
    expect(sameInvoice({ ...clean.invoice, extra: null }, clean.invoice)).toBe(false)
    expect(sameInvoice(clean.invoice, { ...clean.invoice, extra: null })).toBe(false)
    expect(
      sameInvoice(
        { ...clean.invoice, total_net: undefined },
        { ...clean.invoice, total_net: null },
      ),
    ).toBe(false)
  })

  test('every generated invoice passes it', () => {
    for (const item of invoices) expect(() => selfCheck(item), item.id).not.toThrow()
  })
})
