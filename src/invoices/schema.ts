// The invoice models: read-only, extra keys forbidden, every field required.
import { z } from 'zod'
import { Decimal, DecimalError } from '../decimal.ts'

export const RULES = [
  'required_fields',
  'line_net',
  'lines_total',
  'vat_rate_country',
  'vat_total',
  'gross_total',
  'tax_id',
] as const
export type Rule = (typeof RULES)[number]

const text = z.string().nullable()
const decimal = z.string().transform((value, ctx) => {
  try {
    return new Decimal(value)
  } catch (error) {
    if (!(error instanceof DecimalError)) throw error
    ctx.addIssue({ code: 'custom', message: error.message })
    return z.NEVER
  }
})
const optionalDecimal = decimal.nullable()
// A date is held as its ISO text, as the JSON of an invoice writes it.
const date = z.iso.date().nullable()

export const Party = z
  .strictObject({ name: text, tax_id: text, country: text, address: text })
  .readonly()
export type Party = z.output<typeof Party>

export const ExtractedLine = z
  .strictObject({
    description: z.string(),
    quantity: text,
    unit_net: text,
    vat_rate: text,
    net: text,
  })
  .readonly()
export type ExtractedLine = z.output<typeof ExtractedLine>

export const ExtractedInvoice = z
  .strictObject({
    number: text,
    issue_date: text,
    sale_date: text,
    currency: text,
    seller: Party,
    buyer: Party,
    lines: z.array(ExtractedLine).readonly(),
    total_net: text,
    total_vat: text,
    total_gross: text,
  })
  .readonly()
export type ExtractedInvoice = z.output<typeof ExtractedInvoice>

export const Line = z
  .strictObject({
    description: z.string(),
    quantity: decimal,
    unit_net: optionalDecimal,
    vat_rate: text,
    net: optionalDecimal,
  })
  .readonly()
export type Line = z.output<typeof Line>

export const Invoice = z
  .strictObject({
    number: text,
    issue_date: date,
    sale_date: date,
    currency: text,
    seller: Party,
    buyer: Party,
    lines: z.array(Line).readonly(),
    total_net: optionalDecimal,
    total_vat: optionalDecimal,
    total_gross: optionalDecimal,
  })
  .readonly()
export type Invoice = z.output<typeof Invoice>

export const Failure = z
  .strictObject({ rule: z.enum(RULES), message: z.string(), fields: z.array(z.string()) })
  .readonly()
export type Failure = z.output<typeof Failure>
