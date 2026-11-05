import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect } from 'vitest'

export const HOOKS = resolve(import.meta.dirname, '..', '..', '.claude', 'hooks')

// A non-zero exit fails the test, so a crashing hook never counts as "allow".
export function runHook(script: string, payload: object, cwd?: string): any {
  const proc = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(payload),
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
  })
  expect(proc.status, proc.stderr).toBe(0)
  const out = proc.stdout.trim()
  return out ? JSON.parse(out) : null
}

export function git(repo: string, ...args: string[]): string {
  const proc = spawnSync('git', ['-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', ...args], {
    cwd: repo,
    encoding: 'utf8',
  })
  if (proc.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${proc.stderr}`)
  return proc.stdout
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mokosz-hooks-'))
}

export function makeRepo(): string {
  const root = join(tempDir(), 'repo')
  mkdirSync(root)
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'test')
  writeFileSync(join(root, 'README.md'), 'start\n')
  git(root, 'add', 'README.md')
  git(root, 'commit', '-q', '-m', 'docs(readme): start')
  return root
}

export function makePlansDir(): string {
  const plans = join(tempDir(), 'plans')
  mkdirSync(plans)
  writeFileSync(join(plans, '2026-11-03-0900-qa-graph-plan.md'), '# plan\n')
  return plans
}
