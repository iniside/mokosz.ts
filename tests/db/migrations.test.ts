import { randomUUID } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { runner } from 'node-pg-migrate'
import { Client, Pool, type QueryResultRow } from 'pg'
import {
  MIGRATIONS_DIR,
  MIGRATIONS_TABLE,
  migrationOptions,
  upgradeHead,
} from '../../src/db/index.ts'
import { EMBEDDING_DIM } from '../../src/retrieval/index.ts'
import { embeddingsDir } from '../../src/retrieval/embeddings.ts'
import { parseNpy } from '../../src/retrieval/npy.ts'
import { databaseOf } from '../support/databases.ts'
import { describe, expect, test } from '../support/harness.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')
const VALID_CHUNK = {
  celex: '32016R0679',
  act: 'GDPR',
  lang: 'en',
  element_id: 'rct_1',
  kind: 'recital',
  text: 'x',
  embedding: `[${Array(EMBEDDING_DIM).fill('0.5').join(',')}]`,
}
const INSERT_CHUNK =
  'INSERT INTO chunks (celex, act, lang, element_id, kind, text, embedding)' +
  ' VALUES ($1, $2, $3, $4, $5, $6, $7::vector)'

function chunkValues(chunk: typeof VALID_CHUNK): string[] {
  const { celex, act, lang, element_id, kind, text, embedding } = chunk
  return [celex, act, lang, element_id, kind, text, embedding]
}

const VECTOR_EXISTS = "SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'vector'"

async function query<T extends QueryResultRow>(url: string, sql: string): Promise<T[]> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    return (await client.query<T>(sql)).rows
  } finally {
    await client.end()
  }
}

async function vectorInstalled(url: string): Promise<boolean> {
  const [row] = await query<{ n: number }>(url, VECTOR_EXISTS)
  return row!.n > 0
}

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => name.replace(/\.sql$/, ''))
    .toSorted()
}

function head(): string {
  return migrationNames().at(-1)!
}

async function tableExists(url: string, table: string): Promise<boolean> {
  const [row] = await query<{ found: boolean }>(
    url,
    `SELECT to_regclass('${table}') IS NOT NULL AS found`,
  )
  return row!.found
}

async function chunksExists(url: string): Promise<boolean> {
  return tableExists(url, 'chunks')
}

// Migrates down to `name`: node-pg-migrate undoes every migration after it.
async function downgradeTo(url: string, name: string): Promise<void> {
  const names = migrationNames()
  const count = names.length - 1 - names.indexOf(name)
  expect(names).toContain(name)
  await runner(migrationOptions(url, 'down', count))
}

async function revision(url: string): Promise<string | null> {
  const rows = await query<{ name: string }>(
    url,
    `SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY run_on DESC, id DESC LIMIT 1`,
  )
  return rows[0]?.name ?? null
}

describe('migration 0001', () => {
  test('upgrade creates and downgrade removes vector', async ({ throwawayDatabaseUrl: url }) => {
    expect(await vectorInstalled(url)).toBe(false)

    await upgradeHead(url)
    expect(await vectorInstalled(url)).toBe(true)
    expect(await chunksExists(url)).toBe(true)
    expect(await revision(url)).toBe(head())

    await downgradeTo(url, '0001_vector_extension')
    expect(await chunksExists(url)).toBe(false)
    expect(await vectorInstalled(url)).toBe(true)

    await runner(migrationOptions(url, 'down'))
    expect(await vectorInstalled(url)).toBe(false)
    expect(await revision(url)).toBeNull()
  })

  test('upgrade is idempotent on the migrated database', async ({ testSettings }) => {
    const url = testSettings.databaseUrl
    const [row] = await query<{ current_database: string }>(url, 'SELECT current_database()')
    expect(row!.current_database).toBe(databaseOf(url))
    expect(await vectorInstalled(url)).toBe(true)

    await upgradeHead(url)

    expect(await vectorInstalled(url)).toBe(true)
    expect(await revision(url)).toBe(head())
  })

  test('a pool reaches the migrated database', async ({ testSettings }) => {
    const pool = new Pool({ connectionString: testSettings.databaseUrl })
    try {
      const { rows } = await pool.query<{ n: number }>(VECTOR_EXISTS)
      expect(rows).toEqual([{ n: 1 }])
    } finally {
      await pool.end()
    }
  })

  test('upgrade tolerates a preinstalled vector', async ({ throwawayDatabaseUrl: url }) => {
    await query(url, 'CREATE EXTENSION vector')

    await upgradeHead(url)

    expect(await vectorInstalled(url)).toBe(true)
    expect(await revision(url)).toBe(head())
  })
})

describe('migration 0002', () => {
  test('the embedding dimension matches the config and the committed file', async ({
    testSettings,
  }) => {
    const [row] = await query<{ atttypmod: number; typname: string }>(
      testSettings.databaseUrl,
      'SELECT a.atttypmod, t.typname FROM pg_attribute a' +
        ' JOIN pg_type t ON t.oid = a.atttypid' +
        " WHERE a.attrelid = 'chunks'::regclass AND a.attname = 'embedding'",
    )
    const committed = parseNpy(await readFile(join(embeddingsDir(ROOT), 'chunks.npy')))

    expect(row).toEqual({ atttypmod: EMBEDDING_DIM, typname: 'vector' })
    expect(committed.shape[1]).toBe(EMBEDDING_DIM)
  })

  test.for([
    ['lang', 'de'],
    ['kind', 'article'],
  ] as const)(
    'the checks reject values outside the spec: %s',
    async ([column, value], { throwawayDatabaseUrl: url }) => {
      await upgradeHead(url)
      const client = new Client({ connectionString: url })
      await client.connect()
      try {
        await client.query(INSERT_CHUNK, chunkValues(VALID_CHUNK))
        await expect(
          client.query(
            INSERT_CHUNK,
            chunkValues({ ...VALID_CHUNK, element_id: 'rct_2', [column]: value }),
          ),
        ).rejects.toMatchObject({ code: '23514' })
      } finally {
        await client.end()
      }
    },
  )

  test('a duplicate key is rejected', async ({ throwawayDatabaseUrl: url }) => {
    await upgradeHead(url)
    const client = new Client({ connectionString: url })
    await client.connect()
    try {
      await client.query(INSERT_CHUNK, chunkValues(VALID_CHUNK))
      await client.query(INSERT_CHUNK, chunkValues({ ...VALID_CHUNK, lang: 'pl' }))
      await expect(client.query(INSERT_CHUNK, chunkValues(VALID_CHUNK))).rejects.toMatchObject({
        code: '23505',
      })
    } finally {
      await client.end()
    }
  })
})

const RUN_TABLES = ['runs', 'run_events']

async function runTables(url: string): Promise<Record<string, boolean>> {
  const found: Record<string, boolean> = {}
  for (const name of [...RUN_TABLES, 'conversations', 'chunks']) {
    found[name] = await tableExists(url, name)
  }
  return found
}

const INSERT_RUN =
  'INSERT INTO runs (kind, thread_id, conversation_id, question, status, profile, tokens_in,' +
  ' tokens_out, cost_usd, latency_ms) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)' +
  ' RETURNING id'

interface RunValues {
  kind: string
  thread_id: string
  conversation_id: string | null
  question: string | null
  status: string
  profile: string
  tokens_in: number
  tokens_out: number
  cost_usd: number
  latency_ms: number
}

function qaRun(conversation: string | null, status = 'running'): RunValues {
  return {
    kind: 'qa',
    thread_id: String(conversation),
    conversation_id: conversation,
    question: 'q',
    status,
    profile: 'p',
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    latency_ms: 0,
  }
}

function runValues(run: RunValues): unknown[] {
  return [
    run.kind,
    run.thread_id,
    run.conversation_id,
    run.question,
    run.status,
    run.profile,
    run.tokens_in,
    run.tokens_out,
    run.cost_usd,
    run.latency_ms,
  ]
}

async function migrated(url: string): Promise<Client> {
  await upgradeHead(url)
  const client = new Client({ connectionString: url })
  await client.connect()
  return client
}

const TZ = 'timestamp with time zone'
const ARRAY_DEFAULT = "'{}'::text[]"

// Written from src/db/migrations/0003_runs.sql and 0004_invoices.sql, in ordinal order.
const EXPECTED_COLUMNS = [
  ['invoices', 'id', 'uuid', 'NO', null, null, null],
  ['invoices', 'status', 'text', 'NO', null, null, null],
  ['invoices', 'run_id', 'uuid', 'NO', null, null, null],
  ['invoices', 'thread_id', 'text', 'NO', null, null, null],
  ['invoices', 'pdf_path', 'text', 'NO', null, null, null],
  ['invoices', 'extracted', 'jsonb', 'YES', null, null, null],
  ['invoices', 'failed_rules', 'jsonb', 'YES', null, null, null],
  ['invoices', 'final', 'jsonb', 'YES', null, null, null],
  ['invoices', 'decision', 'text', 'YES', null, null, null],
  ['invoices', 'override', 'boolean', 'YES', null, null, null],
  ['invoices', 'note', 'text', 'YES', null, null, null],
  ['invoices', 'decided_at', TZ, 'YES', null, null, null],
  ['invoices', 'created_at', TZ, 'NO', 'now()', null, null],
  ['run_events', 'run_id', 'uuid', 'NO', null, null, null],
  ['run_events', 'seq', 'integer', 'NO', null, 32, 0],
  ['run_events', 'type', 'text', 'NO', null, null, null],
  ['run_events', 'payload', 'jsonb', 'NO', null, null, null],
  ['run_events', 'created_at', TZ, 'NO', 'now()', null, null],
  ['runs', 'id', 'uuid', 'NO', 'gen_random_uuid()', null, null],
  ['runs', 'kind', 'text', 'NO', null, null, null],
  ['runs', 'thread_id', 'text', 'NO', null, null, null],
  ['runs', 'conversation_id', 'uuid', 'YES', null, null, null],
  ['runs', 'invoice_id', 'uuid', 'YES', null, null, null],
  ['runs', 'question', 'text', 'YES', null, null, null],
  ['runs', 'status', 'text', 'NO', null, null, null],
  ['runs', 'profile', 'text', 'NO', null, null, null],
  ['runs', 'models', 'ARRAY', 'NO', ARRAY_DEFAULT, null, null],
  ['runs', 'tokens_in', 'integer', 'NO', '0', 32, 0],
  ['runs', 'tokens_out', 'integer', 'NO', '0', 32, 0],
  ['runs', 'cost_usd', 'numeric', 'NO', '0', 12, 6],
  ['runs', 'latency_ms', 'integer', 'YES', null, 32, 0],
  ['runs', 'path', 'ARRAY', 'NO', ARRAY_DEFAULT, null, null],
  ['runs', 'error', 'text', 'YES', null, null, null],
  ['runs', 'created_at', TZ, 'NO', 'now()', null, null],
  ['runs', 'finished_at', TZ, 'YES', null, null, null],
]

const EXPECTED_INDEXES = [
  [
    'invoices',
    'invoices_created',
    'CREATE INDEX invoices_created ON public.invoices USING btree (created_at)',
  ],
  [
    'invoices',
    'invoices_pkey',
    'CREATE UNIQUE INDEX invoices_pkey ON public.invoices USING btree (id)',
  ],
  [
    'invoices',
    'invoices_run_id_key',
    'CREATE UNIQUE INDEX invoices_run_id_key ON public.invoices USING btree (run_id)',
  ],
  [
    'invoices',
    'invoices_thread_id_key',
    'CREATE UNIQUE INDEX invoices_thread_id_key ON public.invoices USING btree (thread_id)',
  ],
  [
    'run_events',
    'run_events_pkey',
    'CREATE UNIQUE INDEX run_events_pkey ON public.run_events USING btree (run_id, seq)',
  ],
  [
    'runs',
    'runs_conversation_created',
    'CREATE INDEX runs_conversation_created ON public.runs USING btree (conversation_id, created_at)',
  ],
  [
    'runs',
    'runs_id_invoice_id_key',
    'CREATE UNIQUE INDEX runs_id_invoice_id_key ON public.runs USING btree (id, invoice_id)',
  ],
  [
    'runs',
    'runs_invoice_id_key',
    'CREATE UNIQUE INDEX runs_invoice_id_key ON public.runs USING btree (invoice_id)',
  ],
  [
    'runs',
    'runs_one_running_per_conversation',
    "CREATE UNIQUE INDEX runs_one_running_per_conversation ON public.runs USING btree (conversation_id) WHERE (status = 'running'::text)",
  ],
  ['runs', 'runs_pkey', 'CREATE UNIQUE INDEX runs_pkey ON public.runs USING btree (id)'],
]

const EXPECTED_CONSTRAINTS = [
  [
    'invoices',
    'invoices_decision_check',
    'c',
    "CHECK ((decision = ANY (ARRAY['approve'::text, 'edit'::text, 'reject'::text])))",
    false,
    false,
  ],
  ['invoices', 'invoices_pkey', 'p', 'PRIMARY KEY (id)', false, false],
  [
    'invoices',
    'invoices_run_id_fkey',
    'f',
    'FOREIGN KEY (run_id, id) REFERENCES runs(id, invoice_id) DEFERRABLE INITIALLY DEFERRED',
    true,
    true,
  ],
  ['invoices', 'invoices_run_id_key', 'u', 'UNIQUE (run_id)', false, false],
  [
    'invoices',
    'invoices_status_check',
    'c',
    "CHECK ((status = ANY (ARRAY['running'::text, 'pending_review'::text, 'approved'::text, 'rejected'::text, 'done'::text, 'failed'::text])))",
    false,
    false,
  ],
  ['invoices', 'invoices_thread_id_key', 'u', 'UNIQUE (thread_id)', false, false],
  ['run_events', 'run_events_pkey', 'p', 'PRIMARY KEY (run_id, seq)', false, false],
  [
    'run_events',
    'run_events_run_id_fkey',
    'f',
    'FOREIGN KEY (run_id) REFERENCES runs(id)',
    false,
    false,
  ],
  ['run_events', 'run_events_seq_check', 'c', 'CHECK ((seq >= 1))', false, false],
  [
    'run_events',
    'run_events_type_check',
    'c',
    "CHECK ((type = ANY (ARRAY['step_started'::text, 'step_finished'::text, 'interrupt'::text, 'final'::text, 'error'::text])))",
    false,
    false,
  ],
  [
    'runs',
    'runs_check',
    'c',
    "CHECK (((kind <> 'qa'::text) OR ((conversation_id IS NOT NULL) AND (question IS NOT NULL))))",
    false,
    false,
  ],
  ['runs', 'runs_cost_usd_check', 'c', 'CHECK ((cost_usd >= (0)::numeric))', false, false],
  [
    'runs',
    'runs_extraction_invoice',
    'c',
    "CHECK (((kind <> 'extraction'::text) OR (invoice_id IS NOT NULL)))",
    false,
    false,
  ],
  ['runs', 'runs_id_invoice_id_key', 'u', 'UNIQUE (id, invoice_id)', false, false],
  [
    'runs',
    'runs_invoice_id_fkey',
    'f',
    'FOREIGN KEY (invoice_id) REFERENCES invoices(id)',
    false,
    false,
  ],
  ['runs', 'runs_invoice_id_key', 'u', 'UNIQUE (invoice_id)', false, false],
  [
    'runs',
    'runs_kind_check',
    'c',
    "CHECK ((kind = ANY (ARRAY['qa'::text, 'extraction'::text])))",
    false,
    false,
  ],
  ['runs', 'runs_latency_ms_check', 'c', 'CHECK ((latency_ms >= 0))', false, false],
  ['runs', 'runs_pkey', 'p', 'PRIMARY KEY (id)', false, false],
  [
    'runs',
    'runs_status_check',
    'c',
    "CHECK ((status = ANY (ARRAY['running'::text, 'pending_review'::text, 'done'::text, 'failed'::text])))",
    false,
    false,
  ],
  ['runs', 'runs_tokens_in_check', 'c', 'CHECK ((tokens_in >= 0))', false, false],
  ['runs', 'runs_tokens_out_check', 'c', 'CHECK ((tokens_out >= 0))', false, false],
]

const SCHEMA_TABLES = "('invoices', 'runs', 'run_events')"

const INSERT_INVOICE =
  'INSERT INTO invoices (id, status, run_id, thread_id, pdf_path, decision)' +
  " VALUES ($1, $2, $3, $4, 'x.pdf', $5)"
const INSERT_EXTRACTION_RUN =
  'INSERT INTO runs (id, kind, thread_id, invoice_id, status, profile)' +
  " VALUES ($1, 'extraction', $2, $3, $4, 'p')"

interface InvoiceValues {
  id: string
  status: string
  run_id: string
  thread_id: string
  decision: string | null
}

function invoiceValues(
  invoiceId: string,
  runId: string,
  change: Partial<InvoiceValues> = {},
): unknown[] {
  const invoice: InvoiceValues = {
    id: invoiceId,
    status: 'running',
    run_id: runId,
    thread_id: `invoice:${invoiceId}`,
    decision: null,
    ...change,
  }
  return [invoice.id, invoice.status, invoice.run_id, invoice.thread_id, invoice.decision]
}

async function inTransaction(client: Client, work: () => Promise<void>): Promise<void> {
  await client.query('BEGIN')
  try {
    await work()
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

async function extractionRun(client: Client, status = 'running'): Promise<[string, string]> {
  const [invoiceId, runId] = [randomUUID(), randomUUID()]
  await inTransaction(client, async () => {
    await client.query(INSERT_INVOICE, invoiceValues(invoiceId, runId))
    await client.query(INSERT_EXTRACTION_RUN, [runId, `invoice:${invoiceId}`, invoiceId, status])
  })
  return [invoiceId, runId]
}

describe('migration 0003', () => {
  test('the schema at head is what the migrations declare', async ({ testSettings }) => {
    const url = testSettings.databaseUrl
    const columns = await query(
      url,
      'SELECT table_name, column_name, data_type, is_nullable, column_default,' +
        ' numeric_precision, numeric_scale FROM information_schema.columns' +
        ` WHERE table_schema = 'public' AND table_name IN ${SCHEMA_TABLES}` +
        ' ORDER BY table_name, ordinal_position',
    )
    const indexes = await query(
      url,
      'SELECT tablename, indexname, indexdef FROM pg_indexes' +
        ` WHERE schemaname = 'public' AND tablename IN ${SCHEMA_TABLES}` +
        ' ORDER BY tablename, indexname',
    )
    const constraints = await query(
      url,
      'SELECT conrelid::regclass::text AS table_name, conname, contype::text,' +
        ' pg_get_constraintdef(oid) AS definition, condeferrable, condeferred' +
        ` FROM pg_constraint WHERE conrelid::regclass::text IN ${SCHEMA_TABLES}` +
        ' ORDER BY table_name, conname',
    )

    expect(columns.map(Object.values)).toEqual(EXPECTED_COLUMNS)
    expect(indexes.map(Object.values)).toEqual(EXPECTED_INDEXES)
    expect(constraints.map(Object.values)).toEqual(EXPECTED_CONSTRAINTS)
  })

  test('creates and downgrade drops its tables, without conversations', async ({
    throwawayDatabaseUrl: url,
  }) => {
    await upgradeHead(url)
    expect(await runTables(url)).toEqual({
      runs: true,
      run_events: true,
      conversations: false,
      chunks: true,
    })
    const [index] = await query<{ indexdef: string }>(
      url,
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'runs_one_running_per_conversation'",
    )
    expect(index!.indexdef).toContain('UNIQUE')
    expect(index!.indexdef).toContain('(conversation_id)')
    expect(index!.indexdef).toContain("WHERE (status = 'running'::text)")
    const foreignKeys = await query<{ conname: string }>(
      url,
      "SELECT conname FROM pg_constraint WHERE conrelid = 'runs'::regclass AND contype = 'f'",
    )
    expect(foreignKeys).toEqual([{ conname: 'runs_invoice_id_fkey' }])

    await downgradeTo(url, '0002_chunks')

    expect(await runTables(url)).toEqual({
      runs: false,
      run_events: false,
      conversations: false,
      chunks: true,
    })
    expect(await revision(url)).toBe('0002_chunks')
  })

  test('one running run per conversation', async ({ throwawayDatabaseUrl: url }) => {
    const client = await migrated(url)
    try {
      const conversation = randomUUID()
      await client.query(INSERT_RUN, runValues(qaRun(conversation, 'done')))
      await client.query(INSERT_RUN, runValues(qaRun(conversation, 'failed')))
      await client.query(INSERT_RUN, runValues(qaRun(conversation)))
      await client.query(INSERT_RUN, runValues(qaRun(randomUUID())))
      for (let n = 0; n < 2; n++) await extractionRun(client)
      await expect(client.query(INSERT_RUN, runValues(qaRun(conversation)))).rejects.toMatchObject({
        code: '23505',
        constraint: 'runs_one_running_per_conversation',
      })
    } finally {
      await client.end()
    }
  })

  test.for([
    { status: 'approved' },
    { kind: 'chat' },
    { kind: 'extraction' },
    { conversation_id: null },
    { question: null },
    { tokens_in: -1 },
    { tokens_out: -1 },
    { cost_usd: -0.000001 },
    { latency_ms: -1 },
  ] as Partial<RunValues>[])(
    'the runs checks reject values outside the spec: %j',
    async (change, { throwawayDatabaseUrl: url }) => {
      const client = await migrated(url)
      try {
        const run = qaRun(randomUUID())
        await client.query(INSERT_RUN, runValues({ ...run, status: 'done' }))
        await expect(
          client.query(INSERT_RUN, runValues({ ...run, ...change })),
        ).rejects.toMatchObject({ code: '23514' })
      } finally {
        await client.end()
      }
    },
  )

  test('run_events check type and key', async ({ throwawayDatabaseUrl: url }) => {
    const insert = "INSERT INTO run_events (run_id, seq, type, payload) VALUES ($1, $2, $3, '{}')"
    const client = await migrated(url)
    try {
      const {
        rows: [row],
      } = await client.query<{ id: string }>(INSERT_RUN, runValues(qaRun(randomUUID())))
      const run = row!.id
      await client.query(insert, [run, 1, 'step_started'])
      await expect(client.query(insert, [run, 1, 'step_finished'])).rejects.toMatchObject({
        code: '23505',
      })
      await client.query(insert, [run, 2, 'interrupt'])
      await expect(client.query(insert, [run, 3, 'decision'])).rejects.toMatchObject({
        code: '23514',
      })
      await expect(client.query(insert, [run, 0, 'final'])).rejects.toMatchObject({
        code: '23514',
      })
      await expect(client.query(insert, [randomUUID(), 1, 'final'])).rejects.toMatchObject({
        code: '23503',
      })
    } finally {
      await client.end()
    }
  })
})

describe('migration 0004', () => {
  test('upgrade and downgrade', async ({ throwawayDatabaseUrl: url }) => {
    await upgradeHead(url)
    expect(await revision(url)).toBe('0004_invoices')
    expect(await tableExists(url, 'invoices')).toBe(true)

    await downgradeTo(url, '0003_runs')

    expect(await revision(url)).toBe('0003_runs')
    expect(await tableExists(url, 'invoices')).toBe(false)
    let client = new Client({ connectionString: url })
    await client.connect()
    try {
      await expect(
        client.query(INSERT_RUN, runValues(qaRun(randomUUID(), 'pending_review'))),
      ).rejects.toMatchObject({ code: '23514' })
      const {
        rows: [row],
      } = await client.query<{ id: string }>(INSERT_RUN, runValues(qaRun(randomUUID())))
      await expect(
        client.query(
          "INSERT INTO run_events (run_id, seq, type, payload) VALUES ($1, 1, 'interrupt', '{}')",
          [row!.id],
        ),
      ).rejects.toMatchObject({ code: '23514' })
      const extraction = { ...qaRun(null), kind: 'extraction', thread_id: 't', question: null }
      await client.query(INSERT_RUN, runValues(extraction))
      await client.query('DELETE FROM runs')
    } finally {
      await client.end()
    }

    await upgradeHead(url)

    expect(await revision(url)).toBe('0004_invoices')
    client = new Client({ connectionString: url })
    await client.connect()
    try {
      const [, runId] = await extractionRun(client, 'pending_review')
      await client.query(
        "INSERT INTO run_events (run_id, seq, type, payload) VALUES ($1, 1, 'interrupt', '{}')",
        [runId],
      )
      const { rows } = await client.query("SELECT status FROM runs WHERE kind = 'extraction'")
      expect(rows).toEqual([{ status: 'pending_review' }])
    } finally {
      await client.end()
    }
  })

  test('the invoice and its run point at each other, checked at commit', async ({
    throwawayDatabaseUrl: url,
  }) => {
    const client = await migrated(url)
    try {
      const [invoiceId, runId] = await extractionRun(client)

      const [lonely, missingRun] = [randomUUID(), randomUUID()]
      await expect(
        inTransaction(client, async () => {
          await client.query(INSERT_INVOICE, invoiceValues(lonely, missingRun))
        }),
      ).rejects.toMatchObject({ code: '23503', constraint: 'invoices_run_id_fkey' })

      await expect(
        client.query(INSERT_EXTRACTION_RUN, [randomUUID(), 't', randomUUID(), 'running']),
      ).rejects.toMatchObject({ code: '23503', constraint: 'runs_invoice_id_fkey' })

      const [first, second] = [randomUUID(), randomUUID()]
      const [firstRun, secondRun] = [randomUUID(), randomUUID()]
      await expect(
        inTransaction(client, async () => {
          await client.query(INSERT_INVOICE, invoiceValues(first, firstRun))
          await client.query(INSERT_INVOICE, invoiceValues(second, secondRun))
          await client.query(INSERT_EXTRACTION_RUN, [firstRun, 't1', second, 'running'])
          await client.query(INSERT_EXTRACTION_RUN, [secondRun, 't2', first, 'running'])
        }),
      ).rejects.toMatchObject({ code: '23503', constraint: 'invoices_run_id_fkey' })

      await expect(
        client.query(INSERT_EXTRACTION_RUN, [randomUUID(), 't', invoiceId, 'running']),
      ).rejects.toMatchObject({ code: '23505', constraint: 'runs_invoice_id_key' })

      const { rows: invoices } = await client.query('SELECT id, run_id FROM invoices')
      expect(invoices).toEqual([{ id: invoiceId, run_id: runId }])
      const { rows: runs } = await client.query('SELECT id FROM runs')
      expect(runs).toEqual([{ id: runId }])
    } finally {
      await client.end()
    }
  })

  test.for([{ status: 'pending' }, { decision: 'override' }] as Partial<InvoiceValues>[])(
    'the invoices checks reject values outside the spec: %j',
    async (change, { throwawayDatabaseUrl: url }) => {
      const client = await migrated(url)
      try {
        const [invoiceId, runId] = [randomUUID(), randomUUID()]
        await expect(
          inTransaction(client, async () => {
            await client.query(INSERT_INVOICE, invoiceValues(invoiceId, runId, change))
            await client.query(INSERT_EXTRACTION_RUN, [
              runId,
              `invoice:${invoiceId}`,
              invoiceId,
              'running',
            ])
          }),
        ).rejects.toMatchObject({ code: '23514' })
      } finally {
        await client.end()
      }
    },
  )
})
