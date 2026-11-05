# 0013 — One decimal type: `src/decimal.ts` replaces decimal.js

**Date:** 2026-11-04
**Decision (owner):** one `src/decimal.ts` (the recommended option), the answer to: keep one decimal
implementation, the bigint `Decimal` of `src/decimal.ts`, everywhere, and drop decimal.js.

Amends decision 0010 ("the validator with `decimal.js` (half-up)") and plan step 14(c) ("a parsed
value carries the `decimal.js` number for arithmetic").

## Context
Port step 14 found that decimal.js normalises the scale of computed values
(`new Decimal('2').times('100.00')` is `"200"`), while Python's `decimal.Decimal` keeps it
(`"200.00"`). The validator's failure messages print computed values, so decimal.js cannot
reproduce them. The step added `src/decimal.ts`, a bigint `Decimal` that matches Python's
`decimal.Decimal` under the default context (fuzzed against the reference with no mismatch). That
left two decimal types in the tree: decimal.js (`PyDecimal`) for LLM costs and run totals, and
`src/decimal.ts` for invoices. Python has one `decimal.Decimal` for both.

## Consequences
- `src/decimal.ts` is the only decimal type. LLM prices, the recorder, the run store and their tests
  move to it; `PyDecimal` and the `decimal.js` dependency are removed.
- Every Decimal value keeps Python's scale and `str()` form, for costs as well as invoices.

## Rejected alternatives
- Keep decimal.js as the plan said and accept validator messages that differ from Python.
- Keep both types.
