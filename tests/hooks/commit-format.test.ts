import { spawnSync } from 'node:child_process'
import { symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PLANS_DIR,
  checkMessage,
  checkSubject,
  splitLines,
} from '../../.claude/hooks/commit-format.ts'
import { HOOKS, makePlansDir, tempDir } from './util.ts'

const TRAILER = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'

describe('commit subject', () => {
  it.each([
    'feat(api): add health endpoint',
    'fix(workflow,retrieval): keep act filter on retry',
    'feat(workflow): add verifier (qa-graph step 3)',
    'feat(workflow): add router and retriever (qa-graph steps 1-2)',
    "Merge branch 'main' into x",
    'Revert "feat(api): add health endpoint"',
  ])('accepts %s', (subject) => {
    expect(checkSubject(subject, makePlansDir())).toBeNull()
  })

  it.each([
    'update stuff',
    'feat: add api',
    'feat(API): uppercase scope',
    'feat([api]): bracket scope',
    'feat(workflow): add verifier (step 3)',
    'feat(workflow): add verifier (qa-graph step 2a)',
    'feat(workflow): add verifier (qa-graph steps 3, 4)',
    'feat(workflow): add verifier (unknown-plan step 3)',
    'feat(workflow): add verifier (qa-graph step 3); and more',
  ])('rejects %s', (subject) => {
    expect(checkSubject(subject, makePlansDir())).not.toBeNull()
  })

  it('strips the whitespace String.prototype.trim strips', () => {
    expect(checkSubject('﻿feat(api): x \t', makePlansDir())).toBeNull()
    expect(checkSubject('\x1ffeat(api): x\x85', makePlansDir())).not.toBeNull()
  })

  it('suggests the closest plan slug', () => {
    expect(checkSubject('feat(api): x (qa-grap step 1)', makePlansDir())).toContain(
      'Closest plan slugs: qa-graph.',
    )
  })

  it('does not crash on a missing plans dir', () => {
    expect(
      checkSubject('feat(api): x (qa-graph step 1)', join(tempDir(), 'missing')),
    ).not.toBeNull()
  })
})

it('splits lines on CRLF, CR, LF, VT, FF, the information separators, NEL, LS and PS', () => {
  expect(splitLines('steps 2028-2029\u2028b\r\nc\rd\x85e\n')).toEqual([
    'steps 2028-2029',
    'b',
    'c',
    'd',
    'e',
  ])
  expect(splitLines('a\vb\fc\x1cd\x1de\x1ef\u2029g')).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
})

it('reads plans from the repository docs/plans by default', () => {
  expect(PLANS_DIR).toBe(resolve(import.meta.dirname, '..', '..', 'docs', 'plans'))
})

describe('commit message trailers', () => {
  it('accepts Kind: review-fix in the final paragraph', () => {
    const message = `fix(workflow): keep citations (qa-graph step 3)\n\nKind: review-fix\n${TRAILER}\n`
    expect(checkMessage(message, makePlansDir())).toBeNull()
  })

  it.each([
    `fix(workflow): keep citations (qa-graph step 3)\n\nKind: review-fix\n\n${TRAILER}\n`,
    `fix(workflow): keep citations (qa-graph step 3)\n\nKind: hotfix\n${TRAILER}\n`,
    `fix(workflow): keep citations (qa-graph step 3)\n\nKind: review-fix\nKind: review-fix\n${TRAILER}\n`,
  ])('rejects a bad Kind trailer: %j', (message) => {
    expect(checkMessage(message, makePlansDir())).not.toBeNull()
  })
})

function cli(message: string): { status: number | null; stderr: string } {
  const file = join(tempDir(), 'MSG')
  writeFileSync(file, message)
  return spawnSync(process.execPath, [join(HOOKS, 'commit-format.ts'), file], { encoding: 'utf8' })
}

it('the CLI exits 1 on a bad subject', () => {
  const proc = cli('update stuff\n')
  expect(proc.status).toBe(1)
  expect(proc.stderr).toContain('Bad commit subject')
})

it('the CLI checks trailers, not only the subject', () => {
  expect(cli(`feat(api): add health endpoint\n\nKind: review-fix\n${TRAILER}\n`).status).toBe(0)
  const proc = cli(`feat(api): add health endpoint\n\nKind: hotfix\n${TRAILER}\n`)
  expect(proc.status).toBe(1)
  expect(proc.stderr).toContain('Unknown `Kind: hotfix`')
})

it('reads a tab or NBSP in the subject as whitespace', () => {
  const NBSP = String.fromCharCode(0xa0)
  expect(checkSubject(`feat(api): x (qa-graph step 1)${NBSP}`, makePlansDir())).toBeNull()
  expect(checkSubject('feat(api): x (qa-graph step 1)\t', makePlansDir())).toBeNull()
  expect(checkSubject(`feat(api): ${NBSP}x`, makePlansDir())).not.toBeNull()
  expect(checkSubject('feat(api):\tx', makePlansDir())).not.toBeNull()
})

it('the CLI runs when reached through a junction or symlink', () => {
  const link = join(tempDir(), 'hooks-link')
  symlinkSync(HOOKS, link, 'junction')
  const file = join(tempDir(), 'MSG')
  writeFileSync(file, 'update stuff\n')
  const proc = spawnSync(process.execPath, [join(link, 'commit-format.ts'), file], {
    encoding: 'utf8',
  })
  expect(proc.status).toBe(1)
  expect(proc.stderr).toContain('Bad commit subject')
})
