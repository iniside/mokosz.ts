// PostToolUse (Bash, PowerShell): after a `git commit` that touched code, remind
// the session of AGENTS.md 'Hostile Diff Review': an above-threshold commit gets a
// fresh hostile-reviewer subagent, within the two-round cap; inline-size changes
// get none. The reminder is non-blocking and cannot judge the threshold or count
// rounds; the rule in AGENTS.md decides.
//
// Commits touching only prose are skipped: there is no code to review. Prose here
// means narrative formats only — config and schema files are behaviour-bearing
// (`.claude/settings.json` wires the guardrails, `profiles/*.yaml` choose models,
// `evals/` hold the test sets) and are deliberately treated as code.
//
// Every uncertainty resolves toward reminding: an unrecognised extension, a merge,
// an unparseable commit line, an empty file list, or any git failure all fire.
import { spawnSync } from 'node:child_process'
import { extname } from 'node:path'
import { splitLines } from './commit-format.ts'
import { emit, readInput, text, type HookInput } from './io.ts'

// `git commit` behind global options too (`git -C <path> commit`); `\b` after
// `commit` plus the explicit check below keep `git commit-graph` out.
const GIT_COMMIT =
  /\bgit(?:\.exe)?(?:\s+(?:-C\s*\S+|-c\s*\S+|-[pP]\b|--[\w-]+(?:=\S+)?))*\s+commit\b/

// Narrative formats only. Config/schema files are behaviour and are NOT listed.
const PROSE_SUFFIXES = new Set(['.md', '.markdown', '.txt', '.rst'])

// `git commit` prints "[main c3682de479d9] subject" (or "[detached HEAD abc1234]").
const COMMIT_LINE = /^\[[^\]]*?\b([0-9a-f]{7,40})\]/gm

function runGit(cwd: string | undefined, args: string[]): [boolean, string] {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 })
  if (out.error || out.status !== 0) return [false, '']
  return [true, out.stdout]
}

function isProseOnlySha(cwd: string | undefined, sha: string): boolean {
  // A merge's `git show --name-only` defaults to --cc: it lists only paths that
  // differ from EVERY parent, so a 2000-file upstream merge whose sole conflict
  // was CLAUDE.md would report one .md path. Never classify a merge from that.
  const [okParents, parents] = runGit(cwd, ['rev-list', '--parents', '-n', '1', sha])
  if (!okParents) return false
  if (parents.split(/\s+/).filter(Boolean).length > 2) return false

  // --no-renames so a code->prose rename reports the deleted source path too.
  const [okListing, listing] = runGit(cwd, [
    'show',
    '--name-only',
    '--no-renames',
    '--pretty=format:',
    sha,
  ])
  if (!okListing) return false

  const paths = splitLines(listing)
    .map((line) => line.trim())
    .filter(Boolean)
  if (!paths.length) return false
  return paths.every((path) => PROSE_SUFFIXES.has(extname(path).toLowerCase()))
}

function response(data: HookInput): Record<string, unknown> | null {
  const value = data.tool_response
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function shouldSkip(data: HookInput): boolean {
  const stdout = String(response(data)?.stdout ?? '')
  // Resolve the actual SHAs rather than HEAD: the command may have run in
  // another repo (git -C, a nested .git), may have landed several commits, or
  // another commit may have landed on main in between.
  const shas = [...stdout.matchAll(COMMIT_LINE)].map((match) => match[1]!)
  if (!shas.length) return false
  const cwd = text(data.cwd) || undefined
  return shas.every((sha) => isProseOnlySha(cwd, sha))
}

function main(): void {
  const data = readInput()
  if (data === null) return

  const command = text(data.tool_input?.command).toLowerCase()
  if (!GIT_COMMIT.test(command) || command.includes('commit-graph')) return
  // skip obvious non-landing invocations
  if (command.includes('--dry-run') || command.includes('--amend')) return
  // PostToolUse fires regardless of exit status; skip failed / empty commits
  const result = response(data)
  if (result) {
    const stdout = String(result.stdout ?? '')
    const combined = stdout + String(result.stderr ?? '')
    if (combined.toLowerCase().includes('nothing to commit')) return
    // Text that merely mentions `git commit` (scripts, heredocs) lands nothing; a
    // real commit prints its "[branch sha]" line unless it ran with -q.
    if (!stdout.match(COMMIT_LINE) && !/\s(?:-q|--quiet)\b/.test(command)) return
  }

  if (shouldSkip(data)) return

  emit({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext:
        'REVIEW REMINDER (AGENTS.md Hostile Diff Review): a code commit ' +
        'landed. If it is above the inline threshold and the task has ' +
        'had fewer than two review rounds, dispatch a fresh ' +
        "`hostile-reviewer` (explicit model >= the author's tier) on the " +
        'commit(s) just made and the cumulative task diff; add ' +
        '`proof-auditor` if tests, fixtures or evals changed. Inline-size ' +
        'fixes and commits after round 2 get no review: report leftovers ' +
        'to the maintainer instead.',
    },
  })
}

main()
