# Plans, TODOs, Reports and Decisions

## Where documents live

| Type | Path | Name |
| --- | --- | --- |
| Plans | `docs/plans/` | `YYYY-MM-DD-HHMM-<topic>-plan.md` |
| Reports (status, review, fix) | `docs/reports/` | `YYYY-MM-DD-HHMM-<topic>-<status\|review\|fix>.md` |
| Maintainer decisions | `docs/decisions/` | `NNNN-<topic>.md` |
| References (how we work) | `docs/reference/` | `<topic>.md` |
| TODO lists | `docs/todo/` | `<topic>.md` + `<topic>-done.md` |

Times are UTC from `date -u "+%Y-%m-%d-%H%M"`.

## Plans

When a plan is finished, add `Status: done` under its title. While it waits for
the maintainer, the line is `Status: waiting for approval`.

## Decisions

One file per decision: **Decision** (what the maintainer said, in a faithful English
paraphrase), **Date**, **Context**, **Consequences**, **Rejected alternatives**.
Only what the maintainer actually said is recorded as decided; proposals stay in
plans until confirmed. A decision is superseded only by a newer decision file
that names it.

## TODO lists

Every topic is a pair: `<topic>.md` (open) and `<topic>-done.md` (closed). Both
start with a `Last updated: YYYY-MM-DD` line, changed on every edit.

The open file has exactly these sections, in this order:
`## In progress`, `## Open` (may hold `###` area subsections, with postponed
work in a last `### Deferred`), `## Notes` (background, decisions, non-goals
under `### Not doing`; never a task). Empty sections hold `_None._`.

Each task is `- [ ] **Short title**` with detail indented under it. The done
file lists `- [x] **Short title** (YYYY-MM-DD, <ref>)`, newest first, where
`<ref>` is `<plan-slug> step N`, a commit sha, or `no ref`.

A TODO item is a real gap or bug. Session notes (a test not run, a server not
restarted) are never items; they go in the report. Items are added only when
the maintainer says so. A commit that closes an item moves it to the done file in
the same commit.
