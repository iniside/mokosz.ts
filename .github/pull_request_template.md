## What and why

<!-- One paragraph. Link the plan step: docs/plans/<file> step N -->

## Checklist

- [ ] Scope matches the plan step, `SPEC.md` v1 and the decisions (nothing new, nothing from v2)
- [ ] Old path deleted where this replaces something
- [ ] Tests added or updated; `npm test` green against real Postgres
- [ ] `npm run lint`, `npm run typecheck` green
- [ ] UI change: `npm run lint` and `npm run build` in `web/` green; `mokosz screenshots` re-run
- [ ] Workflow, prompt or profile change: `mokosz eval` re-run, results table updated
- [ ] Hostile review: PASS (round 1 or 2), proof audit if tests or evals changed
- [ ] Leftovers listed below, or none

## Leftovers for maintainer

<!-- what · user-visible effect · why not done · cost · recommendation -->
