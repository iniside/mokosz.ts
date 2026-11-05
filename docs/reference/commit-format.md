# Commit Message Format

`<type>(<scope>): <imperative description>`

- `type`: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `chore`.
- `scope`: lowercase area, comma-separated when several, no brackets:
  `api`, `workflow`, `retrieval`, `ingest`, `extraction`, `evals`, `web`, `ci`,
  `infra`, `db`, `llm`, `runs`, `invoices`, `citations`, `cli`, `agents`
  (workflow and rules), `docs`.
- A commit implementing a plan step ends with `(<plan-slug> step <id>)`, or
  `(<plan-slug> steps <a>-<b>)` for a range. `<plan-slug>` is the plan file name
  without the `YYYY-MM-DD-HHMM-` prefix and `-plan.md`
  (`2026-11-03-0900-qa-graph-plan.md` → `qa-graph`).
- Review-fix commits keep the step suffix and add `Kind: review-fix` in the
  final trailer paragraph, next to `Co-Authored-By` (no blank line between).

```text
feat(ingest): parse Cellar XHTML into paragraph chunks (regulations-ingest step 2)
fix(workflow): keep citations from retried answers (qa-graph step 3)

Kind: review-fix
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

Rejected: `update stuff`, `feat: add api` (no scope), `feat(api): ... (step 3)`
(no slug), `feat(api): ... (qa-graph steps 3, 4)` (a list, not a range).

## Enforcement

`.claude/hooks/commit-format.ts` is the single source of the rule:

- in Claude Code, `git-safety.ts` checks the subject of every `git commit`
  and requires a `Co-Authored-By` trailer;
- for every other committer, the git `commit-msg` hook checks the subject and
  the `Kind:` trailer. It lives in `.githooks/commit-msg` (executable, runs it with
  `node`); enable it once per clone with
  `git config core.hooksPath .githooks` (`mokosz setup` does this).

Exempt subjects: `Merge `, `Revert "`, `fixup! `, `squash! `, `amend! `.
