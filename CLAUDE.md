# Mokosz

Read `AGENTS.md` first: it holds the rules and the action table. This file only
maps those rules onto Claude Code (agents, models, artifacts, trailers).

## Plans

In plan mode, edit only the harness plan file. After the owner approves it,
copy the plan to `docs/plans/YYYY-MM-DD-HHMM-<topic>-plan.md` (UTC from
`date -u "+%Y-%m-%d-%H%M"`) and commit it on its own before any code.

## Dispatch lanes

Every `Agent` call passes an explicit `model:` (enforced by a hook).

| Tag in a plan step | Agent | Model |
| --- | --- | --- |
| `[inline]` | main session | session model |
| `[opus]` | `implementer` | `opus`: new workflow steps, API contracts, schema, concurrency |
| `[sonnet]` | `implementer` | `sonnet`: renames, boilerplate, wiring with a written contract |
| `[test-author]` | `test-author` | `sonnet`; `opus` for a new harness or eval design. Eval sets, fixtures and extra suites only; the implementer always writes the tests for its own step |
| `[review]` | `hostile-reviewer` | at least the author's tier |
| proof audit | `proof-auditor` | at least the author's tier |
| read-only research | `Explore` | `sonnet`; `haiku` for pure listing |

Consecutive steps in the same area may resume the same implementer with
`SendMessage`. Reviews are always fresh agents, never resumed.

## Commit trailer

```text
Co-Authored-By: Claude <Family> <Version> <noreply@anthropic.com>
```

Fill it from the executing model's own identity, never from an example.

## Hooks (`.claude/settings.json`)

Every hook is a TypeScript file in `.claude/hooks/`, run through
`.claude/hooks/run.sh`, which starts it with Node (Node ≥ 24 strips the types;
no build step, no dependencies). Without a working `node` on PATH, `run.sh`
exits 2, so the guarded tool calls are blocked rather than run unguarded.
Their tests are in `tests/hooks/`.

- `git-safety.ts`: blocks destructive git commands, `--no-verify`, a missing
  `Co-Authored-By` trailer and a malformed commit subject. Known limit: a reset
  to a branch or remote ref (`git reset origin/main`) looks like a path reset
  and is not caught.
- `post-commit-review-reminder.ts`: after a code commit, a non-blocking
  reminder that an above-threshold commit needs `hostile-reviewer` (within the
  two-round cap). Prose-only commits get no reminder.
- `agent-model-guard.ts`: denies an `Agent` call without an explicit model.
- `plan-checklist.ts`: adds the plan checklist when leaving plan mode.

The git side of the commit rule lives in `.githooks/commit-msg`; enable it once
per clone with `git config core.hooksPath .githooks` (`mokosz setup` does this).
