import { describe, expect, it } from 'vitest'
import { runHook } from './util.ts'

const TRAILER = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'

// The hook never approves: "allow" means no output at all, so normal permission handling applies.
function decision(command: string, tool = 'Bash'): 'deny' | 'allow' {
  const out = runHook('git-safety.ts', { tool_name: tool, tool_input: { command } })
  if (out === null) return 'allow'
  expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
  return 'deny'
}

describe('destructive git guard', () => {
  it.each([
    ['git stash', 'deny'],
    ['git -C /repo stash push', 'deny'],
    ['git stash list', 'allow'],
    ['git restore src/app.ts', 'deny'],
    ['git clean -fd', 'deny'],
    ['git checkout -- src/app.ts', 'deny'],
    ['git checkout .', 'deny'],
    ['git checkout -f main', 'deny'],
    ['git checkout --force main', 'deny'],
    ['git checkout main', 'allow'],
    ['git checkout -b feature', 'allow'],
    ['git switch -f main', 'deny'],
    ['git switch --discard-changes main', 'deny'],
    ['git switch main', 'allow'],
    ['git reset --hard HEAD', 'deny'],
    ['git reset HEAD~2', 'deny'],
    ['git reset @~2', 'deny'],
    ['git reset HEAD^^', 'deny'],
    ['git reset HEAD^2', 'deny'],
    ['git reset 1a2b3c4d', 'deny'],
    ['git reset', 'allow'],
    ['git reset src/app.ts', 'allow'],
    ['git reset HEAD~1', 'allow'],
    ['git reset HEAD^', 'allow'],
    ['git reset --soft HEAD~1', 'allow'],
    ['rm .git/index', 'deny'],
    ['rm -f .git/index.lock', 'allow'],
    ["echo 'never run git stash here'", 'allow'],
    ['ls -la', 'allow'],
  ])('%s -> %s', (command, expected) => {
    expect(decision(command)).toBe(expected)
  })

  it('names the permitted resets in the reset denial', () => {
    const out = runHook('git-safety.ts', {
      tool_name: 'Bash',
      tool_input: { command: 'git reset HEAD~2' },
    })
    const reason: string = out.hookSpecificOutput.permissionDecisionReason
    expect(reason).toContain('git reset [<paths>]')
    expect(reason).not.toContain('other agents')
  })
})

describe('commit guard', () => {
  it.each([
    [`git commit -m "feat(api): add health endpoint" -m "${TRAILER}" -- src/`, 'allow'],
    ['git commit -m "feat(api): add health endpoint"', 'deny'],
    [`git commit -m "update stuff" -m "${TRAILER}"`, 'deny'],
    [`git commit -n -m "feat(api): add health endpoint" -m "${TRAILER}"`, 'deny'],
    [`git commit --no-verif -m "feat(api): add health endpoint" -m "${TRAILER}"`, 'deny'],
    [`git commit -m "feat(api): x (no-such-plan step 1)" -m "${TRAILER}"`, 'deny'],
    [
      `git commit -m "docs(spec): fix typo" -m "${TRAILER}" && git commit -m "bad subject" -m "${TRAILER}"`,
      'deny',
    ],
  ])('%s -> %s', (command, expected) => {
    expect(decision(command)).toBe(expected)
  })

  it('checks a PowerShell here-string commit', () => {
    const good = `git commit -m @'\nfeat(api): add health endpoint\n\n${TRAILER}\n'@ -- src/`
    const bad = `git commit -m @'\nupdate stuff\n\n${TRAILER}\n'@ -- src/`
    expect(decision(good, 'PowerShell')).toBe('allow')
    expect(decision(bad, 'PowerShell')).toBe('deny')
  })

  it('checks a bash heredoc commit', () => {
    const good = `git commit -F - <<'EOF'\nfeat(api): add health endpoint\n\n${TRAILER}\nEOF`
    const bad = `git commit -F - <<'EOF'\nupdate stuff\n\n${TRAILER}\nEOF`
    expect(decision(good)).toBe('allow')
    expect(decision(bad)).toBe('deny')
  })
})

describe('unusual whitespace between words', () => {
  const NBSP = String.fromCharCode(0xa0)
  it.each([
    ['git\treset --hard', 'Bash', 'deny'],
    [`git${NBSP}reset --hard`, 'PowerShell', 'deny'],
    ['git\tclean -fdx', 'PowerShell', 'deny'],
    ['git\tcheckout -- .', 'Bash', 'deny'],
    ['git\tcommit --no-verify -m "feat(api): x" -m "' + TRAILER + '"', 'PowerShell', 'deny'],
    [`git commit -m "feat(api): x" -m "Co-Authored-By:${NBSP}Claude"`, 'Bash', 'allow'],
  ])('%j under %s: %s', (command, tool, expected) => {
    expect(decision(command, tool)).toBe(expected)
  })
})

describe('separators one shell sees and the other does not', () => {
  const NEL = String.fromCharCode(0x85)
  const US = String.fromCharCode(0x1f)
  const BOM = String.fromCharCode(0xfeff)
  const EM = String.fromCharCode(0x2003)
  const NO_TRAILER = 'git commit -m "feat(api): x"'
  it.each(['Bash', 'PowerShell'])('%s denies a destructive verb after a word separator', (tool) => {
    for (const command of [
      `git${NEL}reset --hard`,
      `git${US}reset --hard`,
      `git${NEL}clean -fdx`,
      `git${NEL}stash`,
      `git checkout${NEL}.`,
      `git${NEL}commit --no-verify -m "feat(api): x" -m "${TRAILER}"`,
      `git commit${NEL}--no-verify -m "feat(api): x" -m "${TRAILER}"`,
    ]) {
      expect(decision(command, tool), command).toBe('deny')
    }
  })

  it.each(['Bash', 'PowerShell'])('%s reads # as a comment only after an ASCII blank', (tool) => {
    for (const blank of [BOM, EM]) {
      expect(decision(`echo${blank}#; git reset --hard`, tool), blank).toBe('deny')
      expect(decision(`echo${blank}#; ${NO_TRAILER}`, tool), blank).toBe('deny')
    }
    expect(decision('echo hi # git reset --hard', tool)).toBe('allow')
  })
})
