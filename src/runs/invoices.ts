import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { Decimal } from '../decimal.ts'
import type { ExtractedInvoice, Failure, Invoice } from '../invoices/index.ts'
import { append, close, lockRunning, terminate, type RunTotals } from './conversations.ts'
import { isoUtc, transaction, type Database, type Options, type Query } from './transaction.ts'

export type InvoiceStatus =
  | 'running'
  | 'pending_review'
  | 'approved'
  | 'rejected'
  | 'done'
  | 'failed'

export class InvoiceNotPending extends Error {
  override name = 'InvoiceNotPending'
}

export interface ClaimedRun {
  readonly runId: string
  readonly threadId: string
  readonly profile: string
}

const money = (value: unknown): boolean => value === null || value instanceof Decimal

// A validated invoice holds its money and quantities as Decimals.
function isInvoice(invoice: Invoice | ExtractedInvoice): invoice is Invoice {
  const { total_net, total_vat, total_gross, lines } = invoice
  return (
    [total_net, total_vat, total_gross].every(money) &&
    lines.every(
      (line) => line.quantity instanceof Decimal && money(line.unit_net) && money(line.net),
    )
  )
}

const PassedSchema = z.strictObject({
  extracted: z.custom<ExtractedInvoice>(),
  invoice: z.custom<Invoice>(),
})

const ApprovedSchema = z
  .strictObject({
    decision: z.enum(['approve', 'edit']),
    invoice: z.custom<Invoice | ExtractedInvoice>(),
    note: z.string().nullable().default(null),
  })
  .check((ctx) => {
    const { decision, invoice, note } = ctx.value
    if (decision === 'approve' && !note) {
      ctx.issues.push({
        code: 'custom',
        message: 'approving with failed rules needs a note',
        input: ctx.value,
      })
    }
    // An override may approve values that do not parse; an edit finishes only once valid.
    if (decision === 'edit' && !isInvoice(invoice)) {
      ctx.issues.push({
        code: 'custom',
        message: 'an edit is approved only as a validated invoice',
        input: ctx.value,
      })
    }
  })

const RejectedSchema = z.strictObject({ note: z.string().min(1) })

export class Passed {
  readonly extracted: ExtractedInvoice
  readonly invoice: Invoice

  constructor(fields: z.input<typeof PassedSchema>) {
    const { extracted, invoice } = PassedSchema.parse(fields)
    this.extracted = extracted
    this.invoice = invoice
  }
}

export class Approved {
  readonly decision: 'approve' | 'edit'
  readonly invoice: Invoice | ExtractedInvoice
  readonly note: string | null

  constructor(fields: z.input<typeof ApprovedSchema>) {
    const { decision, invoice, note } = ApprovedSchema.parse(fields)
    this.decision = decision
    this.invoice = invoice
    this.note = note
  }
}

export class Rejected {
  readonly note: string

  constructor(fields: z.input<typeof RejectedSchema>) {
    this.note = RejectedSchema.parse(fields).note
  }
}

export type Outcome = Passed | Approved | Rejected

export interface InvoiceItem {
  id: string
  status: InvoiceStatus
  number: string | null
  seller_name: string | null
  total_gross: string | null
  currency: string | null
  failed_rule_count: number
  created_at: string
}

const INVOICES = `
    SELECT i.id, i.status,
           coalesce(i.final, i.extracted) ->> 'number' AS number,
           coalesce(i.final, i.extracted) -> 'seller' ->> 'name' AS seller_name,
           coalesce(i.final, i.extracted) ->> 'total_gross' AS total_gross,
           coalesce(i.final, i.extracted) ->> 'currency' AS currency,
           coalesce(jsonb_array_length(i.failed_rules), 0) AS failed_rule_count,
           ${isoUtc('i.created_at')} AS created_at
    FROM invoices i
    ORDER BY i.created_at DESC, i.id DESC
`

async function lockExtraction(query: Query, runId: string): Promise<string> {
  const run = await lockRunning(query, runId)
  if (run.kind !== 'extraction') {
    throw new Error(`run ${runId} is a ${run.kind} run, not an extraction run`)
  }
  return run.invoice_id!
}

export function invoiceThreadId(invoiceId: string): string {
  return `invoice:${invoiceId}`
}

export async function createInvoice(
  db: Database,
  invoice: { invoiceId: string; pdfPath: string; profile: string } & Options,
): Promise<string> {
  const { invoiceId, pdfPath, profile, signal } = invoice
  const runId = randomUUID()
  const threadId = invoiceThreadId(invoiceId)
  await transaction(db, signal, async (query) => {
    await query(
      'INSERT INTO invoices (id, status, run_id, thread_id, pdf_path)' +
        " VALUES ($1, 'running', $2, $3, $4)",
      [invoiceId, runId, threadId, pdfPath],
    )
    await query(
      'INSERT INTO runs (id, kind, thread_id, invoice_id, status, profile)' +
        " VALUES ($1, 'extraction', $2, $3, 'running', $4)",
      [runId, threadId, invoiceId, profile],
    )
  })
  return runId
}

export async function interruptExtraction(
  db: Database,
  runId: string,
  totals: RunTotals,
  review: { extracted: ExtractedInvoice; failedRules: readonly Failure[] } & Options,
): Promise<number> {
  const { extracted, failedRules, signal } = review
  if (failedRules.length === 0) throw new Error('an invoice goes to review only with failed rules')
  return transaction(db, signal, async (query) => {
    const invoiceId = await lockExtraction(query, runId)
    await query(
      "UPDATE invoices SET status = 'pending_review', extracted = $1, failed_rules = $2" +
        ' WHERE id = $3',
      [JSON.stringify(extracted), JSON.stringify(failedRules), invoiceId],
    )
    await close(query, runId, 'pending_review', totals, null)
    return append(query, runId, 'interrupt', { invoice_id: invoiceId, failed_rules: failedRules })
  })
}

export async function claimDecision(
  db: Database,
  invoiceId: string,
  options: Options = {},
): Promise<ClaimedRun> {
  return transaction(db, options.signal, async (query) => {
    const [found] = await query<{ run_id: string }>('SELECT run_id FROM invoices WHERE id = $1', [
      invoiceId,
    ])
    if (found === undefined) throw new InvoiceNotPending(`invoice ${invoiceId} does not exist`)
    const runId = found.run_id
    // Run row first: every other writer locks the run before its invoice.
    const [run] = await query<{ status: string; thread_id: string; profile: string }>(
      'SELECT status, thread_id, profile FROM runs WHERE id = $1 FOR UPDATE',
      [runId],
    )
    const [invoice] = await query<{ status: string }>(
      'SELECT status FROM invoices WHERE id = $1 FOR UPDATE',
      [invoiceId],
    )
    if (invoice!.status !== 'pending_review' || run!.status !== 'pending_review') {
      throw new InvoiceNotPending(`invoice ${invoiceId} is ${invoice!.status}`)
    }
    await query("UPDATE invoices SET status = 'running' WHERE id = $1", [invoiceId])
    await query("UPDATE runs SET status = 'running' WHERE id = $1", [runId])
    return { runId, threadId: run!.thread_id, profile: run!.profile }
  })
}

async function writeOutcome(
  query: Query,
  invoiceId: string,
  outcome: Outcome,
): Promise<InvoiceStatus> {
  const [row] = await query<{ reviewed: boolean }>(
    'SELECT extracted IS NOT NULL AS reviewed FROM invoices WHERE id = $1 FOR UPDATE',
    [invoiceId],
  )
  const { reviewed } = row!
  if (outcome instanceof Passed) {
    if (reviewed) {
      throw new Error(`invoice ${invoiceId} was under review; it ends with a decision`)
    }
    await query(
      "UPDATE invoices SET status = 'done', extracted = $1, failed_rules = '[]', final = $2" +
        ' WHERE id = $3',
      [JSON.stringify(outcome.extracted), JSON.stringify(outcome.invoice), invoiceId],
    )
    return 'done'
  }
  if (!reviewed) {
    throw new Error(`invoice ${invoiceId} was never under review; there is no decision`)
  }
  if (outcome instanceof Approved) {
    await query(
      "UPDATE invoices SET status = 'approved', final = $1, decision = $2, note = $3," +
        ' override = $4, decided_at = now() WHERE id = $5',
      [
        JSON.stringify(outcome.invoice),
        outcome.decision,
        outcome.note,
        outcome.decision === 'approve',
        invoiceId,
      ],
    )
    return 'approved'
  }
  await query(
    "UPDATE invoices SET status = 'rejected', decision = 'reject', note = $1," +
      ' decided_at = now() WHERE id = $2',
    [outcome.note, invoiceId],
  )
  return 'rejected'
}

export async function finishExtraction(
  db: Database,
  runId: string,
  totals: RunTotals,
  outcome: Outcome,
  options: Options = {},
): Promise<number> {
  return transaction(db, options.signal, async (query) => {
    const invoiceId = await lockExtraction(query, runId)
    const status = await writeOutcome(query, invoiceId, outcome)
    await close(query, runId, 'done', totals, null)
    return append(query, runId, 'final', { invoice_id: invoiceId, status })
  })
}

export async function failExtraction(
  db: Database,
  runId: string,
  totals: RunTotals,
  error: string,
  options: Options = {},
): Promise<number> {
  return transaction(db, options.signal, async (query) => {
    const invoiceId = await lockExtraction(query, runId)
    await query("UPDATE invoices SET status = 'failed' WHERE id = $1", [invoiceId])
    return terminate(query, runId, totals, undefined, error)
  })
}

export async function listInvoices(db: Database, options: Options = {}): Promise<InvoiceItem[]> {
  return transaction(db, options.signal, (query) => query<InvoiceItem>(INVOICES))
}
