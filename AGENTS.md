# Mokosz Agent Core

Rules for every coding agent working in this repo (Claude Code, Codex, Cursor).
Read this file first, then the runtime file (`CLAUDE.md` for Claude). Before
each concrete action, load the documents its row in **Read Before The Action**
names. The product itself is specified in `SPEC.md`; this repo is its port to
TypeScript, Node.js and Mastra (decision 0010).

## Always

- **Keep the maintainer's shape.** Build what `SPEC.md`, the decisions in
  `docs/decisions/` and the approved plan say, with their exclusions. Nothing
  they do not ask for is added. v2 items are not started until v1 is done. A new
  mechanism, dependency, service or abstraction that no requirement needs is
  out of scope; if you think one is required, ask one question instead of
  adding it.
- **Decisions are final.** Maintainer decisions are recorded in `docs/decisions/`.
  Research supplies facts, never permission to reverse a decision. If a step
  needs a rejected design, stop and ask.
- **No second source of truth.** Greenfield project: when something is
  replaced, the step that adds the new path deletes the old one. No
  compatibility shims, toggles, fallbacks or "remove later".
- **Leftovers go to the maintainer, not into the code.** Anything not done, done
  wrong or undecided is listed in the report under **Leftovers for maintainer**
  (what it is, its user-visible effect, why it is not done, the cost to fix, a
  recommendation). It is fixed, or written to `docs/todo/`, only when the
  maintainer says so.
- **Tests ship with the code.** Every step that changes behaviour adds or
  updates its tests in the same step, written by whoever implements the step
  (inline or `implementer`). A separate `[test-author]` step only adds eval
  sets, fixtures or extra suites; it never replaces them. `npm test` (Vitest)
  runs against the real Postgres service, never a mocked database. LLM calls in
  tests use AI SDK mock models (`ai/test`) or recorded fixtures.
- **Never invent APIs, packages, models or paths.** Check the installed
  library version and its docs before relying on a signature (Mastra, the AI
  SDK and its providers change fast). Mastra ships its docs in
  `node_modules/@mastra/core/dist/docs/`.
- **Comments default to none.** One present-tense line only for a non-obvious
  invariant, a library gotcha or a workaround reason.
- **Inline threshold.** Typos, strings, literals, a one-file rename or a
  few-line fix inside one existing function may be done inline. Whole
  features, new modules/types/endpoints, workflow steps, schema changes and
  cross-file behaviour go to a separate implementer context. Never split a
  feature to dodge this boundary.

## Read Before The Action

| Action | Required authority |
| --- | --- |
| Edit code, config or docs; add or commit | this file; `docs/reference/commit-format.md` |
| Write or review a plan | `docs/reference/plan-writing.md` |
| Create or edit a plan, TODO or report file | `docs/reference/status-docs.md` |
| Implement a plan step or named fix | the approved plan; `SPEC.md`; `docs/decisions/` (0010 with its amendments 0011, 0013, 0014 and 0016); `docs/reference/review-checklist.md` (the classes you must not add) |
| Review a diff, commit or plan | `docs/reference/review-checklist.md`; the approved plan; `SPEC.md`; `docs/decisions/` (0010 with its amendments 0011, 0013, 0014 and 0016) |
| Write or change tests, fixtures, eval sets or eval scoring | `docs/reference/review-checklist.md` **Proof soundness** |
| Record or apply a maintainer decision | `docs/decisions/` |

## Git Safety

Never stash, restore, `checkout -- <path>`, `clean`, `reset --hard`, or
otherwise discard uncommitted changes. Read old contents with
`git show <sha>:<path>`. The only permitted resets are unstaging
(`git reset`, `git reset <paths>`) and `git reset [--soft] HEAD~1` for a commit
you made this turn. Commit your own files with a pathspec commit
(`git commit -m … -- <paths>`). Never skip hooks (`--no-verify`, `-n`).
Enforced by `.claude/hooks/git-safety.ts`.

## Commit Message Format

`<type>(<scope>): <imperative description>`, types `feat`, `fix`, `perf`,
`refactor`, `test`, `docs`, `chore`. A commit implementing a plan step ends with
`(<plan-slug> step <id>)`. Review-fix commits add the `Kind: review-fix`
trailer. Details and examples: `docs/reference/commit-format.md`. Enforced by
`.claude/hooks/commit-format.ts` (Claude hook and git `commit-msg` hook).

## Hostile Diff Review

Every above-threshold commit gets one fresh, adversarial review in a separate
context (`hostile-reviewer`), and changes to tests, fixtures or evals also get
a `proof-auditor` pass. Inline-threshold changes get no review. At most two
review rounds per task (unless the maintainer asks for another); what is left after
round 2 is a leftover for the maintainer. The post-commit hook only reminds; this
rule decides. Method: `docs/reference/review-checklist.md`.
