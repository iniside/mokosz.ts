import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { CommandError } from '../command.ts'
import { ProfileError, loadProfile, type Profile } from '../llm/profiles.ts'
import { MEMORY } from '../mastra/memory.ts'
import { AnswerSchema, type Answer } from '../mastra/workflows/state.ts'
import { DatabaseUnreachable, openRuntime, type Runtime } from '../runs/runtime.ts'
import { createConversation, type RunStatus } from '../runs/conversations.ts'
import { turns } from '../runs/turns.ts'
import type { Settings } from '../settings.ts'
import { oneLine } from '../text.ts'
import { EvalSetError, loadItems, type EvalItem } from './qa.ts'

export const WARM_UP =
  'How long does a controller have to notify a personal data breach to the supervisory authority?'

const execFileAsync = promisify(execFile)

export class EvalFailed extends Error {
  override name = 'EvalFailed'
}

function detail(error: unknown): string {
  if (!(error instanceof Error)) return oneLine(String(error))
  const code: unknown = Reflect.get(error, 'code')
  const text = oneLine(error.message)
  if (text !== '') return text
  return typeof code === 'string' ? code : error.name
}

/** The runtime without failInterruptedRuns: a running serve keeps its runs. */
async function openEvalRuntime(settings: Settings): Promise<Runtime> {
  try {
    return await openRuntime(settings)
  } catch (error) {
    if (!(error instanceof DatabaseUnreachable)) throw error
    throw new EvalFailed(`Database unreachable: ${detail(error.cause)}`, { cause: error.cause })
  }
}

export interface Observed {
  readonly status: RunStatus
  /** Null when the turn failed: a status other than done, or no answer. */
  readonly answer: Answer | null
  readonly latencyMs: number | null
  readonly tokensIn: number
  readonly tokensOut: number
}

/** One turn in a new conversation, through the executor as the API runs it. */
export async function ask(runtime: Runtime, profile: Profile, question: string): Promise<Observed> {
  const memory = runtime.mastra.getMemory(MEMORY)
  const conversationId = await createConversation(memory)
  const runId = await runtime.executor.start(conversationId, question, profile)
  await runtime.executor.tasks.get(runId)?.done
  const turn = (await turns(runtime.pool, memory, conversationId))?.[0]
  if (turn === undefined) throw new Error(`conversation ${conversationId} has no turn`)
  const answer =
    turn.status === 'done' && turn.answer !== null ? AnswerSchema.parse(turn.answer) : null
  return {
    status: turn.status,
    answer,
    latencyMs: turn.metrics.latency_ms,
    tokensIn: turn.metrics.tokens_in,
    tokensOut: turn.metrics.tokens_out,
  }
}

export interface Score {
  /** Null for a failed turn. */
  readonly notFoundGot: boolean | null
  readonly notFoundCorrect: boolean
  readonly cited: readonly string[]
  readonly hits: number
  readonly citedCount: number
  readonly expectedCount: number
  /** Null for a not_found item. */
  readonly precision: number | null
  readonly recall: number | null
}

/** The keys cited in the answer's claims, in any language: turns().citations drops unknown keys. */
export function citedKeys(answer: Answer): string[] {
  return [...new Set(answer.claims.flatMap((claim) => claim.citations))].toSorted()
}

export function score(
  item: Pick<EvalItem, 'lang' | 'expected' | 'not_found'>,
  answer: Answer | null,
): Score {
  const cited = answer === null ? [] : citedKeys(answer)
  const notFoundGot = answer === null ? null : answer.not_found
  const notFoundCorrect = notFoundGot === item.not_found
  if (item.not_found) {
    return {
      notFoundGot,
      notFoundCorrect,
      cited,
      hits: 0,
      citedCount: 0,
      expectedCount: 0,
      precision: null,
      recall: null,
    }
  }
  const expected = new Set(item.expected)
  const counted = answer === null || answer.not_found ? [] : cited
  // Keys are shared by EN and PL: a key cited in the other language is not the expected chunk.
  const hits = answer?.lang === item.lang ? counted.filter((key) => expected.has(key)).length : 0
  return {
    notFoundGot,
    notFoundCorrect,
    cited,
    hits,
    citedCount: counted.length,
    expectedCount: expected.size,
    precision: counted.length === 0 ? 0 : hits / counted.length,
    recall: hits / expected.size,
  }
}

export interface Row {
  readonly item: EvalItem
  readonly repeat: number
  readonly status: RunStatus
  readonly score: Score
  readonly latencyMs: number | null
  readonly tokensIn: number
  readonly tokensOut: number
}

export interface Ratio {
  readonly count: number
  readonly of: number
}

export interface Summary {
  readonly rows: number
  readonly answerable: number
  readonly failed: number
  readonly macroPrecision: number | null
  readonly macroRecall: number | null
  readonly microPrecision: number | null
  readonly microRecall: number | null
  readonly correctAbstentions: Ratio
  readonly falseAbstentions: Ratio
  readonly notFoundAccuracy: Ratio
  readonly p50: number | null
  readonly p95: number | null
  readonly latencyN: number
}

/** The nearest-rank percentile: the value at rank ceil(p/100 * n) of the sorted values. */
export function nearestRank(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = values.toSorted((a, b) => a - b)
  const rank = Math.max(1, Math.ceil((p * sorted.length) / 100))
  return sorted[rank - 1]!
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0)
const mean = (values: readonly number[]): number | null =>
  values.length === 0 ? null : sum(values) / values.length

export function summarise(rows: readonly Row[]): Summary {
  const answerable = rows.filter((row) => !row.item.not_found)
  const unanswerable = rows.filter((row) => row.item.not_found)
  const scores = answerable.map((row) => row.score)
  const hits = sum(scores.map((s) => s.hits))
  const cited = sum(scores.map((s) => s.citedCount))
  const expected = sum(scores.map((s) => s.expectedCount))
  const latencies = rows.flatMap((row) => (row.latencyMs === null ? [] : [row.latencyMs]))
  return {
    rows: rows.length,
    answerable: answerable.length,
    failed: rows.filter((row) => row.score.notFoundGot === null).length,
    macroPrecision: mean(scores.map((s) => s.precision!)),
    macroRecall: mean(scores.map((s) => s.recall!)),
    microPrecision: answerable.length === 0 ? null : cited === 0 ? 0 : hits / cited,
    microRecall: answerable.length === 0 ? null : hits / expected,
    correctAbstentions: {
      count: unanswerable.filter((row) => row.score.notFoundGot === true).length,
      of: unanswerable.length,
    },
    falseAbstentions: {
      count: answerable.filter((row) => row.score.notFoundGot === true).length,
      of: answerable.length,
    },
    notFoundAccuracy: {
      count: rows.filter((row) => row.score.notFoundCorrect).length,
      of: rows.length,
    },
    p50: nearestRank(latencies, 50),
    p95: nearestRank(latencies, 95),
    latencyN: latencies.length,
  }
}

const fixed = (value: number | null): string => (value === null ? '—' : value.toFixed(4))
const ms = (value: number | null): string => (value === null ? '—' : `${value} ms`)
const ratio = ({ count, of }: Ratio): string =>
  of === 0 ? `${count}/${of}` : `${count}/${of} (${(count / of).toFixed(4)})`

/** The summary's metrics as [metric, value, n]. */
export function metrics(summary: Summary, coldStartMs: number | null): [string, string, number][] {
  return [
    ['Citation precision (macro)', fixed(summary.macroPrecision), summary.answerable],
    ['Citation recall (macro)', fixed(summary.macroRecall), summary.answerable],
    ['Citation precision (micro)', fixed(summary.microPrecision), summary.answerable],
    ['Citation recall (micro)', fixed(summary.microRecall), summary.answerable],
    ['Correct abstentions', ratio(summary.correctAbstentions), summary.correctAbstentions.of],
    ['False abstentions', ratio(summary.falseAbstentions), summary.falseAbstentions.of],
    ['not_found accuracy', ratio(summary.notFoundAccuracy), summary.notFoundAccuracy.of],
    ['Failed turns', String(summary.failed), summary.rows],
    ['Latency p50', ms(summary.p50), summary.latencyN],
    ['Latency p95', ms(summary.p95), summary.latencyN],
    ['Cold start', ms(coldStartMs), 1],
  ]
}

export const CSV_HEADER = [
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
]

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

const blank = (value: number | null): string => (value === null ? '' : String(value))

export function csv(rows: readonly Row[]): string {
  const lines = [CSV_HEADER]
  for (const { item, repeat, status, score: s, latencyMs, tokensIn, tokensOut } of rows) {
    lines.push([
      item.id,
      item.lang,
      String(repeat),
      status,
      String(item.not_found),
      s.notFoundGot === null ? '' : String(s.notFoundGot),
      s.cited.join(' '),
      item.expected.join(' '),
      blank(s.precision),
      blank(s.recall),
      blank(latencyMs),
      String(tokensIn),
      String(tokensOut),
    ])
  }
  return lines.map((fields) => `${fields.map(csvField).join(',')}\n`).join('')
}

export interface Report {
  readonly profile: Profile
  readonly sha: string
  readonly at: Date
  readonly items: number
  readonly repeats: number
  readonly coldStartMs: number | null
  readonly summary: Summary
}

export function markdown(report: Report): string {
  const { profile, summary } = report
  const lines = [
    `# Q&A eval: ${profile.name}`,
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Profile | ${profile.name} |`,
    `| Router model | ${profile.nodes.router.model} |`,
    `| Answerer model | ${profile.nodes.answerer.model} |`,
    `| Git sha | ${report.sha} |`,
    `| Date | ${report.at.toISOString()} |`,
    `| Items | ${report.items} |`,
    `| Repeats | ${report.repeats} |`,
    `| Cold start | ${ms(report.coldStartMs)} |`,
    '',
    '| Metric | Value | n |',
    '| --- | --- | --- |',
    ...metrics(summary, report.coldStartMs).map(
      ([name, value, n]) => `| ${name} | ${value} | ${n} |`,
    ),
    '',
  ]
  return lines.join('\n')
}

/** YYYY-MM-DD-HHMM in UTC. */
export function fileStamp(at: Date): string {
  const iso = at.toISOString()
  return `${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}`
}

export function resultPaths(root: string, at: Date, profile: string): { csv: string; md: string } {
  const directory = join(root, 'evals', 'results')
  const stamp = fileStamp(at)
  return {
    csv: join(directory, `${stamp}-${profile}-qa.csv`),
    md: join(directory, `${stamp}-${profile}.md`),
  }
}

/** HEAD's sha, with -dirty when the tree has changes. */
export async function gitSha(root: string): Promise<string> {
  const head = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })
  const status = await execFileAsync('git', ['status', '--porcelain'], { cwd: root })
  return `${head.stdout.trim()}${status.stdout.trim() === '' ? '' : '-dirty'}`
}

export interface EvalOptions {
  readonly root: string
  readonly settings: Settings
  readonly profile: string
  readonly repeat: number
  readonly now?: () => Date
  readonly sha?: (root: string) => Promise<string>
}

export interface EvalResult {
  readonly paths: { csv: string; md: string }
  readonly rows: readonly Row[]
  readonly summary: Summary
  readonly coldStartMs: number | null
}

export async function runQaEval(options: EvalOptions): Promise<EvalResult> {
  const { root, settings, repeat } = options
  const profile = await loadProfile(options.profile)
  const items = await loadItems(root)
  const at = (options.now ?? (() => new Date()))()
  const sha = await (options.sha ?? gitSha)(root)
  const runtime = await openEvalRuntime(settings)
  try {
    const warm = await ask(runtime, profile, WARM_UP)
    if (warm.answer === null) {
      throw new EvalFailed(`The warm-up turn ended ${warm.status}; no results written`)
    }
    const rows: Row[] = []
    for (let pass = 1; pass <= repeat; pass++) {
      for (const item of items) {
        const observed = await ask(runtime, profile, item.question)
        rows.push({
          item,
          repeat: pass,
          status: observed.status,
          score: score(item, observed.answer),
          latencyMs: observed.latencyMs,
          tokensIn: observed.tokensIn,
          tokensOut: observed.tokensOut,
        })
      }
    }
    const summary = summarise(rows)
    const paths = resultPaths(root, at, profile.name)
    await mkdir(join(root, 'evals', 'results'), { recursive: true })
    await writeFile(paths.csv, csv(rows), 'utf8')
    const report: Report = {
      profile,
      sha,
      at,
      items: items.length,
      repeats: repeat,
      coldStartMs: warm.latencyMs,
      summary,
    }
    await writeFile(paths.md, markdown(report), 'utf8')
    return { paths, rows, summary, coldStartMs: warm.latencyMs }
  } finally {
    await runtime.close()
  }
}

export interface EvalCommandOptions {
  profile?: string
  set: string
  repeat: number
}

export async function evalCommand(
  root: string,
  settings: Settings,
  options: EvalCommandOptions,
  run: typeof runQaEval = runQaEval,
): Promise<void> {
  let result: EvalResult
  try {
    result = await run({
      root,
      settings,
      profile: options.profile ?? settings.defaultProfile,
      repeat: options.repeat,
    })
  } catch (error) {
    if (error instanceof EvalFailed) throw new CommandError(error.message)
    if (error instanceof ProfileError) {
      throw new CommandError(`Profile error: ${oneLine(error.message)}`)
    }
    if (error instanceof EvalSetError) {
      throw new CommandError(`Eval set error: ${oneLine(error.message)}`)
    }
    throw error
  }
  for (const [name, value, n] of metrics(result.summary, result.coldStartMs)) {
    process.stdout.write(`${name}: ${value} (n=${n})\n`)
  }
  for (const path of [result.paths.csv, result.paths.md]) {
    process.stdout.write(`${relative(root, path).split(sep).join('/')}\n`)
  }
}
