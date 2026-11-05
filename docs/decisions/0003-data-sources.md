# 0003 — Data sources: Cellar for regulations, generated invoices

**Date:** 2026-11-02
**Decision (maintainer):** regulations come from Cellar; invoices are generated; approved as `SPEC.md` § 1 Data.

## Context
Checked on 2026-11-02: the EUR-Lex website answers automated requests with
`202` and an empty body. Cellar (`http://publications.europa.eu/resource/celex/{CELEX}`,
`Accept: application/xhtml+xml`, `Accept-Language: eng|pol`) returns the full
XHTML with stable ids (`art_N`, `NNN.NNN` paragraphs, `rct_N`, annexes `anx_I`…), and the
Polish AI Act has the same 113 articles and 509 paragraph ids as the English one.

## Consequences
- GDPR (32016R0679), AI Act (32024R1689), NIS2 (32022L2555), EN and PL, are
  fetched once and committed under `data/raw/`.
- Citation key = `{celex}#{element_id}` (element ids repeat across acts);
  chunking rules for articles without paragraph ids are in `SPEC.md` § 1.
  Citation scoring compares keys.
- Invoices are generated from JSON (the JSON is the ground truth): 150, of which
  50 are defective, 10 per defect class (maintainer, 2026-11-02). No real or
  third-party invoice datasets in the repo; the maintainer's own invoices may only
  be used as a private, gitignored local eval set.

## Rejected alternatives
- Scraping the EUR-Lex website (blocked).
- Public receipt/invoice datasets (unclear licences, ground truth does not
  match our schema).
- Contracts in v1.
