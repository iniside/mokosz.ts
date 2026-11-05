import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Client, Pool } from 'pg'
import { pathToFileURL } from 'node:url'
import { vi, type MockInstance } from 'vitest'
import { main, type Commands } from '../../src/cli.ts'
import { itemsPath, type EvalItem } from '../../src/evals/qa.ts'
import {
  CSV_HEADER,
  EvalFailed,
  WARM_UP,
  citedKeys,
  csv,
  evalCommand,
  fileStamp,
  gitSha,
  markdown,
  nearestRank,
  resultPaths,
  runQaEval,
  score,
  summarise,
  type EvalCommandOptions,
  type EvalOptions,
  type Row,
  type Summary,
} from '../../src/evals/run.ts'
import { loadProfile } from '../../src/llm/profiles.ts'
import type { Answer } from '../../src/mastra/workflows/state.ts'
import { Executor } from '../../src/runs/executor.ts'
import { createConversation, startRun } from '../../src/runs/conversations.ts'
import { clearSettingsCache, getSettings } from '../../src/settings.ts'
import { endWithin } from '../support/databases.ts'
import { describe, expect, test as base } from '../support/harness.ts'
import { ai14Vector } from '../api/gated-embedder.ts'
import { scriptedLlmFixture, type ScriptedLLM } from '../llm/scripted.ts'
import { openMastra } from '../runs/helpers.ts'

const hooks = vi.hoisted(() => ({
  embed: null as ((text: string) => Promise<number[]>) | null,
}))

vi.mock('ollama-ai-provider-v2', async (importOriginal) => {
  const real = await importOriginal<typeof import('ollama-ai-provider-v2')>()
  const { scripted } = await import('../llm/scripted.ts')
  return { ...real, createOllama: scripted(real.createOllama, 'ollama.responses') }
})
vi.mock('../../src/retrieval/embeddings.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/retrieval/embeddings.ts')>()
  return {
    ...real,
    embedQuery: (text: string) => {
      if (hooks.embed === null) throw new Error('the test has no embedder')
      return hooks.embed(text)
    },
  }
})

const A = '32024R1689#014.001'
const B = '32024R1689#014.002'
const C = '32024R1689#014.003'
const AT = new Date('2026-11-04T20:35:42.123Z')
const SHA = '0123456789abcdef0123456789abcdef01234567-dirty'
const FAIL = 'the embedder fails on this query'
const WARM = 'the warm-up query'
const WARM_DELAY_MS = 400
const RUN_MODULE = join(import.meta.dirname, '..', '..', 'src', 'evals', 'run.ts')
const CLOSED_DB = 'postgresql://mokosz:mokosz@127.0.0.1:1/mokosz'

const test = base
  .extend('scriptedLlm', ({}, fixture): ScriptedLLM => scriptedLlmFixture({}, fixture))
  .extend('root', async ({}, { onCleanup }): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), 'mokosz-eval-'))
    onCleanup(() => rm(root, { recursive: true, force: true }))
    return root
  })
  .extend('embedder', async ({ seededDatabaseUrl }, { onCleanup }): Promise<string[]> => {
    const vector = await ai14Vector(seededDatabaseUrl)
    const queries: string[] = []
    hooks.embed = async (text) => {
      queries.push(text)
      if (text === FAIL) throw new Error('embedder down')
      if (text === WARM) await sleep(WARM_DELAY_MS)
      return vector
    }
    onCleanup(() => {
      hooks.embed = null
    })
    return queries
  })
  .extend('quietErrors', ({}, { onCleanup }): void => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    onCleanup(() => spy.mockRestore())
  })
  .extend('closing', ({}, { onCleanup }): Closing => {
    const ends = vi.spyOn(Pool.prototype, 'end')
    const shutdowns = vi.spyOn(Executor.prototype, 'shutdown')
    onCleanup(() => {
      ends.mockRestore()
      shutdowns.mockRestore()
    })
    return { ends, shutdowns }
  })
  .extend('heldRun', async ({ testSettings }, { onCleanup }) => {
    const mastra = await openMastra(testSettings.databaseUrl)
    const pool = new Pool({ connectionString: testSettings.databaseUrl })
    let runId: string | null = null
    onCleanup(async () => {
      try {
        if (runId !== null) {
          await pool.query(
            "UPDATE runs SET status = 'failed', error = 'test', finished_at = now() WHERE id = $1",
            [runId],
          )
        }
      } finally {
        await endWithin(pool)
        await mastra.close()
      }
    })
    runId = await startRun(pool, mastra.memory, {
      conversationId: await createConversation(mastra.memory),
      question: `held ${randomUUID()}`,
      profile: 'local-qwen',
    })
    return { pool, runId }
  })

interface Closing {
  ends: MockInstance<Pool['end']>
  shutdowns: MockInstance<Executor['shutdown']>
}

function expectClosed({ ends, shutdowns }: Closing): void {
  const pools = new Set(ends.mock.contexts)
  expect(pools.size).toBe(2)
  expect([...pools].every((pool) => pool instanceof Pool && pool.ended)).toBe(true)
  expect(shutdowns).toHaveBeenCalledOnce()
  expect(shutdowns.mock.invocationCallOrder[0]!).toBeLessThan(
    Math.min(...ends.mock.invocationCallOrder),
  )
}

function item(id: string, fields: Partial<EvalItem> = {}): EvalItem {
  const expected = fields.expected ?? (fields.not_found === true ? [] : [A])
  return {
    id,
    lang: 'en',
    question: `${id} ${randomUUID()}`,
    expected,
    evidence: expected.map((key) => ({ key, quote: 'a quote copied from the chunk text' })),
    reference: 'A reference answer.',
    not_found: false,
    ...fields,
  }
}

function answer(...keys: string[]): Answer {
  return { lang: 'en', not_found: false, claims: [{ text: 'A claim.', citations: keys }] }
}

const NOT_FOUND: Answer = { lang: 'en', not_found: true, claims: [] }

function row(entry: EvalItem, given: Answer | null, latencyMs: number | null = 100): Row {
  return {
    item: entry,
    repeat: 1,
    status: given === null ? 'failed' : 'done',
    score: score(entry, given),
    latencyMs,
    tokensIn: 10,
    tokensOut: 5,
  }
}

const ANSWERABLE_AB = item('ab', { expected: [A, B] })
const ANSWERABLE_A = item('a')
const UNANSWERABLE = item('nf', { not_found: true })

describe('scoring one row', () => {
  test.for([
    ['expected {A,B}, cited {A}', ANSWERABLE_AB, answer(A), 1, 0.5, true],
    ['expected {A}, cited {A,C}', ANSWERABLE_A, answer(A, C), 0.5, 1, true],
    ['expected {A}, answer not_found', ANSWERABLE_A, NOT_FOUND, 0, 0, false],
    ['expected {A}, answered with no citations', ANSWERABLE_A, answer(), 0, 0, true],
    ['not_found item, answered with {C}', UNANSWERABLE, answer(C), null, null, false],
    ['not_found item, answered not_found', UNANSWERABLE, NOT_FOUND, null, null, true],
    ['failed turn on an answerable item', ANSWERABLE_A, null, 0, 0, false],
  ] as const)('%s', ([, entry, given, precision, recall, notFoundCorrect]) => {
    const scored = score(entry, given)

    expect([scored.precision, scored.recall, scored.notFoundCorrect]).toEqual([
      precision,
      recall,
      notFoundCorrect,
    ])
  })

  test.for([
    ['expected {A}, answer not_found', ANSWERABLE_A, NOT_FOUND, { false: [1, 1], correct: [0, 0] }],
    [
      'not_found item, answered with {C}',
      UNANSWERABLE,
      answer(C),
      { false: [0, 0], correct: [0, 1] },
    ],
    [
      'not_found item, answered not_found',
      UNANSWERABLE,
      NOT_FOUND,
      { false: [0, 0], correct: [1, 1] },
    ],
    ['expected {A}, cited {A}', ANSWERABLE_A, answer(A), { false: [0, 1], correct: [0, 0] }],
    ['failed turn on an answerable item', ANSWERABLE_A, null, { false: [0, 1], correct: [0, 0] }],
    ['failed turn on a not_found item', UNANSWERABLE, null, { false: [0, 0], correct: [0, 1] }],
  ] as const)('the not_found split of %s', ([, entry, given, split]) => {
    const summary = summarise([row(entry, given)])
    const notFoundRight = score(entry, given).notFoundCorrect ? 1 : 0

    expect({
      false: [summary.falseAbstentions.count, summary.falseAbstentions.of],
      correct: [summary.correctAbstentions.count, summary.correctAbstentions.of],
      accuracy: [summary.notFoundAccuracy.count, summary.notFoundAccuracy.of],
    }).toEqual({ ...split, accuracy: [notFoundRight, 1] })
  })

  test('a failed turn is neither an abstention nor an answer', () => {
    expect(score(ANSWERABLE_A, null)).toEqual({
      notFoundGot: null,
      notFoundCorrect: false,
      cited: [],
      hits: 0,
      citedCount: 0,
      expectedCount: 1,
      precision: 0,
      recall: 0,
    })
    expect(summarise([row(ANSWERABLE_A, null)]).failed).toBe(1)
    expect(summarise([row(UNANSWERABLE, null)]).failed).toBe(1)
    expect(summarise([row(UNANSWERABLE, NOT_FOUND), row(ANSWERABLE_A, answer(A))]).failed).toBe(0)
  })

  test('a key cited in another language than the item is cited but not a hit', () => {
    const given: Answer = { ...answer(A), lang: 'pl' }

    expect(score(ANSWERABLE_A, given)).toMatchObject({
      cited: [A],
      hits: 0,
      citedCount: 1,
      precision: 0,
      recall: 0,
    })
    expect(score({ ...ANSWERABLE_A, lang: 'pl' }, given)).toMatchObject({
      hits: 1,
      precision: 1,
      recall: 1,
    })
  })

  test('cited keys come from the claims, unknown keys and repeats included', () => {
    const given: Answer = {
      lang: 'en',
      not_found: false,
      claims: [
        { text: 'One.', citations: [C, 'no-such#key'] },
        { text: 'Two.', citations: [A, C] },
      ],
    }

    expect(citedKeys(given)).toEqual([A, C, 'no-such#key'].toSorted())
    expect(score(ANSWERABLE_A, given)).toMatchObject({ hits: 1, citedCount: 3, precision: 1 / 3 })
  })

  test('a not_found answer scores 0 even with cited claims', () => {
    const given: Answer = { ...answer(A), not_found: true }

    expect(score(ANSWERABLE_A, given)).toMatchObject({
      cited: [A],
      hits: 0,
      citedCount: 0,
      precision: 0,
      recall: 0,
    })
  })

  test('an expected key listed twice counts once', () => {
    expect(score(item('twice', { expected: [A, A] }), answer(A))).toMatchObject({
      recall: 1,
      expectedCount: 1,
    })
  })
})

describe('pooling rows', () => {
  test('rows ({A,B}/{A}) and ({A}/{A,C}) give macro 0.75/0.75 and micro 2/3 / 2/3', () => {
    const summary = summarise([row(ANSWERABLE_AB, answer(A)), row(ANSWERABLE_A, answer(A, C))])

    expect([summary.macroPrecision, summary.macroRecall]).toEqual([0.75, 0.75])
    expect([summary.microPrecision, summary.microRecall]).toEqual([2 / 3, 2 / 3])
  })

  test('micro and macro differ when items differ in size', () => {
    const big = item('big', { expected: [A, B, C] })
    const summary = summarise([row(big, answer(A, B, C)), row(ANSWERABLE_A, answer(B))])

    expect([summary.macroPrecision, summary.macroRecall]).toEqual([0.5, 0.5])
    expect([summary.microPrecision, summary.microRecall]).toEqual([3 / 4, 3 / 4])
  })

  test('not_found items are left out of precision and recall', () => {
    const summary = summarise([row(ANSWERABLE_A, answer(A)), row(UNANSWERABLE, answer(C))])

    expect(summary.answerable).toBe(1)
    expect([summary.macroPrecision, summary.microPrecision]).toEqual([1, 1])
  })

  test('false abstentions and failed turns pull precision and recall down', () => {
    const summary = summarise([
      row(ANSWERABLE_A, answer(A)),
      row(ANSWERABLE_A, NOT_FOUND),
      row(ANSWERABLE_A, null),
    ])

    expect([summary.macroPrecision, summary.macroRecall]).toEqual([1 / 3, 1 / 3])
    expect([summary.microPrecision, summary.microRecall]).toEqual([1, 1 / 3])
  })

  test('micro precision is 0 when nothing is cited', () => {
    const summary = summarise([row(ANSWERABLE_A, NOT_FOUND)])

    expect([summary.microPrecision, summary.microRecall]).toEqual([0, 0])
  })

  test('with no answerable rows there is no precision or recall', () => {
    const summary = summarise([row(UNANSWERABLE, NOT_FOUND)])

    expect([
      summary.macroPrecision,
      summary.macroRecall,
      summary.microPrecision,
      summary.microRecall,
    ]).toEqual([null, null, null, null])
  })

  test('the not_found split pools all rows', () => {
    const summary = summarise([
      row(ANSWERABLE_A, answer(A)),
      row(ANSWERABLE_A, NOT_FOUND),
      row(ANSWERABLE_A, null),
      row(UNANSWERABLE, NOT_FOUND),
      row(UNANSWERABLE, answer(C)),
    ])

    expect(summary.falseAbstentions).toEqual({ count: 1, of: 3 })
    expect(summary.correctAbstentions).toEqual({ count: 1, of: 2 })
    expect(summary.notFoundAccuracy).toEqual({ count: 2, of: 5 })
    expect(summary.failed).toBe(1)
  })
})

describe('latency percentiles', () => {
  test.for([
    [[], 50, null],
    [[7], 50, 7],
    [[7], 95, 7],
    [[30, 10, 20], 50, 20],
    [[40, 10, 30, 20], 50, 20],
    [[40, 10, 30, 20], 95, 40],
    [Array.from({ length: 20 }, (_, i) => i + 1), 95, 19],
    [Array.from({ length: 20 }, (_, i) => i + 1), 50, 10],
    [Array.from({ length: 21 }, (_, i) => i + 1), 95, 20],
    [Array.from({ length: 11 }, (_, i) => i + 1), 95, 11],
    [Array.from({ length: 60 }, (_, i) => i + 1), 95, 57],
    [Array.from({ length: 100 }, (_, i) => 100 - i), 95, 95],
  ] as const)('nearest rank of %j at p%i is %j', ([values, p, expected]) => {
    expect(nearestRank(values, p)).toBe(expected)
  })

  test('rows without a latency are not counted', () => {
    const summary = summarise([
      row(ANSWERABLE_A, answer(A), 300),
      row(ANSWERABLE_A, null, null),
      row(UNANSWERABLE, NOT_FOUND, 100),
    ])

    expect([summary.p50, summary.p95, summary.latencyN]).toEqual([100, 300, 2])
  })
})

describe('the warm-up', () => {
  test('is the plan sentence', () => {
    expect(WARM_UP).toBe(
      'How long does a controller have to notify a personal data breach to the supervisory authority?',
    )
  })
})

describe('result files', () => {
  test('names carry the UTC date, hour and minute and the profile', () => {
    expect(fileStamp(new Date('2026-01-02T03:04:59.999Z'))).toBe('2026-01-02-0304')
    expect(fileStamp(new Date('2026-11-04T23:59:00+02:00'))).toBe('2026-11-04-2159')
    expect(resultPaths('/r', AT, 'local-qwen')).toEqual({
      csv: join('/r', 'evals', 'results', '2026-11-04-2035-local-qwen-qa.csv'),
      md: join('/r', 'evals', 'results', '2026-11-04-2035-local-qwen.md'),
    })
  })

  test('the stamp is UTC also when the local time zone is not', () => {
    const script = [
      `const { fileStamp } = await import(${JSON.stringify(pathToFileURL(RUN_MODULE).href)})`,
      "const at = new Date('2026-01-02T03:04:59.999Z')",
      'console.log(JSON.stringify([at.getHours(), fileStamp(at)]))',
    ].join('\n')
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, TZ: 'America/New_York' },
      encoding: 'utf8',
    })

    expect(JSON.parse(output)).toEqual([22, '2026-01-02-0304'])
  })

  test('the CSV has one row per item and repeat', () => {
    const rows = [
      row(ANSWERABLE_AB, answer(B, A)),
      { ...row(UNANSWERABLE, null, null), repeat: 2 },
      row(item('pl', { lang: 'pl', id: 'q,"1"' }), NOT_FOUND, 42),
    ]

    expect(csv(rows)).toBe(
      [
        CSV_HEADER.join(','),
        `ab,en,1,done,false,false,${A} ${B},${A} ${B},1,1,100,10,5`,
        'nf,en,2,failed,true,,,,,,,10,5',
        `"q,""1""",pl,1,done,false,true,,${A},0,0,42,10,5`,
        '',
      ].join('\n'),
    )
    expect(CSV_HEADER).toEqual([
      'id',
      'lang',
      'repeat',
      'status',
      'not_found_expected',
      'not_found_got',
      'cited',
      'expected',
      'precision',
      'recall',
      'latency_ms',
      'tokens_in',
      'tokens_out',
    ])
  })

  test('the summary names the profile, models, sha, date, counts and every metric with n', async () => {
    const summary: Summary = summarise([
      row(ANSWERABLE_AB, answer(A), 100),
      row(ANSWERABLE_A, answer(A, C), 200),
      row(UNANSWERABLE, NOT_FOUND, 300),
    ])
    const text = markdown({
      profile: await loadProfile('local-qwen'),
      sha: SHA,
      at: AT,
      items: 3,
      repeats: 1,
      coldStartMs: 9000,
      summary,
    })

    expect(text).toBe(
      [
        '# Q&A eval: local-qwen',
        '',
        '| Field | Value |',
        '| --- | --- |',
        '| Profile | local-qwen |',
        '| Router model | ollama_chat/qwen3.6:27b |',
        '| Answerer model | ollama_chat/qwen3.6:27b |',
        `| Git sha | ${SHA} |`,
        '| Date | 2026-11-04T20:35:42.123Z |',
        '| Items | 3 |',
        '| Repeats | 1 |',
        '| Cold start | 9000 ms |',
        '',
        '| Metric | Value | n |',
        '| --- | --- | --- |',
        '| Citation precision (macro) | 0.7500 | 2 |',
        '| Citation recall (macro) | 0.7500 | 2 |',
        '| Citation precision (micro) | 0.6667 | 2 |',
        '| Citation recall (micro) | 0.6667 | 2 |',
        '| Correct abstentions | 1/1 (1.0000) | 1 |',
        '| False abstentions | 0/2 (0.0000) | 2 |',
        '| not_found accuracy | 3/3 (1.0000) | 3 |',
        '| Failed turns | 0 | 3 |',
        '| Latency p50 | 200 ms | 3 |',
        '| Latency p95 | 300 ms | 3 |',
        '| Cold start | 9000 ms | 1 |',
        '',
      ].join('\n'),
    )
  })

  test('the summary names the router and the answerer model each in its own row', async () => {
    const text = markdown({
      profile: await loadProfile('cloud-claude'),
      sha: SHA,
      at: AT,
      items: 1,
      repeats: 1,
      coldStartMs: null,
      summary: summarise([]),
    })

    expect(text).toContain(
      '| Router model | anthropic/claude-haiku-5-5 |\n| Answerer model | anthropic/claude-sonnet-5-5 |',
    )
  })

  test('the git sha is HEAD, with -dirty when the tree has changes', async ({ root }) => {
    await writeFile(join(root, 'a.txt'), 'a', 'utf8')
    const head = commitAll(root)

    expect(head).toMatch(/^[0-9a-f]{40}$/)
    expect(await gitSha(root)).toBe(head)
    await writeFile(join(root, 'a.txt'), 'b', 'utf8')
    expect(await gitSha(root)).toBe(`${head}-dirty`)
  })

  test('an untracked file makes the sha -dirty', async ({ root }) => {
    await writeFile(join(root, 'a.txt'), 'a', 'utf8')
    const head = commitAll(root)
    await writeFile(join(root, 'new.txt'), 'n', 'utf8')

    expect(await gitSha(root)).toBe(`${head}-dirty`)
  })
})

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd: root,
    encoding: 'utf8',
  }).trim()
}

/** A new repository at root with everything in it committed; returns HEAD. */
function commitAll(root: string): string {
  git(root, 'init', '-q')
  git(root, 'add', '-A')
  git(root, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', 'commit', '-q', '-m', 'init')
  return git(root, 'rev-parse', 'HEAD')
}

interface Turn {
  query: string
  answer?: object
}

function route(script: ScriptedLLM, turns: Turn[]): void {
  for (const turn of turns) {
    script.queue('router', {
      lang: 'en',
      acts: ['AI Act'],
      article_refs: [{ act: 'AI Act', article: 14 }],
      query: turn.query,
    })
    if (turn.answer !== undefined) script.queue('answerer', turn.answer)
  }
}

const claim = (...keys: string[]): object => ({
  claims: [{ text: 'A claim.', citations: keys }],
  not_found: false,
})
const ABSTAIN = { claims: [], not_found: true }

async function writeItems(root: string, items: EvalItem[]): Promise<void> {
  await mkdir(join(root, 'evals', 'qa'), { recursive: true })
  await writeFile(itemsPath(root), JSON.stringify(items), 'utf8')
}

interface StoredRun {
  question: string
  status: string
  latency_ms: number
  tokens_in: number
  tokens_out: number
}

async function storedRuns(url: string, questions: string[]): Promise<StoredRun[]> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    const { rows } = await client.query<StoredRun>(
      'SELECT question, status, latency_ms, tokens_in, tokens_out FROM runs' +
        ' WHERE question = ANY($1::text[]) ORDER BY created_at, id',
      [questions],
    )
    return rows
  } finally {
    await client.end()
  }
}

function options(root: string, settings: EvalOptions['settings'], repeat = 1): EvalOptions {
  return { root, settings, profile: 'local-qwen', repeat, now: () => AT, sha: async () => SHA }
}

describe('mokosz eval against the real executor', () => {
  test('every item is one scored turn after an unscored warm-up', async ({
    root,
    scriptedLlm,
    embedder,
    testSettings,
    unreachableOllama: _,
    quietErrors: __,
  }) => {
    const items = [
      item('ab', { expected: [A, B] }),
      item('a-c', { lang: 'pl' }),
      item('abstains'),
      item('nf-cited', { not_found: true }),
      item('nf-abstains', { not_found: true }),
      item('fails'),
    ]
    await writeItems(root, items)
    route(scriptedLlm, [
      { query: WARM, answer: claim(A) },
      { query: 'q1', answer: claim(A) },
      { query: 'q2', answer: claim(A, C) },
      { query: 'q3', answer: ABSTAIN },
      { query: 'q4', answer: claim(C) },
      { query: 'q5', answer: ABSTAIN },
      { query: FAIL },
    ])

    const result = await runQaEval(options(root, testSettings))

    expect(embedder).toEqual([WARM, 'q1', 'q2', 'q3', 'q4', 'q5', FAIL])
    const runs = await storedRuns(testSettings.databaseUrl, [
      WARM_UP,
      ...items.map((entry) => entry.question),
    ])
    expect(runs.map((run) => [run.question, run.status])).toEqual([
      [WARM_UP, 'done'],
      ...items.map((entry) => [entry.question, entry.id === 'fails' ? 'failed' : 'done']),
    ])
    const [warm, ...scored] = runs
    expect(result.coldStartMs).toBe(warm!.latency_ms)
    expect(warm!.latency_ms).toBeGreaterThanOrEqual(WARM_DELAY_MS)
    expect(result.rows).toHaveLength(items.length)
    expect(result.rows.map((r) => [r.item.id, r.score.precision, r.score.recall])).toEqual([
      ['ab', 1, 0.5],
      ['a-c', 0, 0],
      ['abstains', 0, 0],
      ['nf-cited', null, null],
      ['nf-abstains', null, null],
      ['fails', 0, 0],
    ])
    const latencies = scored.map((run) => run.latency_ms)
    expect(result.summary).toMatchObject({
      rows: 6,
      answerable: 4,
      failed: 1,
      macroPrecision: (1 + 0 + 0 + 0) / 4,
      macroRecall: (0.5 + 0 + 0 + 0) / 4,
      microPrecision: 1 / (1 + 2),
      microRecall: 1 / (2 + 1 + 1 + 1),
      correctAbstentions: { count: 1, of: 2 },
      falseAbstentions: { count: 1, of: 4 },
      notFoundAccuracy: { count: 3, of: 6 },
      p50: nearestRank(latencies, 50),
      p95: nearestRank(latencies, 95),
      latencyN: 6,
    })
    expect(result.summary.p95).toBeLessThan(warm!.latency_ms)

    const paths = resultPaths(root, AT, 'local-qwen')
    expect(result.paths).toEqual(paths)
    const lines = (await readFile(paths.csv, 'utf8')).split('\n')
    const tail = (index: number): string => {
      const run = scored[index]!
      return `${run.latency_ms},${run.tokens_in},${run.tokens_out}`
    }
    expect(lines).toEqual([
      CSV_HEADER.join(','),
      `ab,en,1,done,false,false,${A},${A} ${B},1,0.5,${tail(0)}`,
      `a-c,pl,1,done,false,false,${A} ${C},${A},0,0,${tail(1)}`,
      `abstains,en,1,done,false,true,,${A},0,0,${tail(2)}`,
      `nf-cited,en,1,done,true,false,${C},,,,${tail(3)}`,
      `nf-abstains,en,1,done,true,true,,,,,${tail(4)}`,
      `fails,en,1,failed,false,,,${A},0,0,${tail(5)}`,
      '',
    ])
    expect(scored.slice(0, 5).every((run) => run.tokens_in > 0 && run.tokens_out > 0)).toBe(true)
    const md = await readFile(paths.md, 'utf8')
    expect(md).toContain(`| Git sha | ${SHA} |`)
    expect(md).toContain('| Items | 6 |')
    expect(md).toContain(`| Cold start | ${warm!.latency_ms} ms |`)
    expect(md).toContain('| Citation precision (macro) | 0.2500 | 4 |')
    expect(md).toContain('| Citation recall (macro) | 0.1250 | 4 |')
    expect(md).toContain('| Citation precision (micro) | 0.3333 | 4 |')
    expect(md).toContain('| Citation recall (micro) | 0.2000 | 4 |')
    expect(md).toContain('| False abstentions | 1/4 (0.2500) | 4 |')
    expect(md).toContain(`| Latency p95 | ${nearestRank(latencies, 95)} ms | 6 |`)
  })

  test('--repeat runs the whole set again and numbers the passes', async ({
    root,
    scriptedLlm,
    embedder: _,
    testSettings,
    unreachableOllama: __,
  }) => {
    const items = [item('one'), item('two', { not_found: true })]
    await writeItems(root, items)
    route(scriptedLlm, [
      { query: WARM, answer: claim(A) },
      { query: 'r1-one', answer: claim(A) },
      { query: 'r1-two', answer: ABSTAIN },
      { query: 'r2-one', answer: ABSTAIN },
      { query: 'r2-two', answer: claim(B) },
    ])

    const result = await runQaEval(options(root, testSettings, 2))

    expect(result.rows.map((r) => [r.item.id, r.repeat, r.score.notFoundGot])).toEqual([
      ['one', 1, false],
      ['two', 1, true],
      ['one', 2, true],
      ['two', 2, false],
    ])
    expect(result.summary).toMatchObject({
      macroPrecision: 0.5,
      falseAbstentions: { count: 1, of: 2 },
      correctAbstentions: { count: 1, of: 2 },
      latencyN: 4,
    })
    const md = await readFile(result.paths.md, 'utf8')
    expect(md).toContain('| Items | 2 |')
    expect(md).toContain('| Repeats | 2 |')
    const csvLines = (await readFile(result.paths.csv, 'utf8')).trimEnd().split('\n')
    expect(csvLines.slice(1).map((line) => line.split(',').slice(0, 3).join(','))).toEqual([
      'one,en,1',
      'two,en,1',
      'one,en,2',
      'two,en,2',
    ])
  })

  test('a failed warm-up stops the run before any item and writes no files', async ({
    root,
    scriptedLlm,
    embedder,
    testSettings,
    unreachableOllama: _,
    quietErrors: __,
  }) => {
    await writeItems(root, [item('never')])
    route(scriptedLlm, [{ query: FAIL }])

    await expect(runQaEval(options(root, testSettings))).rejects.toThrow(
      new EvalFailed('The warm-up turn ended failed; no results written'),
    )
    expect(embedder).toEqual([FAIL])
    expect(existsSync(join(root, 'evals', 'results'))).toBe(false)
  })

  test('the runtime closes the executor first, then both pools', async ({
    root,
    scriptedLlm,
    embedder: _,
    testSettings,
    unreachableOllama: __,
    closing,
  }) => {
    await writeItems(root, [item('one')])
    route(scriptedLlm, [
      { query: WARM, answer: claim(A) },
      { query: 'q', answer: claim(A) },
    ])

    await runQaEval(options(root, testSettings))

    expectClosed(closing)
  })

  test('the runtime is closed when the warm-up fails', async ({
    root,
    scriptedLlm,
    embedder: _,
    testSettings,
    unreachableOllama: __,
    quietErrors: ___,
    closing,
  }) => {
    await writeItems(root, [item('never')])
    route(scriptedLlm, [{ query: FAIL }])

    await expect(runQaEval(options(root, testSettings))).rejects.toThrow(EvalFailed)
    expectClosed(closing)
  })

  test('without injection the files carry the time of the run and the repository sha', async ({
    root,
    scriptedLlm,
    embedder: _,
    testSettings,
    unreachableOllama: __,
  }) => {
    await writeItems(root, [item('one')])
    const head = commitAll(root)
    route(scriptedLlm, [
      { query: WARM, answer: claim(A) },
      { query: 'q', answer: claim(A) },
    ])
    const before = Date.now()

    const result = await runQaEval({
      root,
      settings: testSettings,
      profile: 'local-qwen',
      repeat: 1,
    })

    const md = await readFile(result.paths.md, 'utf8')
    const sha = /^\| Git sha \| (\S+) \|$/m.exec(md)?.[1]
    expect(sha).toMatch(/^[0-9a-f]{40}(-dirty)?$/)
    expect(sha).toBe(head)
    const at = new Date(/^\| Date \| (\S+) \|$/m.exec(md)?.[1] ?? '')
    expect(at.getTime()).toBeGreaterThanOrEqual(before)
    expect(at.getTime()).toBeLessThanOrEqual(Date.now())
    expect(result.paths).toEqual(resultPaths(root, at, 'local-qwen'))
  })

  test('a running run in another conversation stays running', async ({
    root,
    scriptedLlm,
    embedder: _,
    testSettings,
    unreachableOllama: __,
    heldRun,
  }) => {
    await writeItems(root, [item('one')])
    route(scriptedLlm, [
      { query: WARM, answer: claim(A) },
      { query: 'q', answer: claim(A) },
    ])

    await runQaEval(options(root, testSettings))

    const { rows } = await heldRun.pool.query<{ status: string; error: string | null }>(
      'SELECT status, error FROM runs WHERE id = $1',
      [heldRun.runId],
    )
    expect(rows).toEqual([{ status: 'running', error: null }])
  })
})

interface Invoked {
  code: number
  stdout: string
  stderr: string
  evaluated: EvalCommandOptions[]
}

async function invoke(args: string[], evaluate?: Commands['evaluate']): Promise<Invoked> {
  let stdout = ''
  let stderr = ''
  const evaluated: EvalCommandOptions[] = []
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk)
    return true
  })
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk)
    return true
  })
  try {
    const code = await main(['eval', ...args], {
      evaluate:
        evaluate ??
        (async (given) => {
          evaluated.push(given)
        }),
    })
    return { code, stdout, stderr, evaluated }
  } finally {
    out.mockRestore()
    err.mockRestore()
  }
}

describe('the mokosz eval command line', () => {
  test.for([
    [[], { repeat: 1 }],
    [['--profile', 'local-gemma'], { profile: 'local-gemma', repeat: 1 }],
    [['--repeat', '3'], { repeat: 3 }],
    [['--repeat=2', '--profile=cloud-claude'], { profile: 'cloud-claude', repeat: 2 }],
  ] as const)('mokosz eval %j', async ([args, expected]) => {
    const { code, stderr, evaluated } = await invoke([...args])

    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    expect(evaluated).toEqual([expected])
  })

  test.for([
    [['--set', 'qa'], "unknown option '--set'"],
    [['--repeat', '0'], "'--repeat <repeat>' argument '0' is invalid"],
    [['--repeat', '-2'], "'--repeat <repeat>' argument '-2' is invalid"],
    [['--repeat', 'two'], "'--repeat <repeat>' argument 'two' is invalid"],
    [['--repeat', '1.5'], "'--repeat <repeat>' argument '1.5' is invalid"],
    [['extra'], "too many arguments for 'eval'"],
    [['--repeats', '2'], 'Did you mean --repeat?'],
  ] as const)('mokosz eval %j is a usage error', async ([args, message]) => {
    const { code, stdout, stderr, evaluated } = await invoke([...args])

    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain(message)
    expect(evaluated).toEqual([])
  })
})

function evalWith(root: string): Commands['evaluate'] {
  return (given) =>
    evalCommand(root, getSettings(), given, (opts) =>
      runQaEval({ ...opts, now: () => AT, sha: async () => SHA }),
    )
}

describe('mokosz eval errors and output', () => {
  test('an unknown profile is one error line and exit 1', async ({ root }) => {
    await writeItems(root, [item('one')])

    const { code, stdout, stderr } = await invoke(['--profile', 'nope'], evalWith(root))

    expect({ code, stdout, stderr }).toEqual({
      code: 1,
      stdout: '',
      stderr: 'Profile error: unknown profile: nope\n',
    })
  })

  test('a database that is down is one error line and exit 1', async ({ root }) => {
    await writeItems(root, [item('one')])
    vi.stubEnv('DATABASE_URL', CLOSED_DB)
    clearSettingsCache()
    try {
      const { code, stdout, stderr } = await invoke([], evalWith(root))

      expect({ code, stdout }).toEqual({ code: 1, stdout: '' })
      expect(stderr).toMatch(/^Database unreachable: \S[^\n]*\n$/)
      expect(stderr).toContain('ECONNREFUSED')
    } finally {
      vi.unstubAllEnvs()
      clearSettingsCache()
    }
  })

  test('a missing set is one error line and exit 1', async ({ root }) => {
    const { code, stdout, stderr } = await invoke([], evalWith(root))

    expect({ code, stdout, stderr }).toEqual({
      code: 1,
      stdout: '',
      stderr: `Eval set error: ${itemsPath(root)} does not exist\n`,
    })
  })

  test('the settings default profile is used and the summary is printed', async ({
    root,
    scriptedLlm,
    embedder: _,
    unreachableOllama: __,
  }) => {
    await writeItems(root, [item('one')])
    route(scriptedLlm, [
      { query: WARM, answer: claim(A) },
      { query: 'q', answer: claim(A, B) },
    ])
    vi.stubEnv('DEFAULT_PROFILE', 'local-gemma')
    clearSettingsCache()
    try {
      const { code, stdout, stderr } = await invoke([], evalWith(root))

      expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
      const lines = stdout.trimEnd().split('\n')
      expect(lines.slice(0, 8)).toEqual([
        'Citation precision (macro): 0.5000 (n=1)',
        'Citation recall (macro): 1.0000 (n=1)',
        'Citation precision (micro): 0.5000 (n=1)',
        'Citation recall (micro): 1.0000 (n=1)',
        'Correct abstentions: 0/0 (n=0)',
        'False abstentions: 0/1 (0.0000) (n=1)',
        'not_found accuracy: 1/1 (1.0000) (n=1)',
        'Failed turns: 0 (n=1)',
      ])
      expect(lines[8]).toMatch(/^Latency p50: \d+ ms \(n=1\)$/)
      expect(lines[9]).toMatch(/^Latency p95: \d+ ms \(n=1\)$/)
      expect(lines[10]).toMatch(/^Cold start: \d+ ms \(n=1\)$/)
      expect(lines.slice(11)).toEqual([
        'evals/results/2026-11-04-2035-local-gemma-qa.csv',
        'evals/results/2026-11-04-2035-local-gemma.md',
      ])
      const md = await readFile(resultPaths(root, AT, 'local-gemma').md, 'utf8')
      expect(md).toContain('| Router model | ollama_chat/gemma4:26b |')
    } finally {
      vi.unstubAllEnvs()
      clearSettingsCache()
    }
  })
})
