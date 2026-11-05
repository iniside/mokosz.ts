import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { git, makeRepo, runHook } from './util.ts'

function payload(command: string, stdout: string, cwd: string): object {
  return { tool_input: { command }, tool_response: { stdout }, cwd }
}

function commit(repo: string, files: Record<string, string>, subject: string): string {
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(repo, name), content)
    git(repo, 'add', name)
  }
  git(repo, 'commit', '-q', '-m', subject)
  return git(repo, 'rev-parse', '--short', 'HEAD').trim()
}

function reminder(repo: string, sha: string, command = 'git commit -m "x"'): boolean {
  const out = runHook('post-commit-review-reminder.ts', payload(command, `[main ${sha}] x`, repo))
  return out !== null && out.hookSpecificOutput.additionalContext.includes('hostile-reviewer')
}

describe('post-commit review reminder', () => {
  it('reminds after a code commit', () => {
    const repo = makeRepo()
    expect(
      reminder(repo, commit(repo, { 'app.ts': 'export const x = 1\n' }, 'feat(api): add app')),
    ).toBe(true)
  })

  it('reminds after a mixed code and prose commit', () => {
    const repo = makeRepo()
    const sha = commit(
      repo,
      { 'README.md': 'changed\n', 'app.ts': 'export const x = 2\n' },
      'feat(api): app and docs',
    )
    expect(reminder(repo, sha)).toBe(true)
  })

  it('reminds after a config commit', () => {
    const repo = makeRepo()
    expect(
      reminder(repo, commit(repo, { 'profile.yaml': 'model: x\n' }, 'chore(config): profile')),
    ).toBe(true)
  })

  it('stays silent after a prose-only commit', () => {
    const repo = makeRepo()
    expect(
      reminder(repo, commit(repo, { 'README.md': 'prose only\n' }, 'docs(readme): edit')),
    ).toBe(false)
  })

  it('reminds after a merge whose combined diff is prose only', () => {
    // The conflict is only in README.md, so `git show` (--cc) of the merge lists
    // README.md alone although the merged branch brought code in.
    const repo = makeRepo()
    git(repo, 'checkout', '-q', '-b', 'feature')
    commit(
      repo,
      { 'README.md': 'feature\n', 'app.ts': 'export const x = 3\n' },
      'feat(api): feature',
    )
    git(repo, 'checkout', '-q', 'main')
    commit(repo, { 'README.md': 'main\n' }, 'docs(readme): main')
    expect(() => git(repo, 'merge', '-q', 'feature')).toThrow()
    writeFileSync(join(repo, 'README.md'), 'resolved\n')
    git(repo, 'add', 'README.md')
    git(repo, 'commit', '-q', '--no-edit')
    const sha = git(repo, 'rev-parse', '--short', 'HEAD').trim()
    expect(
      git(repo, 'show', '--name-only', '--pretty=format:', sha).split(/\s+/).filter(Boolean),
    ).toEqual(['README.md'])
    expect(reminder(repo, sha)).toBe(true)
  })

  it.each(['git commit -m "feat(api): x" -- src/', 'git -C /repo commit -m "feat(api): x"'])(
    'recognises %s',
    (command) => {
      const repo = makeRepo()
      const sha = commit(repo, { 'app.ts': 'export const x = 4\n' }, 'feat(api): x')
      expect(reminder(repo, sha, command)).toBe(true)
    },
  )

  it.each([
    ['ls -la', ''],
    ['git commit-graph write', ''],
    ['git commit -m "feat(api): x"', 'nothing to commit, working tree clean'],
    ['git commit --dry-run -m "feat(api): x"', '[main 1a2b3c4] feat(api): x'],
    ["echo 'git commit is how you save work'", 'git commit is how you save work'],
  ])('stays silent when nothing landed: %s', (command, stdout) => {
    const repo = makeRepo()
    expect(runHook('post-commit-review-reminder.ts', payload(command, stdout, repo))).toBeNull()
  })
})
