# 0012 — Mutation testing with StrykerJS, at the end of the port

**Date:** 2026-11-04
**Decision (owner):** you can add it, but somewhere at the end; for now we want what is being
built to work.

Adds to decision 0010; the Python app had no mutation-testing tool.

## Context
Reviews check claimed proofs with hand-made, targeted mutants (`proof-auditor`). The owner asked
why no ready-made tool is used. StrykerJS with its Vitest runner is the TypeScript one. It does
not replace the targeted mutants: it measures generic mutants, it cannot activate mutants inside
child processes (the hooks tests), and the Postgres suites make every mutant slow.

## Consequences
- A last plan step (19) adds StrykerJS for the pure in-process modules, as a non-gating CI job
  and an npm script.
- Until then, nothing changes; `proof-auditor` keeps its targeted mutants.

## Rejected alternatives
- StrykerJS now, before the port works.
- StrykerJS as a CI gate or over the whole test suite.
