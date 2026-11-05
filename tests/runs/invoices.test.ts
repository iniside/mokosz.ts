import { randomUUID } from 'node:crypto'
import type { MastraMemory } from '@mastra/core/memory'
import { Client, Pool } from 'pg'
import { inject } from 'vitest'
import { ZodError } from 'zod'
import { upgradeHead } from '../../src/db/index.ts'
import { Decimal } from '../../src/decimal.ts'
import { ExtractedInvoice, Failure, Invoice, validate } from '../../src/invoices/index.ts'
import { ConversationNotFound } from '../../src/mastra/memory.ts'
import * as conversations from '../../src/runs/conversations.ts'
import type { RunTotals } from '../../src/runs/conversations.ts'
import * as invoiceStore from '../../src/runs/invoices.ts'
import { Approved, Passed, Rejected } from '../../src/runs/invoices.ts'
import type { InvoiceItem, Outcome } from '../../src/runs/invoices.ts'
import type { Database } from '../../src/runs/transaction.ts'
import * as readModel from '../../src/runs/turns.ts'
import { endWithin } from '../support/databases.ts'
import { describe, expect, test as harnessTest } from '../support/harness.ts'
import { connect, expectIdle, intercepted, openMastra } from './helpers.ts'

type Json = Record<string, unknown>
type Sample = 'clean' | 'missing_date' | 'dated' | 'wrong_total' | 'unparseable' | 'two_wrong'

const MODEL = 'ollama_chat/qwen3.6:27b'

const CLEAN_JSON = {
  number: 'RE-2026-0001',
  issue_date: '2026-08-16',
  sale_date: '2026-08-16',
  currency: 'EUR',
  seller: {
    name: 'Krause Reichmann GmbH & Co. KG',
    tax_id: 'DE455790360',
    country: 'DE',
    address: 'Kohlgasse 82-48, 44315 Passau',
  },
  buyer: {
    name: 'Wulff',
    tax_id: 'DE626329304',
    country: 'DE',
    address: 'Margarete-Pergande-Ring 46-46, 87838 Zschopau',
  },
  lines: [
    {
      description: 'Beratungsleistung (Std.)',
      quantity: '26',
      unit_net: '163.87',
      vat_rate: '19',
      net: '4260.62',
    },
    {
      description: 'Zeitschriftenabonnement',
      quantity: '4',
      unit_net: '70.71',
      vat_rate: '7',
      net: '282.84',
    },
    { description: 'Fachbuch', quantity: '12', unit_net: '88.21', vat_rate: '7', net: '1058.52' },
    {
      description: 'Bürostuhl, ergonomisch',
      quantity: '10',
      unit_net: '401.61',
      vat_rate: '19',
      net: '4016.10',
    },
  ],
  total_net: '9618.08',
  total_vat: '1666.48',
  total_gross: '11284.56',
}
const MISSING_DATE_JSON = {
  number: 'RE-2026-0002',
  issue_date: null,
  sale_date: '2026-09-16',
  currency: 'EUR',
  seller: {
    name: 'Schüler GmbH',
    tax_id: 'DE701815628',
    country: 'DE',
    address: 'Bolnbachplatz 55, 37321 Tirschenreuth',
  },
  buyer: {
    name: 'Thies AG & Co. KGaA',
    tax_id: 'DE299819864',
    country: 'DE',
    address: 'Leopoldine-Ladeck-Allee 4949, 83578 Siegen',
  },
  lines: [
    {
      description: 'Schulungsveranstaltung',
      quantity: '1',
      unit_net: '1751.05',
      vat_rate: '19',
      net: '1751.05',
    },
  ],
  total_net: '1751.05',
  total_vat: '332.70',
  total_gross: '2083.75',
}
const DATED_JSON = { ...MISSING_DATE_JSON, issue_date: '2026-08-20' }
const WRONG_TOTAL_JSON = { ...DATED_JSON, total_gross: '1.00' }
// The JSON of each sample, which is also what its typed invoice writes.
const DUMPS = {
  clean: CLEAN_JSON,
  missing_date: MISSING_DATE_JSON,
  dated: DATED_JSON,
  wrong_total: WRONG_TOTAL_JSON,
  unparseable: { ...DATED_JSON, total_net: '1 234,56' },
  two_wrong: { ...WRONG_TOTAL_JSON, total_vat: '0.00' },
} satisfies Record<Sample, Json>
const NO_ISSUE_DATE = {
  rule: 'required_fields',
  message: 'issue_date is missing',
  fields: ['issue_date'],
}
const NET_NOT_PARSEABLE = { message: 'total_net is not parseable', fields: ['total_net'] }
// 19 % of 1751.05 is 332.6995, 332.70 half up; 1751.05 + 332.70 is 2083.75.
const FAILURES: Record<Sample, Json[]> = {
  clean: [],
  missing_date: [NO_ISSUE_DATE],
  dated: [],
  wrong_total: [
    {
      rule: 'gross_total',
      message: 'total_gross is 1.00, total_net plus total_vat is 2083.75',
      fields: ['total_gross'],
    },
  ],
  unparseable: [
    { rule: 'lines_total', ...NET_NOT_PARSEABLE },
    { rule: 'gross_total', ...NET_NOT_PARSEABLE },
  ],
  two_wrong: [
    {
      rule: 'vat_total',
      message: 'total_vat is 0.00, the rate groups give 332.70',
      fields: ['total_vat'],
    },
    {
      rule: 'gross_total',
      message: 'total_gross is 1.00, total_net plus total_vat is 1751.05',
      fields: ['total_gross'],
    },
  ],
}

const CLEAN = ExtractedInvoice.parse(CLEAN_JSON)
const MISSING_DATE = ExtractedInvoice.parse(MISSING_DATE_JSON)
const DATED: ExtractedInvoice = { ...MISSING_DATE, issue_date: '2026-08-20' }
const WRONG_TOTAL: ExtractedInvoice = {
  ...MISSING_DATE,
  issue_date: '2026-08-20',
  total_gross: '1.00',
}

const FIRST: RunTotals = {
  tokensIn: 1000,
  tokensOut: 200,
  costUsd: new Decimal('0.010000'),
  latencyMs: 5000,
  path: ['extractor', 'validator', 'human_review'],
  models: [MODEL],
}
const SECOND: RunTotals = {
  tokensIn: 0,
  tokensOut: 0,
  costUsd: new Decimal('0.000250'),
  latencyMs: 40,
  path: ['human_review', 'validator', 'human_review'],
  models: ['other/model', MODEL],
}
const THIRD: RunTotals = {
  tokensIn: 7,
  tokensOut: 3,
  costUsd: new Decimal('0.000001'),
  latencyMs: 2,
  path: ['human_review'],
  models: [],
}

function checked(extracted: ExtractedInvoice): [Invoice, Failure[]] {
  const result = validate(extracted)
  expect(result.invoice).not.toBeNull()
  return [result.invoice!, [...result.failures]]
}

const [CLEAN_INVOICE, CLEAN_FAILURES] = checked(CLEAN)
const [, MISSING_DATE_FAILURES] = checked(MISSING_DATE)
const [DATED_INVOICE, DATED_FAILURES] = checked(DATED)
const [, WRONG_TOTAL_FAILURES] = checked(WRONG_TOTAL)
const UNPARSEABLE: ExtractedInvoice = { ...DATED, total_net: '1 234,56' }
const UNPARSEABLE_FAILURES = [...validate(UNPARSEABLE).failures]
const TWO_WRONG: ExtractedInvoice = { ...WRONG_TOTAL, total_vat: '0.00' }
const SAMPLES: Record<Sample, ExtractedInvoice> = {
  clean: CLEAN,
  missing_date: MISSING_DATE,
  dated: DATED,
  wrong_total: WRONG_TOTAL,
  unparseable: UNPARSEABLE,
  two_wrong: TWO_WRONG,
}

const test = harnessTest
  .extend('memory', { scope: 'file' }, async ({}, { onCleanup }): Promise<MastraMemory> => {
    const mastra = await openMastra(inject('testDatabaseUrl'))
    onCleanup(() => mastra.close())
    return mastra.memory
  })
  .extend('pool', async ({ testSettings }, { onCleanup }): Promise<Pool> => {
    // One connection, so a transaction left open would be seen by the next statement.
    const pool = new Pool({ connectionString: testSettings.databaseUrl, max: 1 })
    onCleanup(() => endWithin(pool))
    return pool
  })
  .extend('observer', async ({ testSettings }, { onCleanup }): Promise<Client> => {
    const client = await connect(testSettings.databaseUrl)
    onCleanup(() => client.end())
    return client
  })
  .extend('migratedUrl', async ({ throwawayDatabaseUrl }): Promise<string> => {
    await upgradeHead(throwawayDatabaseUrl)
    return throwawayDatabaseUrl
  })

interface InvoiceRow {
  status: string
  run_id: string
  thread_id: string
  pdf_path: string
  extracted: Json | null
  failed_rules: Json[] | null
  final: Json | null
  decision: string | null
  note: string | null
  override: boolean | null
  decided: boolean
}

async function invoiceRow(observer: Client, invoiceId: string): Promise<InvoiceRow> {
  const { rows } = await observer.query<InvoiceRow>(
    'SELECT status, run_id, thread_id, pdf_path, extracted, failed_rules, final, decision,' +
      ' note, override, decided_at IS NOT NULL AS decided FROM invoices WHERE id = $1',
    [invoiceId],
  )
  expect(rows).toHaveLength(1)
  return rows[0]!
}

interface RunRow {
  kind: string
  thread_id: string
  conversation_id: string | null
  invoice_id: string | null
  question: string | null
  status: string
  profile: string
  tokens_in: number
  tokens_out: number
  cost_usd: string
  latency_ms: number | null
  path: string[]
  models: string[]
  error: string | null
  finished: boolean
}

async function runRow(observer: Client, runId: string): Promise<RunRow> {
  const { rows } = await observer.query<RunRow>(
    'SELECT kind, thread_id, conversation_id, invoice_id, question, status, profile,' +
      ' tokens_in, tokens_out, cost_usd, latency_ms, path, models, error,' +
      ' finished_at IS NOT NULL AS finished FROM runs WHERE id = $1',
    [runId],
  )
  expect(rows).toHaveLength(1)
  return rows[0]!
}

interface Totals {
  tokensIn: number
  tokensOut: number
  costUsd: string
  latencyMs: number | null
  path: string[]
  models: string[]
}

function totalsOf(run: RunRow): Totals {
  return {
    tokensIn: run.tokens_in,
    tokensOut: run.tokens_out,
    costUsd: run.cost_usd,
    latencyMs: run.latency_ms,
    path: run.path,
    models: run.models,
  }
}

// What numeric(12, 6) gives back for a segment sum: every sample cost has six places.
function added(...segments: RunTotals[]): Totals {
  return {
    tokensIn: segments.reduce((sum, t) => sum + t.tokensIn, 0),
    tokensOut: segments.reduce((sum, t) => sum + t.tokensOut, 0),
    costUsd: segments.reduce((sum, t) => sum.plus(t.costUsd), new Decimal(0)).toString(),
    latencyMs: segments.reduce((sum, t) => sum + t.latencyMs, 0),
    path: segments.flatMap((t) => t.path),
    models: [...new Set(segments.flatMap((t) => t.models))],
  }
}

async function events(observer: Client, runId: string): Promise<[number, string, unknown][]> {
  const { rows } = await observer.query<{ seq: number; type: string; payload: unknown }>(
    'SELECT seq, type, payload FROM run_events WHERE run_id = $1 ORDER BY seq',
    [runId],
  )
  return rows.map((row) => [row.seq, row.type, row.payload])
}

async function upload(db: Database): Promise<[string, string]> {
  const invoiceId = randomUUID()
  const runId = await invoiceStore.createInvoice(db, {
    invoiceId,
    pdfPath: `data/uploads/${invoiceId}.pdf`,
    profile: 'local-qwen',
  })
  return [invoiceId, runId]
}

async function pending(
  db: Database,
  extracted: ExtractedInvoice = MISSING_DATE,
): Promise<[string, string]> {
  const [invoiceId, runId] = await upload(db)
  await conversations.appendEvent(db, runId, 'step_started', { node: 'extractor' })
  await invoiceStore.interruptExtraction(db, runId, FIRST, {
    extracted,
    failedRules: validate(extracted).failures,
  })
  return [invoiceId, runId]
}

function failAppends(pool: Pool): Database {
  return intercepted(pool, async (sql, execute) => {
    if (sql.includes('INSERT INTO run_events')) throw new Error('event insert failed')
    return execute()
  })
}

const fieldsOf = (row: InvoiceRow) => [row.final, row.decision, row.note, row.override, row.decided]

// The created_at values the scenario test sets: whole seconds, fractions, an offset, the 1 µs edges.
const CREATED_AT = [
  '2026-11-04 10:00:00+00',
  '2026-11-04 10:00:00.12+00',
  '2026-11-04 12:00:00.123456+02',
  '2026-11-04 10:30:00.000001+00',
  '2026-11-04 10:45:59.999999+00',
  '2026-11-04 12:30:00.25+00',
  '2026-11-04 13:00:00.5+00',
  '2026-11-04 09:59:59.999999+00',
]

function storedInvoice(index: number, status: string, fields: Partial<InvoiceRow> = {}): Json {
  return {
    status,
    run_id: `<run ${index}>`,
    thread_id: `invoice:<invoice ${index}>`,
    pdf_path: `data/uploads/<invoice ${index}>.pdf`,
    extracted: null,
    failed_rules: null,
    final: null,
    decision: null,
    note: null,
    override: null,
    decided: false,
    ...fields,
  }
}

function storedRun(
  index: number,
  status: string,
  totals: Omit<Totals, 'latencyMs'> & { latencyMs: number | null },
  error: string | null,
  finished: boolean,
): Json {
  return {
    kind: 'extraction',
    thread_id: `invoice:<invoice ${index}>`,
    conversation_id: null,
    invoice_id: `<invoice ${index}>`,
    question: null,
    status,
    profile: 'local-qwen',
    tokens_in: totals.tokensIn,
    tokens_out: totals.tokensOut,
    cost_usd: totals.costUsd,
    latency_ms: totals.latencyMs,
    path: totals.path,
    models: totals.models,
    error,
    finished,
  }
}

const EXTRACTOR: [string, Json] = ['step_started', { node: 'extractor' }]

function storedEvents(...items: [string, Json][]): [number, string, Json][] {
  return items.map(([type, payload], i) => [i + 1, type, payload])
}

const interrupt = (index: number, sample: Sample | Json[]): [string, Json] => [
  'interrupt',
  {
    invoice_id: `<invoice ${index}>`,
    failed_rules: typeof sample === 'string' ? FAILURES[sample] : sample,
  },
]
const final = (index: number, status: string): [string, Json] => [
  'final',
  { status, invoice_id: `<invoice ${index}>` },
]
const RESTARTED: [string, Json] = ['error', { message: 'interrupted by restart' }]
const TIMED_OUT = 'LLMError: extractor timed out'
const NO_VAT: Json[] = ['vat_total', 'gross_total'].map((rule) => ({
  rule,
  message: 'total_vat is missing',
  fields: ['total_vat'],
}))
const RENAMED_JSON = { ...DATED_JSON, seller: { ...DATED_JSON.seller, name: 'Edited GmbH' } }
const CLAIMED_JSON = { ...DATED_JSON, total_vat: null }

interface Summary {
  number: string
  seller: { name: string }
  total_gross: string
  currency: string
}

function listItem(
  index: number,
  status: string,
  sample: Summary | null,
  failedRuleCount: number,
  createdAt: string,
): Json {
  return {
    id: `<invoice ${index}>`,
    status,
    number: sample?.number ?? null,
    seller_name: sample?.seller.name ?? null,
    total_gross: sample?.total_gross ?? null,
    currency: sample?.currency ?? null,
    failed_rule_count: failedRuleCount,
    created_at: createdAt,
  }
}

const SCENARIO = {
  interrupted: ['<run 0>', '<run 7>'],
  invoices: [
    storedInvoice(0, 'failed'),
    storedInvoice(1, 'done', { extracted: DUMPS.clean, failed_rules: [], final: DUMPS.clean }),
    storedInvoice(2, 'pending_review', {
      extracted: DUMPS.two_wrong,
      failed_rules: FAILURES.two_wrong,
    }),
    storedInvoice(3, 'approved', {
      extracted: DUMPS.missing_date,
      failed_rules: FAILURES.missing_date,
      final: RENAMED_JSON,
      decision: 'edit',
      override: false,
      decided: true,
    }),
    storedInvoice(4, 'approved', {
      extracted: DUMPS.unparseable,
      failed_rules: FAILURES.unparseable,
      final: DUMPS.unparseable,
      decision: 'approve',
      note: 'checked ✓',
      override: true,
      decided: true,
    }),
    storedInvoice(5, 'rejected', {
      extracted: DUMPS.wrong_total,
      failed_rules: FAILURES.wrong_total,
      decision: 'reject',
      note: 'nie nasz dostawca',
      decided: true,
    }),
    storedInvoice(6, 'failed', {
      extracted: DUMPS.missing_date,
      failed_rules: FAILURES.missing_date,
    }),
    storedInvoice(7, 'failed', { extracted: CLAIMED_JSON, failed_rules: NO_VAT }),
  ],
  runs: [
    storedRun(
      0,
      'failed',
      { tokensIn: 0, tokensOut: 0, costUsd: '0.000000', latencyMs: null, path: [], models: [] },
      'interrupted by restart',
      true,
    ),
    storedRun(1, 'done', added(FIRST), null, true),
    storedRun(2, 'pending_review', added(FIRST), null, false),
    storedRun(3, 'done', added(FIRST, SECOND), null, true),
    storedRun(4, 'done', added(FIRST, THIRD), null, true),
    storedRun(5, 'done', added(FIRST, SECOND, THIRD), null, true),
    storedRun(6, 'failed', added(FIRST, SECOND), TIMED_OUT, true),
    storedRun(7, 'failed', added(FIRST), 'interrupted by restart', true),
  ],
  events: [
    storedEvents(EXTRACTOR, RESTARTED),
    storedEvents(EXTRACTOR, final(1, 'done')),
    storedEvents(EXTRACTOR, interrupt(2, 'two_wrong')),
    storedEvents(EXTRACTOR, interrupt(3, 'missing_date'), final(3, 'approved')),
    storedEvents(EXTRACTOR, interrupt(4, 'unparseable'), final(4, 'approved')),
    storedEvents(
      EXTRACTOR,
      interrupt(5, 'missing_date'),
      ['step_started', { node: 'validator' }],
      interrupt(5, 'wrong_total'),
      final(5, 'rejected'),
    ),
    storedEvents(EXTRACTOR, interrupt(6, 'missing_date'), ['error', { message: TIMED_OUT }]),
    storedEvents(EXTRACTOR, interrupt(7, NO_VAT), RESTARTED),
  ],
  // Newest first, in UTC with microseconds.
  list: [
    listItem(6, 'failed', DUMPS.missing_date, 1, '2026-11-04T13:00:00.500Z'),
    listItem(5, 'rejected', DUMPS.wrong_total, 1, '2026-11-04T12:30:00.250Z'),
    listItem(4, 'approved', DUMPS.unparseable, 2, '2026-11-04T10:45:59.999Z'),
    listItem(3, 'approved', RENAMED_JSON, 1, '2026-11-04T10:30:00.000Z'),
    listItem(2, 'pending_review', DUMPS.two_wrong, 2, '2026-11-04T10:00:00.123Z'),
    listItem(1, 'done', DUMPS.clean, 0, '2026-11-04T10:00:00.120Z'),
    listItem(0, 'failed', null, 0, '2026-11-04T10:00:00.000Z'),
    listItem(7, 'failed', CLAIMED_JSON, 2, '2026-11-04T09:59:59.999Z'),
  ],
}

describe('invoice store', () => {
  test('the sample invoices fail as the tests assume', () => {
    expect(CLEAN_FAILURES).toEqual([])
    expect(DATED_FAILURES).toEqual([])
    expect(MISSING_DATE_FAILURES.map((f) => f.rule)).toEqual(['required_fields'])
    expect(WRONG_TOTAL_FAILURES.map((f) => f.rule)).toEqual(['gross_total'])
    expect(validate(UNPARSEABLE).invoice).toBeNull()
    expect(UNPARSEABLE_FAILURES.map((f) => f.rule)).toEqual(['lines_total', 'gross_total'])
    expect(validate(TWO_WRONG).failures.map((f) => f.rule)).toEqual(['vat_total', 'gross_total'])

    const names: Sample[] = [
      'clean',
      'missing_date',
      'dated',
      'wrong_total',
      'unparseable',
      'two_wrong',
    ]
    expect(Object.keys(SAMPLES)).toEqual(names)
    expect(Object.keys(DUMPS)).toEqual(names)
    for (const name of names) {
      expect(JSON.parse(JSON.stringify(SAMPLES[name]))).toEqual(DUMPS[name])
      expect(JSON.parse(JSON.stringify(validate(SAMPLES[name]).failures))).toEqual(FAILURES[name])
    }
    expect(JSON.parse(JSON.stringify(CLEAN_INVOICE))).toEqual(DUMPS.clean)
    expect(JSON.parse(JSON.stringify(DATED_INVOICE))).toEqual(DUMPS.dated)
  })

  test('upload inserts the invoice and its run together', async ({ pool, observer }) => {
    const [invoiceId, runId] = await upload(pool)

    await expectIdle(pool, observer)
    expect(await invoiceRow(observer, invoiceId)).toEqual({
      status: 'running',
      run_id: runId,
      thread_id: `invoice:${invoiceId}`,
      pdf_path: `data/uploads/${invoiceId}.pdf`,
      extracted: null,
      failed_rules: null,
      final: null,
      decision: null,
      note: null,
      override: null,
      decided: false,
    })
    expect(await runRow(observer, runId)).toEqual({
      kind: 'extraction',
      thread_id: `invoice:${invoiceId}`,
      conversation_id: null,
      invoice_id: invoiceId,
      question: null,
      status: 'running',
      profile: 'local-qwen',
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: '0.000000',
      latency_ms: null,
      path: [],
      models: [],
      error: null,
      finished: false,
    })
    expect(invoiceStore.invoiceThreadId(invoiceId)).toBe(`invoice:${invoiceId}`)
  })

  test('upload inserts nothing when the run insert fails', async ({ pool, memory, observer }) => {
    const conversation = await conversations.createConversation(memory)
    // Taken only in runs, so the invoice insert succeeds and the run insert fails after it.
    const taken = await conversations.startRun(pool, memory, {
      conversationId: conversation,
      question: 'q',
      profile: 'p',
    })
    const statements: string[] = []
    const colliding = intercepted(pool, async (sql, execute, params) => {
      statements.push(sql)
      if (sql.startsWith('INSERT INTO invoices'))
        return execute([params![0], taken, ...params!.slice(2)])
      if (sql.startsWith('INSERT INTO runs')) return execute([taken, ...params!.slice(1)])
      return execute()
    })
    const invoiceId = randomUUID()

    await expect(
      invoiceStore.createInvoice(colliding, { invoiceId, pdfPath: 'x.pdf', profile: 'p' }),
    ).rejects.toMatchObject({ code: '23505', constraint: 'runs_pkey' })

    expect(statements.filter((sql) => sql.startsWith('INSERT'))).toHaveLength(2)
    await expectIdle(pool, observer)
    const { rows: invoices } = await observer.query(
      'SELECT count(*)::int AS n FROM invoices WHERE id = $1 OR run_id = $2',
      [invoiceId, taken],
    )
    expect(invoices).toEqual([{ n: 0 }])
    const { rows: runs } = await observer.query(
      'SELECT kind, invoice_id FROM runs WHERE id = $1 OR invoice_id = $2',
      [taken, invoiceId],
    )
    expect(runs).toEqual([{ kind: 'qa', invoice_id: null }])
  })

  test('passed writes the extraction and the final without a decision', async ({
    pool,
    observer,
  }) => {
    const [invoiceId, runId] = await upload(pool)
    await conversations.appendEvent(pool, runId, 'step_started', { node: 'extractor' })
    const totals = { ...FIRST, path: ['extractor', 'validator'] }
    const padded = { ...CLEAN_JSON, number: ' RE-2026-0001 ', total_net: ' 9618.08 ' }
    const result = validate(ExtractedInvoice.parse(padded))
    expect([result.passed, result.invoice]).toEqual([true, CLEAN_INVOICE])

    const seq = await invoiceStore.finishExtraction(
      pool,
      runId,
      totals,
      new Passed({ extracted: ExtractedInvoice.parse(padded), invoice: result.invoice! }),
    )

    expect(seq).toBe(2)
    await expectIdle(pool, observer)
    const row = await invoiceRow(observer, invoiceId)
    expect(row.status).toBe('done')
    expect(row.extracted).toEqual(padded)
    expect(row.failed_rules).toEqual([])
    expect(row.final).toEqual(DUMPS.clean)
    expect(Invoice.parse(row.final)).toEqual(CLEAN_INVOICE)
    expect([row.decision, row.note, row.override, row.decided]).toEqual([null, null, null, false])
    const run = await runRow(observer, runId)
    expect([run.status, run.error, run.finished]).toEqual(['done', null, true])
    expect(totalsOf(run)).toEqual(added(totals))
    expect((await events(observer, runId)).at(-1)).toEqual([
      2,
      'final',
      { invoice_id: invoiceId, status: 'done' },
    ])
  })

  test('interrupt waits with the invoice, its failures and the totals so far', async ({
    pool,
    observer,
  }) => {
    const [invoiceId, runId] = await upload(pool)
    await conversations.appendEvent(pool, runId, 'step_started', { node: 'extractor' })

    const seq = await invoiceStore.interruptExtraction(pool, runId, FIRST, {
      extracted: MISSING_DATE,
      failedRules: MISSING_DATE_FAILURES,
    })

    expect(seq).toBe(2)
    await expectIdle(pool, observer)
    const row = await invoiceRow(observer, invoiceId)
    expect(row.status).toBe('pending_review')
    expect(row.extracted).toEqual(DUMPS.missing_date)
    expect(ExtractedInvoice.parse(row.extracted)).toEqual(MISSING_DATE)
    expect(row.failed_rules).toEqual(FAILURES.missing_date)
    expect(row.failed_rules!.map((f) => Failure.parse(f))).toEqual(MISSING_DATE_FAILURES)
    expect(fieldsOf(row)).toEqual([null, null, null, null, false])
    const run = await runRow(observer, runId)
    expect([run.status, run.error, run.finished]).toEqual(['pending_review', null, false])
    expect(totalsOf(run)).toEqual(added(FIRST))
    expect((await events(observer, runId)).at(-1)).toEqual([
      2,
      'interrupt',
      { invoice_id: invoiceId, failed_rules: FAILURES.missing_date },
    ])
    const seen = await conversations.eventsAfter(pool, runId, 0)
    expect(seen!.status).toBe('pending_review')
    expect(seen!.events.map((e) => e.type)).toEqual(['step_started', 'interrupt'])
  })

  test('claim runs again with the columns unchanged', async ({ pool, observer }) => {
    const [invoiceId, runId] = await pending(pool)
    const before = await invoiceRow(observer, invoiceId)

    const claimed = await invoiceStore.claimDecision(pool, invoiceId)

    await expectIdle(pool, observer)
    expect(claimed).toEqual({
      runId,
      threadId: `invoice:${invoiceId}`,
      profile: 'local-qwen',
    })
    expect(await invoiceRow(observer, invoiceId)).toEqual({ ...before, status: 'running' })
    const run = await runRow(observer, runId)
    expect([run.status, run.finished]).toEqual(['running', false])
    expect(totalsOf(run)).toEqual(added(FIRST))
    expect((await events(observer, runId)).map(([, type]) => type)).toEqual([
      'step_started',
      'interrupt',
    ])
  })

  test('approve override keeps the failures and writes the decision', async ({
    pool,
    observer,
  }) => {
    const [invoiceId, runId] = await pending(pool)
    const [reviewed] = checked(MISSING_DATE)
    await invoiceStore.claimDecision(pool, invoiceId)

    const seq = await invoiceStore.finishExtraction(
      pool,
      runId,
      THIRD,
      new Approved({
        decision: 'approve',
        invoice: reviewed,
        note: 'date is on the delivery note',
      }),
    )

    expect(seq).toBe(3)
    const row = await invoiceRow(observer, invoiceId)
    expect(row.status).toBe('approved')
    expect(row.extracted).toEqual(DUMPS.missing_date)
    expect(row.failed_rules).toEqual(FAILURES.missing_date)
    expect(row.final).toEqual(DUMPS.missing_date)
    expect([row.decision, row.note, row.override, row.decided]).toEqual([
      'approve',
      'date is on the delivery note',
      true,
      true,
    ])
    const run = await runRow(observer, runId)
    expect([run.status, run.error, run.finished]).toEqual(['done', null, true])
    expect((await events(observer, runId)).at(-1)).toEqual([
      3,
      'final',
      { invoice_id: invoiceId, status: 'approved' },
    ])
  })

  test('approve override records an invoice whose values do not parse', async ({
    pool,
    observer,
  }) => {
    const [invoiceId, runId] = await pending(pool, UNPARSEABLE)
    await invoiceStore.claimDecision(pool, invoiceId)

    await invoiceStore.finishExtraction(
      pool,
      runId,
      THIRD,
      new Approved({ decision: 'approve', invoice: UNPARSEABLE, note: 'net is 1234.56, checked' }),
    )

    const row = await invoiceRow(observer, invoiceId)
    expect(row.status).toBe('approved')
    expect(row.extracted).toEqual(DUMPS.unparseable)
    expect(row.failed_rules).toEqual(FAILURES.unparseable)
    expect(row.final).toEqual(DUMPS.unparseable)
    expect(row.final!.total_net).toBe('1 234,56')
    expect([row.decision, row.note, row.override, row.decided]).toEqual([
      'approve',
      'net is 1234.56, checked',
      true,
      true,
    ])
    expect((await events(observer, runId)).at(-1)!.slice(1)).toEqual([
      'final',
      { invoice_id: invoiceId, status: 'approved' },
    ])
    const item = (await invoiceStore.listInvoices(pool)).find((i) => i.id === invoiceId)!
    expect([item.status, item.number, item.total_gross, item.failed_rule_count]).toEqual([
      'approved',
      UNPARSEABLE.number,
      UNPARSEABLE.total_gross,
      2,
    ])
  })

  test.for([{ note: null }, { note: 'added the date from the delivery note' }])(
    'edit pass approves the edited invoice without override: %j',
    async ({ note }, { pool, observer }) => {
      const [invoiceId, runId] = await pending(pool)
      await invoiceStore.claimDecision(pool, invoiceId)

      await invoiceStore.finishExtraction(
        pool,
        runId,
        SECOND,
        new Approved({ decision: 'edit', invoice: DATED_INVOICE, note }),
      )

      const row = await invoiceRow(observer, invoiceId)
      expect(row.status).toBe('approved')
      expect(row.extracted).toEqual(DUMPS.missing_date)
      expect(row.failed_rules).toEqual(FAILURES.missing_date)
      expect(row.final).toEqual(DUMPS.dated)
      expect(row.final!.issue_date).toBe('2026-08-20')
      expect(row.override).toBe(false)
      expect([row.decision, row.note, row.override, row.decided]).toEqual([
        'edit',
        note,
        false,
        true,
      ])
    },
  )

  test('edit fail waits again with the edited invoice and the new failures', async ({
    pool,
    observer,
  }) => {
    const [invoiceId, runId] = await pending(pool)
    await invoiceStore.claimDecision(pool, invoiceId)
    await conversations.appendEvent(pool, runId, 'step_started', { node: 'validator' })

    const seq = await invoiceStore.interruptExtraction(pool, runId, SECOND, {
      extracted: WRONG_TOTAL,
      failedRules: WRONG_TOTAL_FAILURES,
    })

    expect(seq).toBe(4)
    const row = await invoiceRow(observer, invoiceId)
    expect(row.status).toBe('pending_review')
    expect(row.extracted).toEqual(DUMPS.wrong_total)
    expect(row.failed_rules).toEqual(FAILURES.wrong_total)
    expect(fieldsOf(row)).toEqual([null, null, null, null, false])
    const run = await runRow(observer, runId)
    expect([run.status, run.finished]).toEqual(['pending_review', false])
    expect(totalsOf(run)).toEqual(added(FIRST, SECOND))
    expect((await events(observer, runId)).at(-1)!.slice(1)).toEqual([
      'interrupt',
      { invoice_id: invoiceId, failed_rules: FAILURES.wrong_total },
    ])
  })

  test('reject writes the reason and no final', async ({ pool, observer }) => {
    const [invoiceId, runId] = await pending(pool)
    await invoiceStore.claimDecision(pool, invoiceId)

    await invoiceStore.finishExtraction(
      pool,
      runId,
      THIRD,
      new Rejected({ note: 'not our supplier' }),
    )

    const row = await invoiceRow(observer, invoiceId)
    expect(row.status).toBe('rejected')
    expect(row.extracted).toEqual(DUMPS.missing_date)
    expect(row.failed_rules).toEqual(FAILURES.missing_date)
    expect(fieldsOf(row)).toEqual([null, 'reject', 'not our supplier', null, true])
    expect((await runRow(observer, runId)).status).toBe('done')
    expect((await events(observer, runId)).at(-1)!.slice(1)).toEqual([
      'final',
      { invoice_id: invoiceId, status: 'rejected' },
    ])
  })

  test('totals add across every segment and seq continues', async ({ pool, observer }) => {
    const [invoiceId, runId] = await pending(pool)
    await invoiceStore.claimDecision(pool, invoiceId)
    await conversations.appendEvent(pool, runId, 'step_started', { node: 'human_review' })
    await invoiceStore.interruptExtraction(pool, runId, SECOND, {
      extracted: WRONG_TOTAL,
      failedRules: WRONG_TOTAL_FAILURES,
    })
    await invoiceStore.claimDecision(pool, invoiceId)

    await invoiceStore.finishExtraction(pool, runId, THIRD, new Rejected({ note: 'no' }))

    const run = await runRow(observer, runId)
    expect(totalsOf(run)).toEqual({
      tokensIn: 1007,
      tokensOut: 203,
      costUsd: '0.010251',
      latencyMs: 5042,
      path: [
        'extractor',
        'validator',
        'human_review',
        'human_review',
        'validator',
        'human_review',
        'human_review',
      ],
      models: [MODEL, 'other/model'],
    })
    expect(totalsOf(run)).toEqual(added(FIRST, SECOND, THIRD))
    expect((await events(observer, runId)).map(([seq, type]) => [seq, type])).toEqual([
      [1, 'step_started'],
      [2, 'interrupt'],
      [3, 'step_started'],
      [4, 'interrupt'],
      [5, 'final'],
    ])
  })

  test.for([false, true])(
    'fail fails the invoice and the run with totals and an error event: claimed %s',
    async (claimed, { pool, observer }) => {
      let invoiceId: string
      let runId: string
      if (claimed) {
        ;[invoiceId, runId] = await pending(pool)
        await invoiceStore.claimDecision(pool, invoiceId)
      } else {
        ;[invoiceId, runId] = await upload(pool)
        await conversations.appendEvent(pool, runId, 'step_started', { node: 'extractor' })
      }
      const before = await invoiceRow(observer, invoiceId)

      const seq = await invoiceStore.failExtraction(
        pool,
        runId,
        SECOND,
        'LLMError: extractor timed out',
      )

      await expectIdle(pool, observer)
      expect(seq).toBe(claimed ? 3 : 2)
      expect(await invoiceRow(observer, invoiceId)).toEqual({ ...before, status: 'failed' })
      if (claimed) {
        expect(before.extracted).toEqual(DUMPS.missing_date)
      } else {
        expect([before.extracted, before.failed_rules]).toEqual([null, null])
      }
      const run = await runRow(observer, runId)
      expect([run.status, run.error, run.finished]).toEqual([
        'failed',
        'LLMError: extractor timed out',
        true,
      ])
      expect(totalsOf(run)).toEqual(claimed ? added(FIRST, SECOND) : added(SECOND))
      expect((await events(observer, runId)).at(-1)).toEqual([
        seq,
        'error',
        { message: 'LLMError: extractor timed out' },
      ])
      expect((await conversations.eventsAfter(pool, runId, 0))!.status).toBe('failed')
    },
  )

  test('interrupt is one transaction', async ({ pool, observer }) => {
    const [invoiceId, runId] = await upload(pool)
    const [beforeInvoice, beforeRun] = [
      await invoiceRow(observer, invoiceId),
      await runRow(observer, runId),
    ]

    await expect(
      invoiceStore.interruptExtraction(failAppends(pool), runId, FIRST, {
        extracted: MISSING_DATE,
        failedRules: MISSING_DATE_FAILURES,
      }),
    ).rejects.toThrow('event insert failed')

    await expectIdle(pool, observer)
    expect(await invoiceRow(observer, invoiceId)).toEqual(beforeInvoice)
    expect(await runRow(observer, runId)).toEqual(beforeRun)
    expect(await events(observer, runId)).toEqual([])
  })

  test.for([
    ['approve', () => new Approved({ decision: 'approve', invoice: CLEAN_INVOICE, note: 'ok' })],
    ['reject', () => new Rejected({ note: 'no' })],
  ] as const)('finish is one transaction: %s', async ([, outcome], { pool, observer }) => {
    const [invoiceId, runId] = await pending(pool)
    await invoiceStore.claimDecision(pool, invoiceId)
    const [beforeInvoice, beforeRun] = [
      await invoiceRow(observer, invoiceId),
      await runRow(observer, runId),
    ]

    await expect(
      invoiceStore.finishExtraction(failAppends(pool), runId, SECOND, outcome() as Outcome),
    ).rejects.toThrow('event insert failed')

    await expectIdle(pool, observer)
    expect(await invoiceRow(observer, invoiceId)).toEqual(beforeInvoice)
    expect(await runRow(observer, runId)).toEqual(beforeRun)
    expect(await events(observer, runId)).toHaveLength(2)
  })

  test('fail is one transaction', async ({ pool, observer }) => {
    const [invoiceId, runId] = await upload(pool)

    await expect(
      invoiceStore.failExtraction(failAppends(pool), runId, FIRST, 'boom'),
    ).rejects.toThrow('event insert failed')

    expect((await invoiceRow(observer, invoiceId)).status).toBe('running')
    const run = await runRow(observer, runId)
    expect([run.status, run.tokens_in, run.error]).toEqual(['running', 0, null])
  })

  test('concurrent claims have exactly one winner', async ({ pool, observer, testSettings }) => {
    const [invoiceId, runId] = await pending(pool)
    const claimers = new Pool({ connectionString: testSettings.databaseUrl, max: 8 })
    let results: PromiseSettledResult<invoiceStore.ClaimedRun>[]
    try {
      results = await Promise.allSettled(
        Array.from({ length: 8 }, () => invoiceStore.claimDecision(claimers, invoiceId)),
      )
    } finally {
      await claimers.end()
    }

    const winners = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
    const losers = results.flatMap((r) =>
      r.status === 'rejected' && r.reason instanceof invoiceStore.InvoiceNotPending
        ? [r.reason]
        : [],
    )
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(7)
    expect(winners[0]!.runId).toBe(runId)
    expect(losers.every((loser) => loser.message.includes('is running'))).toBe(true)
    expect((await invoiceRow(observer, invoiceId)).status).toBe('running')
    expect((await runRow(observer, runId)).status).toBe('running')
  })

  test('claim needs a pending invoice', async ({ pool, observer }) => {
    const [runningId] = await upload(pool)
    const [doneId, doneRun] = await upload(pool)
    await invoiceStore.finishExtraction(
      pool,
      doneRun,
      FIRST,
      new Passed({ extracted: CLEAN, invoice: CLEAN_INVOICE }),
    )

    for (const invoiceId of [randomUUID(), runningId, doneId]) {
      await expect(invoiceStore.claimDecision(pool, invoiceId)).rejects.toBeInstanceOf(
        invoiceStore.InvoiceNotPending,
      )
      await expectIdle(pool, observer)
    }

    expect((await invoiceRow(observer, runningId)).status).toBe('running')
    expect((await invoiceRow(observer, doneId)).status).toBe('done')
  })

  test('writes need the right run kind and state', async ({ pool, memory, observer }) => {
    const conversation = await conversations.createConversation(memory)
    const qaRun = await conversations.startRun(pool, memory, {
      conversationId: conversation,
      question: 'q',
      profile: 'p',
    })
    const [pendingId, pendingRun] = await pending(pool)
    const [runningId, runningRun] = await upload(pool)
    const passed = new Passed({ extracted: CLEAN, invoice: CLEAN_INVOICE })

    const notExtraction = `run ${qaRun} is a qa run, not an extraction run`
    await expect(
      conversations.finishRun(pool, runningRun, FIRST, { final: { invoice_id: 'x' } }),
    ).rejects.toThrow(`run ${runningRun} is an extraction run`)
    await expect(
      invoiceStore.interruptExtraction(pool, qaRun, FIRST, {
        extracted: MISSING_DATE,
        failedRules: MISSING_DATE_FAILURES,
      }),
    ).rejects.toThrow(notExtraction)
    await expect(invoiceStore.finishExtraction(pool, qaRun, FIRST, passed)).rejects.toThrow(
      notExtraction,
    )
    await expect(invoiceStore.failExtraction(pool, qaRun, FIRST, 'boom')).rejects.toThrow(
      notExtraction,
    )
    await expect(
      invoiceStore.interruptExtraction(pool, runningRun, FIRST, {
        extracted: CLEAN,
        failedRules: [],
      }),
    ).rejects.toThrow('only with failed rules')
    await expect(
      invoiceStore.finishExtraction(pool, runningRun, FIRST, new Rejected({ note: 'no' })),
    ).rejects.toThrow('was never under review')
    for (const waiting of [
      () =>
        invoiceStore.interruptExtraction(pool, pendingRun, FIRST, {
          extracted: MISSING_DATE,
          failedRules: MISSING_DATE_FAILURES,
        }),
      () => invoiceStore.finishExtraction(pool, pendingRun, FIRST, new Rejected({ note: 'no' })),
      () => invoiceStore.failExtraction(pool, pendingRun, FIRST, 'boom'),
    ]) {
      await expect(waiting()).rejects.toBeInstanceOf(conversations.RunNotRunning)
    }
    await invoiceStore.claimDecision(pool, pendingId)
    await expect(invoiceStore.finishExtraction(pool, pendingRun, FIRST, passed)).rejects.toThrow(
      'was under review; it ends with a decision',
    )

    await expectIdle(pool, observer)
    expect((await invoiceRow(observer, runningId)).status).toBe('running')
    expect((await invoiceRow(observer, pendingId)).status).toBe('running')
    for (const runId of [qaRun, runningRun]) {
      const run = await runRow(observer, runId)
      expect([run.status, run.tokens_in]).toEqual(['running', 0])
    }
    expect(totalsOf(await runRow(observer, pendingRun))).toEqual(added(FIRST))
  })

  test('outcomes need their notes', () => {
    expect(() => new Approved({ decision: 'approve', invoice: CLEAN_INVOICE })).toThrow(ZodError)
    expect(() => new Approved({ decision: 'approve', invoice: CLEAN_INVOICE, note: '' })).toThrow(
      ZodError,
    )
    expect(() => new Rejected({ note: '' })).toThrow(ZodError)
    // @ts-expect-error a missing note is a type error and a validation error at runtime
    expect(() => new Rejected({})).toThrow(ZodError)
    expect(new Approved({ decision: 'edit', invoice: CLEAN_INVOICE }).note).toBeNull()
    expect(() => new Approved({ decision: 'edit', invoice: CLEAN, note: 'x' })).toThrow(
      'only as a validated invoice',
    )
    expect(() => new Approved({ decision: 'edit', invoice: CLEAN, note: 'x' })).toThrow(ZodError)
    expect(new Approved({ decision: 'approve', invoice: UNPARSEABLE, note: 'x' }).invoice).toBe(
      UNPARSEABLE,
    )
    expect(new Approved({ decision: 'approve', invoice: CLEAN_INVOICE, note: 'x' }).invoice).toBe(
      CLEAN_INVOICE,
    )
  })

  test('invoice threads are not conversations', async ({ pool, memory }) => {
    const [invoiceId] = await upload(pool)

    for (const id of [invoiceId, invoiceStore.invoiceThreadId(invoiceId)]) {
      await expect(
        conversations.startRun(pool, memory, { conversationId: id, question: 'q', profile: 'p' }),
      ).rejects.toBeInstanceOf(ConversationNotFound)
      expect(await readModel.turns(pool, memory, id)).toBeNull()
    }
  })

  test('startup fails running extractions and leaves waiting ones', async ({ migratedUrl }) => {
    const mastra = await openMastra(migratedUrl)
    const pool = new Pool({ connectionString: migratedUrl, max: 1 })
    const observer = await connect(migratedUrl)
    try {
      const [freshId, freshRun] = await upload(pool)
      await conversations.appendEvent(pool, freshRun, 'step_started', { node: 'extractor' })
      const [claimedId, claimedRun] = await pending(pool)
      await invoiceStore.claimDecision(pool, claimedId)
      const [waitingId, waitingRun] = await pending(pool)
      const [doneId, doneRun] = await upload(pool)
      await invoiceStore.finishExtraction(
        pool,
        doneRun,
        FIRST,
        new Passed({ extracted: CLEAN, invoice: CLEAN_INVOICE }),
      )
      const conversation = await conversations.createConversation(mastra.memory)
      const qaRun = await conversations.startRun(pool, mastra.memory, {
        conversationId: conversation,
        question: 'q',
        profile: 'p',
      })
      const before = new Map<string, InvoiceRow>()
      for (const id of [claimedId, waitingId, doneId])
        before.set(id, await invoiceRow(observer, id))

      const failed = await conversations.failInterruptedRuns(pool)
      const again = await conversations.failInterruptedRuns(pool)

      expect(new Set(failed)).toEqual(new Set([freshRun, claimedRun, qaRun]))
      expect(failed).toHaveLength(3)
      expect(again).toEqual([])
      expect((await invoiceRow(observer, freshId)).status).toBe('failed')
      expect(await invoiceRow(observer, claimedId)).toEqual({
        ...before.get(claimedId),
        status: 'failed',
      })
      expect(await invoiceRow(observer, waitingId)).toEqual(before.get(waitingId))
      expect(await invoiceRow(observer, doneId)).toEqual(before.get(doneId))
      for (const runId of [freshRun, claimedRun, qaRun]) {
        const run = await runRow(observer, runId)
        expect([run.status, run.error, run.finished]).toEqual([
          'failed',
          conversations.INTERRUPTED,
          true,
        ])
        expect((await events(observer, runId)).at(-1)!.slice(1)).toEqual([
          'error',
          { message: conversations.INTERRUPTED },
        ])
      }
      expect(totalsOf(await runRow(observer, claimedRun))).toEqual(added(FIRST))
      const waiting = await runRow(observer, waitingRun)
      expect([waiting.status, waiting.error, waiting.finished]).toEqual([
        'pending_review',
        null,
        false,
      ])
      expect((await events(observer, waitingRun)).at(-1)![1]).toBe('interrupt')
      expect((await runRow(observer, doneRun)).status).toBe('done')
    } finally {
      await observer.end()
      await pool.end()
      await mastra.close()
    }
  })

  test('startup recovery is one transaction', async ({ migratedUrl }) => {
    const pool = new Pool({ connectionString: migratedUrl, max: 1 })
    const observer = await connect(migratedUrl)
    try {
      const [invoiceId, runId] = await upload(pool)

      await expect(conversations.failInterruptedRuns(failAppends(pool))).rejects.toThrow(
        'event insert failed',
      )
      await expectIdle(pool, observer)

      expect((await invoiceRow(observer, invoiceId)).status).toBe('running')
      expect((await runRow(observer, runId)).status).toBe('running')
    } finally {
      await observer.end()
      await pool.end()
    }
  })

  test('listInvoices is newest first with the list keys', async ({ migratedUrl }) => {
    const pool = new Pool({ connectionString: migratedUrl, max: 1 })
    try {
      const [runningId] = await upload(pool)
      const [doneId, doneRun] = await upload(pool)
      await invoiceStore.finishExtraction(
        pool,
        doneRun,
        FIRST,
        new Passed({ extracted: CLEAN, invoice: CLEAN_INVOICE }),
      )
      const [waitingId] = await pending(pool, TWO_WRONG)
      const [editedId, editedRun] = await pending(pool)
      await invoiceStore.claimDecision(pool, editedId)
      const renamed: Invoice = {
        ...DATED_INVOICE,
        seller: { ...DATED_INVOICE.seller, name: 'Edited GmbH' },
      }
      await invoiceStore.finishExtraction(
        pool,
        editedRun,
        SECOND,
        new Approved({ decision: 'edit', invoice: renamed }),
      )
      const ids = [runningId, doneId, waitingId, editedId]
      // Created in this order; the oldest is moved last in time to prove the sort.
      await pool.query(
        "UPDATE invoices SET created_at = created_at + interval '1 hour' WHERE id = $1",
        [runningId],
      )

      const items = await invoiceStore.listInvoices(pool)
      const { rows } = await pool.query<{ id: string; created_at: Date }>(
        'SELECT id, created_at FROM invoices',
      )
      const created = new Map(rows.map((row) => [row.id, row.created_at.getTime()]))

      expect(items.map((item) => item.id)).toEqual([runningId, editedId, waitingId, doneId])
      expect(Object.keys(items[0]!)).toEqual([
        'id',
        'status',
        'number',
        'seller_name',
        'total_gross',
        'currency',
        'failed_rule_count',
        'created_at',
      ])
      const expected: Omit<InvoiceItem, 'created_at'>[] = [
        {
          id: runningId,
          status: 'running',
          number: null,
          seller_name: null,
          total_gross: null,
          currency: null,
          failed_rule_count: 0,
        },
        {
          id: editedId,
          status: 'approved',
          number: 'RE-2026-0002',
          seller_name: 'Edited GmbH',
          total_gross: '2083.75',
          currency: 'EUR',
          failed_rule_count: 1,
        },
        {
          id: waitingId,
          status: 'pending_review',
          number: 'RE-2026-0002',
          seller_name: MISSING_DATE.seller.name,
          total_gross: '1.00',
          currency: 'EUR',
          failed_rule_count: 2,
        },
        {
          id: doneId,
          status: 'done',
          number: 'RE-2026-0001',
          seller_name: 'Krause Reichmann GmbH & Co. KG',
          total_gross: '11284.56',
          currency: 'EUR',
          failed_rule_count: 0,
        },
      ]
      expect(items.map(({ created_at: _, ...item }) => item)).toEqual(expected)
      expect(items.map((item) => Date.parse(item.created_at))).toEqual(
        expected.map((item) => created.get(item.id)),
      )
      expect(ids).toHaveLength(items.length)
    } finally {
      await pool.end()
    }
  })

  test('listInvoices on an empty table', async ({ migratedUrl }) => {
    const pool = new Pool({ connectionString: migratedUrl, max: 1 })
    try {
      expect(await invoiceStore.listInvoices(pool)).toEqual([])
    } finally {
      await pool.end()
    }
  })

  test('the store writes and returns every lifecycle state', async ({ migratedUrl }) => {
    const pool = new Pool({ connectionString: migratedUrl, max: 1 })
    try {
      const made = await scenario(pool)
      const interrupted = await conversations.failInterruptedRuns(pool)
      for (const [[invoiceId], createdAt] of made.map((ids, i) => [ids, CREATED_AT[i]!] as const)) {
        await pool.query('UPDATE invoices SET created_at = $1::timestamptz WHERE id = $2', [
          createdAt,
          invoiceId,
        ])
      }
      const invoices = []
      const runs = []
      const stored = []
      for (const [invoiceId, runId] of made) {
        const {
          rows: [invoice],
        } = await pool.query(
          'SELECT status, run_id::text, thread_id, pdf_path, extracted, failed_rules, final,' +
            ' decision, note, override, decided_at IS NOT NULL AS decided' +
            ' FROM invoices WHERE id = $1',
          [invoiceId],
        )
        invoices.push(invoice)
        const {
          rows: [run],
        } = await pool.query(
          'SELECT kind, thread_id, conversation_id, invoice_id::text, question, status,' +
            ' profile, tokens_in, tokens_out, cost_usd::text, latency_ms, path, models, error,' +
            ' finished_at IS NOT NULL AS finished FROM runs WHERE id = $1',
          [runId],
        )
        runs.push(run)
        const { rows } = await pool.query<{ seq: number; type: string; payload: unknown }>(
          'SELECT seq, type, payload FROM run_events WHERE run_id = $1 ORDER BY seq',
          [runId],
        )
        stored.push(rows.map((row) => [row.seq, row.type, row.payload]))
      }
      const listed = await invoiceStore.listInvoices(pool)

      let text = JSON.stringify({ interrupted, invoices, runs, events: stored, list: listed })
      for (const [index, [invoiceId, runId]] of made.entries()) {
        text = text.replaceAll(invoiceId, `<invoice ${index}>`).replaceAll(runId, `<run ${index}>`)
      }
      const result: typeof SCENARIO = JSON.parse(text)
      expect(result).toEqual(SCENARIO)
      // Key order too, as the list is what an API would serialise as it is.
      expect(JSON.stringify(result.list)).toBe(JSON.stringify(SCENARIO.list))
    } finally {
      await pool.end()
    }
  })

  test('a signal aborted before the call sends nothing', async ({ pool, observer }) => {
    const [invoiceId, runId] = await upload(pool)
    const reason = new Error('stop')
    const connects = { count: 0 }
    const counted = intercepted(pool, (_sql, execute) => execute(), connects)
    const signal = AbortSignal.abort(reason)

    const calls = [
      () =>
        invoiceStore.createInvoice(counted, {
          invoiceId: randomUUID(),
          pdfPath: 'x',
          profile: 'p',
          signal,
        }),
      () =>
        invoiceStore.interruptExtraction(counted, runId, FIRST, {
          extracted: MISSING_DATE,
          failedRules: MISSING_DATE_FAILURES,
          signal,
        }),
      () => invoiceStore.claimDecision(counted, invoiceId, { signal }),
      () =>
        invoiceStore.finishExtraction(
          counted,
          runId,
          FIRST,
          new Passed({ extracted: CLEAN, invoice: CLEAN_INVOICE }),
          { signal },
        ),
      () => invoiceStore.failExtraction(counted, runId, FIRST, 'x', { signal }),
      () => invoiceStore.listInvoices(counted, { signal }),
      () => conversations.failInterruptedRuns(counted, { signal }),
    ]
    for (const call of calls) await expect(call()).rejects.toBe(reason)

    expect(connects.count).toBe(0)
    expect((await invoiceRow(observer, invoiceId)).status).toBe('running')
    expect(await events(observer, runId)).toEqual([])
  })
})

// Eight invoices, one in each lifecycle state the store records.
async function scenario(db: Database): Promise<[string, string][]> {
  const started = async (): Promise<[string, string]> => {
    const ids = await upload(db)
    await conversations.appendEvent(db, ids[1], 'step_started', { node: 'extractor' })
    return ids
  }
  const waiting = async (extracted: ExtractedInvoice): Promise<[string, string]> => {
    const ids = await started()
    await invoiceStore.interruptExtraction(db, ids[1], FIRST, {
      extracted,
      failedRules: validate(extracted).failures,
    })
    return ids
  }
  const renamed: Invoice = {
    ...DATED_INVOICE,
    seller: { ...DATED_INVOICE.seller, name: 'Edited GmbH' },
  }
  const made: [string, string][] = [await started()]

  const passed = await started()
  await invoiceStore.finishExtraction(
    db,
    passed[1],
    FIRST,
    new Passed({ extracted: CLEAN, invoice: CLEAN_INVOICE }),
  )
  made.push(passed)

  made.push(await waiting(TWO_WRONG))

  const edited = await waiting(MISSING_DATE)
  await invoiceStore.claimDecision(db, edited[0])
  await invoiceStore.finishExtraction(
    db,
    edited[1],
    SECOND,
    new Approved({ decision: 'edit', invoice: renamed }),
  )
  made.push(edited)

  const override = await waiting(UNPARSEABLE)
  await invoiceStore.claimDecision(db, override[0])
  await invoiceStore.finishExtraction(
    db,
    override[1],
    THIRD,
    new Approved({ decision: 'approve', invoice: UNPARSEABLE, note: 'checked ✓' }),
  )
  made.push(override)

  const rejected = await waiting(MISSING_DATE)
  await invoiceStore.claimDecision(db, rejected[0])
  await conversations.appendEvent(db, rejected[1], 'step_started', { node: 'validator' })
  await invoiceStore.interruptExtraction(db, rejected[1], SECOND, {
    extracted: WRONG_TOTAL,
    failedRules: validate(WRONG_TOTAL).failures,
  })
  await invoiceStore.claimDecision(db, rejected[0])
  await invoiceStore.finishExtraction(
    db,
    rejected[1],
    THIRD,
    new Rejected({ note: 'nie nasz dostawca' }),
  )
  made.push(rejected)

  const failed = await waiting(MISSING_DATE)
  await invoiceStore.claimDecision(db, failed[0])
  await invoiceStore.failExtraction(db, failed[1], SECOND, 'LLMError: extractor timed out')
  made.push(failed)

  const claimed = await waiting({ ...DATED, total_vat: null })
  await invoiceStore.claimDecision(db, claimed[0])
  made.push(claimed)
  return made
}
