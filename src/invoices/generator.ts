// The generated invoice set (SPEC § 1): fictional PL and DE invoices with known defects.
//
// `generate` builds 150 invoices from a fixed seed: 75 PL (PLN) and 75 DE (EUR), each country with
// 50 clean invoices and 5 per defect class. The ground truth is the `Invoice`; every one is checked
// against `validate` before it is kept, so a clean invoice passes every rule and a defective one
// fails exactly the rule of its class (`DEFECT_RULES`). Tax ids come from Faker's NIP and USt-IdNr
// algorithms and are drawn again until they pass the checksum.
//
// `writeSet` writes `{id}.pdf`, `{id}.json` (`invoice`, `defect`, `expected_failed_rules`) and
// `index.json` (`id`, `country`, `defect` per invoice). The same seed gives byte-identical files.
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Faker, base, de, en, pl } from '@faker-js/faker'
import { CommandError } from '../command.ts'
import { Decimal } from '../decimal.ts'
import { renderPdf, type VatGroup } from './render.ts'
import { ExtractedInvoice, type Invoice, type Line, type Party, type Rule } from './schema.ts'
import { nipValid, ustIdnrValid } from './taxid.ts'
import { validate } from './validator.ts'

export type Country = 'PL' | 'DE'
export type Defect = 1 | 2 | 3 | 4 | 5

export const SEED = 20261103
export const COUNTRIES: readonly Country[] = ['PL', 'DE']
export const CLEAN_PER_COUNTRY = 50
export const DEFECTIVE_PER_CLASS_PER_COUNTRY = 5
export const DEFECT_RULES: Readonly<Record<Defect, Rule>> = {
  1: 'lines_total',
  2: 'vat_total',
  3: 'tax_id',
  4: 'required_fields',
  5: 'vat_rate_country',
}
const DEFECTS: readonly Defect[] = [1, 2, 3, 4, 5]
const FOREIGN_RATES: Record<Country, readonly string[]> = { PL: ['19', '7'], DE: ['23', '8', '5'] }
const CURRENCIES: Record<Country, string> = { PL: 'PLN', DE: 'EUR' }
const LOCALES = { PL: [pl, en, base], DE: [de, en, base] }
const CENT = new Decimal('0.01')
const HUNDRED = new Decimal(100)
const ZERO = new Decimal(0)
const MAX_DRAWS = 100
const FIRST_DAY = Date.UTC(2026, 0, 5)
const DAYS = 290
const DAY_MS = 86_400_000

export class GenerationError extends Error {}

interface Item {
  description: string
  low: number
  high: number
  rate: string
  hourly?: boolean
}

const CATALOG: Record<Country, readonly Item[]> = {
  PL: [
    {
      description: 'Usługa programistyczna (godz.)',
      low: 120,
      high: 260,
      rate: '23',
      hourly: true,
    },
    {
      description: 'Konsultacje wdrożeniowe (godz.)',
      low: 150,
      high: 320,
      rate: '23',
      hourly: true,
    },
    { description: 'Licencja oprogramowania – 12 miesięcy', low: 500, high: 3000, rate: '23' },
    { description: 'Hosting serwera VPS – 1 miesiąc', low: 80, high: 400, rate: '23' },
    { description: 'Papier biurowy A4, ryza 500 ark.', low: 15, high: 32, rate: '23' },
    { description: 'Toner do drukarki laserowej', low: 150, high: 450, rate: '23' },
    { description: 'Krzesło biurowe obrotowe', low: 400, high: 1200, rate: '23' },
    { description: 'Monitor 27 cali', low: 900, high: 2000, rate: '23' },
    { description: 'Usługa transportowa krajowa', low: 300, high: 1500, rate: '23' },
    { description: 'Catering na spotkanie zespołu', low: 400, high: 2500, rate: '8' },
    { description: 'Usługa noclegowa (doba)', low: 180, high: 450, rate: '8' },
    { description: 'Książka specjalistyczna', low: 50, high: 180, rate: '5' },
    { description: 'Prenumerata czasopisma branżowego', low: 120, high: 600, rate: '5' },
    { description: 'Szkolenie zawodowe dofinansowane', low: 800, high: 4000, rate: 'zw' },
    { description: 'Transport międzynarodowy towarów', low: 900, high: 5000, rate: '0' },
    { description: 'Usługa doradcza świadczona za granicą', low: 1000, high: 6000, rate: 'np' },
  ],
  DE: [
    { description: 'Softwareentwicklung (Std.)', low: 80, high: 150, rate: '19', hourly: true },
    { description: 'Beratungsleistung (Std.)', low: 100, high: 200, rate: '19', hourly: true },
    { description: 'Softwarelizenz – 12 Monate', low: 300, high: 2500, rate: '19' },
    { description: 'Webhosting – 1 Monat', low: 10, high: 150, rate: '19' },
    { description: 'Druckerpapier A4, 500 Blatt', low: 4, high: 9, rate: '19' },
    { description: 'Tonerkartusche', low: 60, high: 200, rate: '19' },
    { description: 'Bürostuhl, ergonomisch', low: 150, high: 700, rate: '19' },
    { description: 'Monitor 27 Zoll', low: 200, high: 600, rate: '19' },
    { description: 'Schulungsveranstaltung', low: 400, high: 2000, rate: '19' },
    { description: 'Fachbuch', low: 30, high: 90, rate: '7' },
    { description: 'Zeitschriftenabonnement', low: 40, high: 240, rate: '7' },
    { description: 'Brötchen und Gebäck für Besprechung', low: 20, high: 120, rate: '7' },
    { description: 'Photovoltaikmodul 430 W', low: 90, high: 220, rate: '0' },
  ],
}

export interface GeneratedInvoice {
  readonly id: string
  readonly country: Country
  readonly defect: Defect | null
  readonly invoice: Invoice
  readonly vatGroups: readonly VatGroup[]
}

export function expectedFailedRules(generated: GeneratedInvoice): Rule[] {
  return generated.defect === null ? [] : [DEFECT_RULES[generated.defect]]
}

export function groundTruth(generated: GeneratedInvoice): object {
  return {
    invoice: JSON.parse(JSON.stringify(generated.invoice)) as unknown,
    defect: generated.defect,
    expected_failed_rules: expectedFailedRules(generated),
  }
}

// The draws the generator makes, on a seeded Faker.
class Random {
  readonly #faker: Faker

  constructor(seed: number) {
    this.#faker = new Faker({ locale: [base] })
    this.#faker.seed(seed)
  }

  randint(low: number, high: number): number {
    return this.#faker.number.int({ min: low, max: high })
  }

  randrange(stop: number): number {
    return this.randint(0, stop - 1)
  }

  random(): number {
    return this.#faker.number.float({ min: 0, max: 1 })
  }

  choice<T>(items: readonly T[]): T {
    return this.#faker.helpers.arrayElement(items)
  }

  sample<T>(items: readonly T[], count: number): T[] {
    return this.#faker.helpers.arrayElements(items, count)
  }

  shuffle<T>(items: readonly T[]): T[] {
    return this.#faker.helpers.shuffle([...items])
  }
}

const halfUp = (value: Decimal): Decimal => value.quantize(CENT, 'HALF_UP')

function cents(rng: Random, low: number, high: number): Decimal {
  return new Decimal(rng.randint(low * 100, high * 100)).div(HUNDRED).quantize(CENT, 'HALF_EVEN')
}

const isExempt = (rate: string): boolean => rate === 'zw' || rate === 'np'
const rateValue = (rate: string): Decimal => (isExempt(rate) ? ZERO : new Decimal(rate))

function vatGroups(lines: readonly Line[]): VatGroup[] {
  const nets = new Map<string, Decimal>()
  for (const line of lines) {
    nets.set(line.vat_rate!, (nets.get(line.vat_rate!) ?? ZERO).plus(line.net!))
  }
  const order = [...nets.keys()].toSorted(
    (a, b) =>
      Number(isExempt(a)) - Number(isExempt(b)) ||
      rateValue(b).cmp(rateValue(a)) ||
      (a < b ? -1 : a > b ? 1 : 0),
  )
  return order.map((rate) => {
    const net = nets.get(rate)!
    return { rate, net, vat: halfUp(rateValue(rate).div(HUNDRED).times(net)) }
  })
}

const NIP_WEIGHTS = [6, 5, 7, 2, 3, 4, 5, 6, 7]

// A NIP: three non-zero digits, six digits and the check digit.
function companyVat(faker: Faker): string {
  for (;;) {
    const digits = [
      ...Array.from({ length: 3 }, () => faker.number.int({ min: 1, max: 9 })),
      ...Array.from({ length: 6 }, () => faker.number.int({ min: 0, max: 9 })),
    ]
    const check = NIP_WEIGHTS.reduce((sum, weight, i) => sum + weight * digits[i]!, 0) % 11
    if (check !== 10) return [...digits, check].join('')
  }
}

// A USt-IdNr: a non-zero digit, seven digits and the ISO 7064 Mod 11,10 check digit.
function vatId(faker: Faker): string {
  const digits = `${faker.number.int({ min: 1, max: 9 })}${faker.string.numeric(7)}`
  let product = 10
  for (const digit of digits) {
    const sum = (Number(digit) + product) % 10 || 10
    product = (2 * sum) % 11
  }
  return `DE${digits}${(11 - product) % 10}`
}

function drawTaxId(draw: () => string, valid: (value: string) => boolean): string {
  for (let n = 0; n < MAX_DRAWS; n++) {
    const taxId = draw()
    if (valid(taxId)) return taxId
  }
  throw new GenerationError(`no checksum-valid tax id in ${MAX_DRAWS} draws`)
}

function party(faker: Faker, country: Country): Party {
  const taxId =
    country === 'PL'
      ? drawTaxId(() => companyVat(faker), nipValid)
      : drawTaxId(() => vatId(faker), ustIdnrValid)
  const { location } = faker
  const address = `${location.streetAddress()}, ${location.zipCode()} ${location.city()}`
  return { name: faker.company.name(), tax_id: taxId, country, address }
}

function drawLine(rng: Random, item: Item): Line {
  const quantity = item.hourly
    ? new Decimal(rng.randint(2, 160)).div(new Decimal(2))
    : new Decimal(rng.choice([1, 1, 1, 2, 2, 3, 4, 5, 10, 12, 20]))
  const unitNet = cents(rng, item.low, item.high)
  return {
    description: item.description,
    quantity,
    unit_net: unitNet,
    vat_rate: item.rate,
    net: halfUp(quantity.times(unitNet)),
  }
}

function drawLines(rng: Random, country: Country): Line[] {
  const items = rng.sample(CATALOG[country], rng.randint(1, 6))
  return items.map((item) => drawLine(rng, item))
}

function signed(rng: Random, low: number, high: number, room: Decimal): Decimal {
  const delta = cents(rng, low, high)
  return delta.cmp(room) < 0 && rng.random() < 0.5 ? delta.neg() : delta
}

function breakCheckDigit(rng: Random, taxId: string): string {
  const digit = (Number(taxId.at(-1)) + rng.randint(1, 9)) % 10
  return taxId.slice(0, -1) + String(digit)
}

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

function invoiceNumber(country: Country, index: number, issued: string): string {
  const [year, month] = [issued.slice(0, 4), issued.slice(5, 7)]
  if (country === 'PL') return `FV/${year}/${month}/${String(index).padStart(3, '0')}`
  return `RE-${year}-${String(index).padStart(4, '0')}`
}

function build(
  rng: Random,
  faker: Faker,
  index: number,
  country: Country,
  defect: Defect | null,
): GeneratedInvoice {
  let items = drawLines(rng, country)
  if (defect === 2) {
    while (items.every((item) => rateValue(item.vat_rate ?? '0').isZero())) {
      items = drawLines(rng, country)
    }
  }
  if (defect === 5) {
    const target = rng.randrange(items.length)
    const foreign = rng.choice(FOREIGN_RATES[country])
    items[target] = { ...items[target]!, vat_rate: foreign }
  }
  const groups = vatGroups(items)
  let totalNet = items.reduce((sum, item) => sum.plus(item.net ?? ZERO), ZERO)
  let totalVat = groups.reduce((sum, group) => sum.plus(group.vat), ZERO)

  if (defect === 1) totalNet = totalNet.plus(signed(rng, 5, 400, totalNet))
  if (defect === 2) {
    const taxed = groups.flatMap((group, i) => (rateValue(group.rate).cmp(ZERO) > 0 ? [i] : []))
    const target = taxed.reduce((best, i) => (groups[i]!.vat.cmp(groups[best]!.vat) > 0 ? i : best))
    const delta = signed(rng, 1, 80, groups[target]!.vat)
    groups[target] = { ...groups[target]!, vat: groups[target]!.vat.plus(delta) }
    totalVat = totalVat.plus(delta)
  }

  const issuedMs = FIRST_DAY + rng.randrange(DAYS) * DAY_MS
  const issued = isoDay(issuedMs)
  const sold = isoDay(issuedMs - rng.choice([0, 0, 0, 1, 2, 5, 10]) * DAY_MS)
  let seller = party(faker, country)
  const buyer = party(faker, country)
  if (defect === 3) seller = { ...seller, tax_id: breakCheckDigit(rng, seller.tax_id!) }

  const invoice: Invoice = {
    number: invoiceNumber(country, index, issued),
    issue_date: defect === 4 ? null : issued,
    sale_date: sold,
    currency: CURRENCIES[country],
    seller,
    buyer,
    lines: items,
    total_net: totalNet,
    total_vat: totalVat,
    total_gross: totalNet.plus(totalVat),
  }
  const generated: GeneratedInvoice = {
    id: `inv-${String(index).padStart(3, '0')}`,
    country,
    defect,
    invoice,
    vatGroups: groups,
  }
  selfCheck(generated)
  return generated
}

/** Same fields, with decimals compared by value ("2.0" equals "2"). */
export function sameInvoice(a: unknown, b: unknown): boolean {
  if (a instanceof Decimal || b instanceof Decimal) {
    return a instanceof Decimal && b instanceof Decimal && a.equals(b)
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => sameInvoice(item, b[i]))
    )
  }
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    const right = new Map<string, unknown>(Object.entries(b))
    const left = Object.entries(a)
    return (
      left.length === right.size &&
      left.every(([key, value]) => right.has(key) && sameInvoice(value, right.get(key)))
    )
  }
  return a === b
}

/** The invoice fails exactly its class's rule and survives its own JSON. */
export function selfCheck(generated: GeneratedInvoice): void {
  const extracted = ExtractedInvoice.parse(JSON.parse(JSON.stringify(generated.invoice)))
  const result = validate(extracted)
  const expected = expectedFailedRules(generated)
  if (JSON.stringify(result.failedRules) !== JSON.stringify(expected)) {
    throw new GenerationError(
      `${generated.id}: defect ${generated.defect} fails ${JSON.stringify(result.failedRules)},` +
        ` expected ${JSON.stringify(expected)}`,
    )
  }
  if (!sameInvoice(result.invoice, generated.invoice)) {
    throw new GenerationError(`${generated.id}: the ground truth does not round-trip`)
  }
}

function slots(rng: Random): [Country, Defect | null][] {
  const all: [Country, Defect | null][] = []
  for (const country of COUNTRIES) {
    for (let n = 0; n < CLEAN_PER_COUNTRY; n++) all.push([country, null])
    for (const defect of DEFECTS) {
      for (let n = 0; n < DEFECTIVE_PER_CLASS_PER_COUNTRY; n++) all.push([country, defect])
    }
  }
  return rng.shuffle(all)
}

export function generate(seed: number = SEED): GeneratedInvoice[] {
  const rng = new Random(seed)
  const fakers = new Map<Country, Faker>()
  for (const [offset, country] of COUNTRIES.entries()) {
    const faker = new Faker({ locale: LOCALES[country] })
    faker.seed(seed + offset)
    fakers.set(country, faker)
  }
  return slots(rng).map(([country, defect], i) =>
    build(rng, fakers.get(country)!, i + 1, country, defect),
  )
}

// Indented JSON and a newline.
const jsonBytes = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

export async function writeSet(out: string, seed: number = SEED): Promise<GeneratedInvoice[]> {
  const invoices = generate(seed)
  await mkdir(out, { recursive: true })
  for (const generated of invoices) {
    const pdf = await renderPdf(generated.invoice, generated.vatGroups)
    await writeFile(join(out, `${generated.id}.pdf`), pdf)
    await writeFile(join(out, `${generated.id}.json`), jsonBytes(groundTruth(generated)), 'utf8')
  }
  const index = invoices.map(({ id, country, defect }) => ({ id, country, defect }))
  await writeFile(join(out, 'index.json'), jsonBytes(index), 'utf8')
  return invoices
}

export async function generateInvoices(target: string, seed: number = SEED): Promise<void> {
  let invoices: GeneratedInvoice[]
  try {
    invoices = await writeSet(target, seed)
  } catch (error) {
    if (error instanceof GenerationError) {
      throw new CommandError(`Generating invoices failed: ${error.message}`)
    }
    throw error
  }
  const names = ['index.json', ...invoices.flatMap(({ id }) => [`${id}.pdf`, `${id}.json`])]
  let size = 0
  for (const name of names) size += (await stat(join(target, name))).size
  const defective = invoices.filter((generated) => generated.defect !== null).length
  process.stdout.write(
    `${target}: ${invoices.length} invoices (${invoices.length - defective} clean,` +
      ` ${defective} defective), ${(size / 1e6).toFixed(2)} MB\n`,
  )
}
