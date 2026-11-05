# 0009 — Invoices enter only through the upload; `mokosz seed` does not load them

**Date:** 2026-11-03
**Decision (maintainer):** no, upload only; the answer to whether `mokosz seed` should load invoices.

## Context
SPEC § 9 said `mokosz seed` "loads chunks, embeddings and invoices", while SPEC § 3 says
invoices enter only through the upload in the UI (`POST /api/invoices`). Seeding invoices would
also need a running model for every one of the 150 generated invoices.

## Consequences
- `mokosz seed` loads chunks and embeddings only (SPEC § 9 corrected).
- The generated set in `data/invoices/` is used through the upload: the UI, the step 4 live
  check and the SPEC step 6 eval.

## Rejected alternatives
- Seeding invoices by running extraction on the generated set during `mokosz seed`.
