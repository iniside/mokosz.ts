# 0015 — A minimal Q&A eval, beyond the Python app

**Date:** 2026-11-04
**Decision (owner):** OK, do it; approving the minimal variant, proposed after the owner said
that this is a demo project for a CV, not an app for users, and that they cannot afford a lawyer
to check it.

Adds to decisions 0010 and 0014: the Python app never implemented SPEC §6, so this is new
functionality, approved by the owner.

## Context
The port proves the TypeScript app behaves like the Python one, not that either answers well.
SPEC §6 describes a Q&A eval set and `mokosz eval`; neither exists in the Python app. A legal
review of the expected answers is out of reach.

## Consequences
- A Q&A eval set of about 30 EN/PL items (about 5 unanswerable) in `evals/qa/`, written by a model
  from the regulation texts. Every expected citation carries a quote that a test checks is in the
  cited chunk's text; no lawyer reviews it.
- `mokosz eval --profile <name> --set qa [--repeat N]`: citation precision and recall,
  `not_found` accuracy, latency after a warm-up call, results as files in `evals/results/`.
- The README shows the result table and says how the set was made and that it was not reviewed by
  a lawyer.
- Not in this decision: the LLM judge, the invoice set, the cloud profile row.

## Rejected alternatives
- A lawyer-reviewed set.
- The full SPEC §6 (judge, invoices, variance) now.
- No eval.
