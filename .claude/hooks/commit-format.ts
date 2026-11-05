// Single source of the commit message rule (Claude PreToolUse hook: subject; git commit-msg: subject + trailers).
// CLI: node commit-format.ts <commit-msg-file>  -> exit 1 with the error on stderr.
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(import.meta.url)
export const PLANS_DIR = join(resolve(dirname(HERE), '..', '..'), 'docs', 'plans')
const PLAN_FILE = /^\d{4}-\d{2}-\d{2}(?:-\d{4})?-(.+?)(?:-plan)?\.md$/i
const STEP_SUFFIX = /\((?<slug>[a-z0-9][a-z0-9-]*) (?:step \d+|steps \d+-\d+)\)\s*$/
const STEP_MENTION = /\b(?i:steps?)\s+\d/
const EXEMPT = ['Merge ', 'Revert "', 'fixup! ', 'squash! ', 'amend! ']
const SHAPE =
  /^(feat|fix|perf|refactor|test|docs|chore)\([a-z0-9][a-z0-9._-]*(,[a-z0-9][a-z0-9._-]*)*\): \S/

const HELP =
  'Commit subject must be `<type>(<scope>[,<scope>]): <imperative>` with type in feat|fix|perf|' +
  'refactor|test|docs|chore and lowercase scopes (no spaces, no brackets). A subject naming a plan ' +
  'step must END with `(<plan-slug> step <id>)` or `(<plan-slug> steps <a>-<b>)`, the slug being a ' +
  'docs/plans file name without date and `-plan.md`. Example: ' +
  '`feat(ingest): parse Cellar XHTML into paragraph chunks (regulations-ingest step 2)`.'

const exempt = (subject: string): boolean => EXEMPT.some((prefix) => subject.startsWith(prefix))
const repr = (value: string): string => JSON.stringify(value)

export function planSlugs(plansDir: string = PLANS_DIR): Set<string> {
  let entries: string[]
  try {
    entries = readdirSync(plansDir, { recursive: true, encoding: 'utf8' })
  } catch {
    return new Set()
  }
  const slugs = new Set<string>()
  for (const entry of entries) {
    const match = PLAN_FILE.exec(basename(entry))
    if (match) slugs.add(match[1]!.toLowerCase())
  }
  return slugs
}

// Ratcliff/Obershelp similarity, as difflib.SequenceMatcher.ratio() computes it for short strings.
function matchingCharacters(a: string, b: string): number {
  let best = 0
  let bestA = 0
  let bestB = 0
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let k = 0
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++
      if (k > best) {
        best = k
        bestA = i
        bestB = j
      }
    }
  }
  if (best === 0) return 0
  return (
    best +
    matchingCharacters(a.slice(0, bestA), b.slice(0, bestB)) +
    matchingCharacters(a.slice(bestA + best), b.slice(bestB + best))
  )
}

function ratio(a: string, b: string): number {
  const total = a.length + b.length
  return total === 0 ? 1 : (2 * matchingCharacters(a, b)) / total
}

function closeMatches(word: string, candidates: string[], n = 3, cutoff = 0.5): string[] {
  return candidates
    .map((candidate) => ({ candidate, score: ratio(word, candidate) }))
    .filter(({ score }) => score >= cutoff)
    .sort((x, y) => y.score - x.score || (y.candidate > x.candidate ? 1 : -1))
    .slice(0, n)
    .map(({ candidate }) => candidate)
}

export function checkSubject(raw: string, plansDir: string = PLANS_DIR): string | null {
  const subject = raw.trim()
  if (exempt(subject)) return null
  if (!SHAPE.test(subject)) return `Bad commit subject: ${repr(subject)}. ${HELP}`
  if (!STEP_MENTION.test(subject)) return null
  const match = STEP_SUFFIX.exec(subject)
  if (!match) {
    return (
      `Commit subject ${repr(subject)} mentions a step but does not end with ` +
      '`(<plan-slug> step <id>)` or `(<plan-slug> steps <a>-<b>)` (one id or one range, ' +
      `suffix last). ${HELP}`
    )
  }
  const slugs = planSlugs(plansDir)
  const slug = match.groups!.slug!
  if (!slugs.has(slug)) {
    const close = closeMatches(slug, [...slugs].sort())
    const hint = close.length ? ` Closest plan slugs: ${close.join(', ')}.` : ''
    return `Plan slug ${repr(slug)} matches no file under docs/plans.${hint} ${HELP}`
  }
  return null
}

const SCISSORS = /^# -+ >8 -+$/
const TRAILER_LINE = /^[A-Za-z0-9][A-Za-z0-9-]*\s*:\s/
const KIND_LINE = /^kind\s*:/i
const KINDS = ['review-fix']
const KIND_HELP =
  'Put `Kind: review-fix` in the final trailer paragraph together with `Co-Authored-By` (no blank line ' +
  'between, one -m for all trailers); it marks a commit fixing review findings, of a plan step or of a named fix.'

export function splitLines(text: string): string[] {
  // eslint-disable-next-line no-control-regex
  const lines = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/)
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function messageLines(text: string): string[] {
  const lines: string[] = []
  for (const line of splitLines(text)) {
    if (SCISSORS.test(line)) break
    if (!line.trimStart().startsWith('#')) lines.push(line.trimEnd())
  }
  return lines
}

function trailerBlock(lines: string[]): [number, number] {
  let end = lines.length
  while (end > 0 && !lines[end - 1]!.trim()) end--
  let start = end
  while (start > 0 && lines[start - 1]!.trim()) start--
  const block = lines.slice(start, end)
  if (start === 0 || !block.length || !TRAILER_LINE.test(block[0]!)) return [end, end]
  if (block.every((line) => TRAILER_LINE.test(line) || /^[ \t]/.test(line))) return [start, end]
  return [end, end]
}

export function checkMessage(text: string, plansDir: string = PLANS_DIR): string | null {
  const lines = messageLines(text)
  const subjectAt = lines.findIndex((line) => line.trim())
  if (subjectAt < 0) return null
  const subject = lines[subjectAt]!.trim()
  if (exempt(subject)) return null
  const error = checkSubject(subject, plansDir)
  if (error) return error
  let [start, end] = trailerBlock(lines.slice(subjectAt))
  start += subjectAt
  end += subjectAt
  const kinds: string[] = []
  for (let i = subjectAt + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (!KIND_LINE.test(line)) continue
    if (!(start <= i && i < end)) {
      return `\`Kind:\` line outside the final trailer paragraph: ${repr(line.trim())}. ${KIND_HELP}`
    }
    kinds.push(line.slice(line.indexOf(':') + 1).trim())
  }
  if (kinds.length > 1) return `More than one \`Kind:\` trailer (${kinds.join(', ')}). ${KIND_HELP}`
  if (kinds.length && !KINDS.includes(kinds[0]!)) {
    return `Unknown \`Kind: ${kinds[0]}\`; allowed: ${KINDS.join(', ')}. ${KIND_HELP}`
  }
  return null
}

function main(argv: string[]): number {
  if (argv.length !== 1) return 0
  let text: string
  try {
    text = readFileSync(argv[0]!, 'utf8')
  } catch {
    return 0
  }
  const error = checkMessage(text)
  if (error) {
    process.stderr.write(error + '\n')
    return 1
  }
  return 0
}

const realpath = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}
if (process.argv[1] && realpath(process.argv[1]) === realpath(HERE))
  process.exitCode = main(process.argv.slice(2))
