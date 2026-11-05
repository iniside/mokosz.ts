import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { HOOKS, runHook, tempDir } from './util.ts'

// The absolute path of `sh` (a Windows path under Git Bash), so it starts without PATH.
function shellPath(): string {
  const which = spawnSync(
    'sh',
    [
      '-c',
      'p=$(command -v sh); if command -v cygpath >/dev/null; then cygpath -w "$p"; else echo "$p"; fi',
    ],
    { encoding: 'utf8' },
  )
  const path = which.stdout.trim()
  expect(path, which.stderr).not.toBe('')
  return path
}

// The directory of `sh` and its coreutils: a PATH that has no node in it.
function shellDir(): string {
  const which = spawnSync('sh', ['-c', 'dirname "$(command -v dirname)"'], { encoding: 'utf8' })
  const dir = which.stdout.trim()
  expect(dir, which.stderr).not.toBe('')
  const nodeThere = spawnSync('sh', ['-c', `PATH="${dir}" node -e ""`], { encoding: 'utf8' })
  expect(nodeThere.status, 'node must not be next to sh for this test').not.toBe(0)
  return dir
}

it.each([
  [{ prompt: 'x' }, true],
  [{ prompt: 'x', model: ' ' }, true],
  [{ prompt: 'x', model: 'sonnet' }, false],
  [{ prompt: 'x', model: String.fromCharCode(0xfeff) }, true],
  [{ prompt: 'x', model: String.fromCharCode(0x85) }, false],
])('agent model guard on %j denies: %s', (toolInput, denied) => {
  const out = runHook('agent-model-guard.ts', { tool_input: toolInput })
  expect(out?.hookSpecificOutput?.permissionDecision === 'deny').toBe(denied)
})

it('plan checklist adds context', () => {
  const out = runHook('plan-checklist.ts', {})
  expect(out.hookSpecificOutput.additionalContext).toContain('hostile-reviewer')
})

it('settings wire each hook to its event and matcher, run by node', () => {
  const settings = JSON.parse(readFileSync(join(HOOKS, '..', 'settings.json'), 'utf8'))
  const wiring: string[] = []
  for (const [event, groups] of Object.entries<any[]>(settings.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        const match = /^sh "\$CLAUDE_PROJECT_DIR\/\.claude\/hooks\/run\.sh" ([\w-]+\.ts)$/.exec(
          hook.command,
        )
        expect(match, hook.command).not.toBeNull()
        expect(existsSync(join(HOOKS, match![1]!)), hook.command).toBe(true)
        wiring.push(`${event} ${group.matcher} ${match![1]}`)
      }
    }
  }
  expect(wiring.sort()).toEqual([
    'PostToolUse Bash|PowerShell post-commit-review-reminder.ts',
    'PreToolUse Bash|PowerShell git-safety.ts',
    'PreToolUse ExitPlanMode plan-checklist.ts',
    'PreToolUse Task|Agent agent-model-guard.ts',
  ])
})

it('run.sh passes stdin and the exit code through', () => {
  const proc = spawnSync('sh', [join(HOOKS, 'run.sh'), 'agent-model-guard.ts'], {
    input: JSON.stringify({ tool_input: { prompt: 'x' } }),
    encoding: 'utf8',
  })
  expect(proc.status).toBe(0)
  expect(JSON.parse(proc.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
})

it('run.sh passes the arguments and a non-zero exit code through', () => {
  const message = join(tempDir(), 'MSG')
  writeFileSync(message, 'update stuff\n')
  const proc = spawnSync('sh', [join(HOOKS, 'run.sh'), 'commit-format.ts', message], {
    encoding: 'utf8',
  })
  expect(proc.status).toBe(1)
  expect(proc.stderr).toContain('Bad commit subject')
})

it('run.sh blocks (exit 2) when node does not start', () => {
  const dir = shellDir()
  // run.sh is run directly (not sourced: dash's `.` drops the arguments) with a PATH without node.
  const proc = spawnSync(shellPath(), [join(HOOKS, 'run.sh'), 'git-safety.ts'], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git reset --hard' } }),
    env: { ...process.env, PATH: dir, Path: dir },
    encoding: 'utf8',
  })
  expect(proc.status).toBe(2)
  expect(proc.stderr).toContain('no working node')
})

it('the git commit-msg hook runs the commit format check', () => {
  const hook = join(HOOKS, '..', '..', '.githooks', 'commit-msg')
  const message = join(tempDir(), 'MSG')
  writeFileSync(message, 'update stuff\n')
  const proc = spawnSync('sh', [hook, message], { encoding: 'utf8' })
  expect(proc.status).toBe(1)
  expect(proc.stderr).toContain('Bad commit subject')
})
