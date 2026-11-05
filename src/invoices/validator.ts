// Deterministic invoice validation (SPEC § 3), no LLM.
//
// `validate(extracted)` returns the typed `Invoice` built from the extracted strings, or null when a
// present value does not parse (a date that is not YYYY-MM-DD, money or a quantity that is not a
// plain decimal such as 1234.56) or a line has no quantity, and every rule `Failure`: all seven
// rules are always evaluated and each reports every problem it finds. A rule whose own input is
// missing or not parseable fails once per such path. Surrounding whitespace is ignored and a blank
// string counts as missing. Money is a Decimal; VAT per rate group is rounded half-up to 2 places;
// amounts match within an inclusive tolerance of 0.01.
import { Decimal } from '../decimal.ts'
import {
  RULES,
  type ExtractedInvoice,
  type ExtractedLine,
  type Failure,
  type Invoice,
  type Line,
  type Party,
  type Rule,
} from './schema.ts'
import { nipValid, ustIdnrValid } from './taxid.ts'

export const TOLERANCE = new Decimal('0.01')
const CENT = new Decimal('0.01')
const ZERO = new Decimal(0)
const HUNDRED = new Decimal(100)

type ExemptRate = 'zw' | 'np'
type VatRate = Decimal | ExemptRate

export const VAT_RATES: ReadonlyMap<string, readonly VatRate[]> = new Map<string, VatRate[]>([
  ['PL', [new Decimal(23), new Decimal(8), new Decimal(5), new Decimal(0), 'zw', 'np']],
  ['DE', [new Decimal(19), new Decimal(7), new Decimal(0)]],
])

const TAX_ID_CHECKS: ReadonlyMap<string, [string, (value: string) => boolean]> = new Map([
  ['PL', ['NIP', nipValid]],
  ['DE', ['USt-IdNr', ustIdnrValid]],
])

// Caps money and quantities at 15 integer digits and 10 decimal places.
const DECIMAL = /^-?[0-9]{1,15}(?:\.[0-9]{1,10})?$/
const RATE = /^[0-9]{1,3}(?:\.[0-9]{1,2})?$/
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
const CURRENCY = /^[A-Z]{3}$/

type Reason = 'missing' | 'not parseable'

class Bad {
  readonly path: string
  readonly reason: Reason

  constructor(path: string, reason: Reason) {
    this.path = path
    this.reason = reason
  }

  get message(): string {
    return `${this.path} is ${this.reason}`
  }
}

export class ValidationResult {
  readonly invoice: Invoice | null
  readonly failures: readonly Failure[]

  constructor(invoice: Invoice | null, failures: readonly Failure[]) {
    this.invoice = invoice
    this.failures = failures
  }

  get passed(): boolean {
    return this.failures.length === 0
  }

  get failedRules(): Rule[] {
    const failed = new Set(this.failures.map((failure) => failure.rule))
    return RULES.filter((rule) => failed.has(rule))
  }
}

interface ParsedLine {
  quantity: Decimal | Bad
  unitNet: Decimal | Bad
  net: Decimal | Bad
  rate: VatRate | Bad
}

interface Parsed {
  issueDate: string | Bad
  saleDate: string | Bad
  lines: ParsedLine[]
  totalNet: Decimal | Bad
  totalVat: Decimal | Bad
  totalGross: Decimal | Bad
}

function text(raw: string | null): string | null {
  if (raw === null) return null
  const stripped = raw.trim()
  return stripped === '' ? null : stripped
}

function parseDecimal(raw: string | null, path: string): Decimal | Bad {
  const value = text(raw)
  if (value === null) return new Bad(path, 'missing')
  if (!DECIMAL.test(value)) return new Bad(path, 'not parseable')
  return new Decimal(value)
}

// YYYY-MM-DD: years 1 to 9999 and a real day of the month.
function isoDate(value: string): boolean {
  const [year, month, day] = [value.slice(0, 4), value.slice(5, 7), value.slice(8)].map(Number)
  if (year === undefined || month === undefined || day === undefined) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  return year >= 1 && days !== undefined && day >= 1 && day <= days
}

function parseDate(raw: string | null, path: string): string | Bad {
  const value = text(raw)
  if (value === null) return new Bad(path, 'missing')
  if (!DATE.test(value) || !isoDate(value)) return new Bad(path, 'not parseable')
  return value
}

function parseRate(raw: string | null, path: string): VatRate | Bad {
  const value = text(raw)
  if (value === null) return new Bad(path, 'missing')
  if (value === 'zw' || value === 'np') return value
  if (!RATE.test(value)) return new Bad(path, 'not parseable')
  return new Decimal(value)
}

function parse(extracted: ExtractedInvoice): Parsed {
  return {
    issueDate: parseDate(extracted.issue_date, 'issue_date'),
    saleDate: parseDate(extracted.sale_date, 'sale_date'),
    lines: extracted.lines.map((line, i) => ({
      quantity: parseDecimal(line.quantity, `lines[${i}].quantity`),
      unitNet: parseDecimal(line.unit_net, `lines[${i}].unit_net`),
      net: parseDecimal(line.net, `lines[${i}].net`),
      rate: parseRate(line.vat_rate, `lines[${i}].vat_rate`),
    })),
    totalNet: parseDecimal(extracted.total_net, 'total_net'),
    totalVat: parseDecimal(extracted.total_vat, 'total_vat'),
    totalGross: parseDecimal(extracted.total_gross, 'total_gross'),
  }
}

function inputFailure(rule: Rule, bad: Bad): Failure {
  return { rule, message: bad.message, fields: [bad.path] }
}

const within = (a: Decimal, b: Decimal): boolean => a.minus(b).abs().lte(TOLERANCE)

const halfUp = (value: Decimal): Decimal => value.quantize(CENT, 'HALF_UP')

function requiredFields(extracted: ExtractedInvoice, parsed: Parsed): Failure[] {
  const rule: Rule = 'required_fields'
  const failures: Failure[] = []
  if (text(extracted.number) === null)
    failures.push(inputFailure(rule, new Bad('number', 'missing')))
  if (parsed.issueDate instanceof Bad) failures.push(inputFailure(rule, parsed.issueDate))
  if (parsed.saleDate instanceof Bad && parsed.saleDate.reason === 'not parseable') {
    failures.push(inputFailure(rule, parsed.saleDate))
  }
  const currency = text(extracted.currency)
  if (currency === null) failures.push(inputFailure(rule, new Bad('currency', 'missing')))
  else if (!CURRENCY.test(currency)) {
    failures.push(inputFailure(rule, new Bad('currency', 'not parseable')))
  }
  const { seller } = extracted
  for (const [path, value] of [
    ['seller.name', seller.name],
    ['seller.tax_id', seller.tax_id],
    ['seller.country', seller.country],
  ] as const) {
    if (text(value) === null) failures.push(inputFailure(rule, new Bad(path, 'missing')))
  }
  if (extracted.lines.length === 0) {
    failures.push({ rule, message: 'at least one line is required', fields: ['lines'] })
  }
  return failures
}

function lineNet(parsed: Parsed): Failure[] {
  const rule: Rule = 'line_net'
  const failures: Failure[] = []
  parsed.lines.forEach((line, i) => {
    const { quantity, unitNet, net } = line
    const bad = [quantity, unitNet, net].filter((value) => value instanceof Bad)
    for (const value of bad) failures.push(inputFailure(rule, value))
    if (quantity instanceof Bad || unitNet instanceof Bad || net instanceof Bad) return
    const product = quantity.times(unitNet)
    if (!within(product, net)) {
      failures.push({
        rule,
        message: `lines[${i}].net is ${net.toString()}, quantity times unit_net is ${product.toString()}`,
        fields: [`lines[${i}].net`],
      })
    }
  })
  return failures
}

function linesTotal(parsed: Parsed): Failure[] {
  const rule: Rule = 'lines_total'
  const failures: Failure[] = []
  const nets: Decimal[] = []
  let complete = true
  for (const line of parsed.lines) {
    if (line.net instanceof Bad) {
      complete = false
      failures.push(inputFailure(rule, line.net))
    } else {
      nets.push(line.net)
    }
  }
  if (parsed.totalNet instanceof Bad) return [...failures, inputFailure(rule, parsed.totalNet)]
  if (!complete) return failures
  const linesSum = nets.reduce((sum, net) => sum.plus(net), ZERO)
  if (!within(linesSum, parsed.totalNet)) {
    failures.push({
      rule,
      message: `total_net is ${parsed.totalNet.toString()}, the line nets sum to ${linesSum.toString()}`,
      fields: ['total_net'],
    })
  }
  return failures
}

function allows(allowed: readonly VatRate[], rate: VatRate): boolean {
  return allowed.some((item) =>
    typeof item === 'string' || typeof rate === 'string' ? item === rate : item.equals(rate),
  )
}

function vatRateCountry(extracted: ExtractedInvoice, parsed: Parsed): Failure[] {
  const rule: Rule = 'vat_rate_country'
  const failures: Failure[] = []
  const country = text(extracted.seller.country)
  let allowed: readonly VatRate[] | undefined
  if (country === null) {
    failures.push(inputFailure(rule, new Bad('seller.country', 'missing')))
  } else if (!VAT_RATES.has(country)) {
    failures.push({
      rule,
      message: `seller.country ${JSON.stringify(country)} is not PL or DE`,
      fields: ['seller.country'],
    })
  } else {
    allowed = VAT_RATES.get(country)
  }
  parsed.lines.forEach((line, i) => {
    if (line.rate instanceof Bad) {
      failures.push(inputFailure(rule, line.rate))
    } else if (allowed !== undefined && !allows(allowed, line.rate)) {
      const path = `lines[${i}].vat_rate`
      failures.push({
        rule,
        message: `${path} ${line.rate.toString()} is not a valid VAT rate for ${country}`,
        fields: [path],
      })
    }
  })
  return failures
}

function vatTotal(parsed: Parsed): Failure[] {
  const rule: Rule = 'vat_total'
  const failures: Failure[] = []
  // Keyed by value, keeping the first rate written.
  const groups = new Map<string, { rate: Decimal; net: Decimal }>()
  let complete = true
  for (const line of parsed.lines) {
    for (const value of [line.net, line.rate]) {
      if (value instanceof Bad) {
        complete = false
        failures.push(inputFailure(rule, value))
      }
    }
    if (line.net instanceof Decimal && !(line.rate instanceof Bad)) {
      const rate = typeof line.rate === 'string' ? ZERO : line.rate
      const group = groups.get(rate.key())
      groups.set(rate.key(), {
        rate: group?.rate ?? rate,
        net: (group?.net ?? ZERO).plus(line.net),
      })
    }
  }
  if (parsed.totalVat instanceof Bad) return [...failures, inputFailure(rule, parsed.totalVat)]
  if (!complete) return failures
  let expected = ZERO
  for (const { rate, net } of groups.values()) {
    expected = expected.plus(halfUp(rate.div(HUNDRED).times(net)))
  }
  if (!within(expected, parsed.totalVat)) {
    failures.push({
      rule,
      message: `total_vat is ${parsed.totalVat.toString()}, the rate groups give ${expected.toString()}`,
      fields: ['total_vat'],
    })
  }
  return failures
}

function grossTotal(parsed: Parsed): Failure[] {
  const rule: Rule = 'gross_total'
  const { totalNet: net, totalVat: vat, totalGross: gross } = parsed
  const bad = [net, vat, gross].filter((value) => value instanceof Bad)
  if (net instanceof Bad || vat instanceof Bad || gross instanceof Bad) {
    return bad.map((value) => inputFailure(rule, value))
  }
  if (within(net.plus(vat), gross)) return []
  return [
    {
      rule,
      message: `total_gross is ${gross.toString()}, total_net plus total_vat is ${net.plus(vat).toString()}`,
      fields: ['total_gross'],
    },
  ]
}

function taxId(extracted: ExtractedInvoice): Failure[] {
  const rule: Rule = 'tax_id'
  const failures: Failure[] = []
  const sellerCheck = TAX_ID_CHECKS.get(text(extracted.seller.country) ?? '')
  if (sellerCheck !== undefined) {
    const [label, check] = sellerCheck
    const id = text(extracted.seller.tax_id)
    if (id === null) {
      failures.push(inputFailure(rule, new Bad('seller.tax_id', 'missing')))
    } else if (!check(id)) {
      failures.push({
        rule,
        message: `seller.tax_id ${JSON.stringify(id)} is not a valid ${label}`,
        fields: ['seller.tax_id'],
      })
    }
  }
  const buyerCheck = TAX_ID_CHECKS.get(text(extracted.buyer.country) ?? '')
  const buyerId = text(extracted.buyer.tax_id)
  if (buyerCheck !== undefined && buyerId !== null) {
    const [label, check] = buyerCheck
    if (!check(buyerId)) {
      failures.push({
        rule,
        message: `buyer.tax_id ${JSON.stringify(buyerId)} is not a valid ${label}`,
        fields: ['buyer.tax_id'],
      })
    }
  }
  return failures
}

const optional = <T>(value: T | Bad): T | null => (value instanceof Bad ? null : value)

function party(raw: Party): Party {
  return {
    name: text(raw.name),
    tax_id: text(raw.tax_id),
    country: text(raw.country),
    address: text(raw.address),
  }
}

function buildLine(raw: ExtractedLine, parsed: ParsedLine & { quantity: Decimal }): Line {
  return {
    description: raw.description.trim(),
    quantity: parsed.quantity,
    unit_net: optional(parsed.unitNet),
    vat_rate: text(raw.vat_rate),
    net: optional(parsed.net),
  }
}

function build(extracted: ExtractedInvoice, parsed: Parsed): Invoice | null {
  const values: unknown[] = [parsed.issueDate, parsed.saleDate]
  values.push(parsed.totalNet, parsed.totalVat, parsed.totalGross)
  for (const item of parsed.lines) values.push(item.quantity, item.unitNet, item.net)
  if (values.some((value) => value instanceof Bad && value.reason === 'not parseable')) return null
  const lines: Line[] = []
  for (const [i, item] of parsed.lines.entries()) {
    const { quantity } = item
    if (quantity instanceof Bad) return null
    lines.push(buildLine(extracted.lines[i]!, { ...item, quantity }))
  }
  return {
    number: text(extracted.number),
    issue_date: optional(parsed.issueDate),
    sale_date: optional(parsed.saleDate),
    currency: text(extracted.currency),
    seller: party(extracted.seller),
    buyer: party(extracted.buyer),
    lines,
    total_net: optional(parsed.totalNet),
    total_vat: optional(parsed.totalVat),
    total_gross: optional(parsed.totalGross),
  }
}

export function validate(extracted: ExtractedInvoice): ValidationResult {
  const parsed = parse(extracted)
  const failures = [
    ...requiredFields(extracted, parsed),
    ...lineNet(parsed),
    ...linesTotal(parsed),
    ...vatRateCountry(extracted, parsed),
    ...vatTotal(parsed),
    ...grossTotal(parsed),
    ...taxId(extracted),
  ]
  return new ValidationResult(build(extracted, parsed), failures)
}
