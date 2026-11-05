# 0008 — Annex section headings and dash lists are not separate chunks

**Date:** 2026-11-03
**Decision (owner):** agreed, we can do it this way; searching by headings most likely fits
full-text search better than semantic search anyway.

## Context
SPEC § 1 rule 4 made one chunk per top-level annex block. In the AI Act that produced 17 EN
chunks of five words or fewer (0.8 % of 2,024), of two kinds:
- section headings with no content (`oj-ti-grseq-1`): `anx_VII.p_1` "1. Introduction",
  `anx_X.p_1` "1. Schengen Information System", `anx_XI.p_1` "Section 1". The block under a
  heading then lacked the heading words (the SIS chunk did not say "Schengen Information
  System");
- Annex II, the list of criminal offences for real-time remote biometric identification,
  split into one chunk per offence ("— terrorism,", "— rape,"), so no single chunk answers
  "for which offences?" and a top-5 search sees only a few of them.

## Consequences
- Rule 4 gains two structural rules (SPEC § 1): a heading block joins the block after it,
  and top-level "—" items join the block before them. Both depend on markup, not length, so
  EN and PL keys stay identical.
- The `anx_*` keys of the affected AI Act annexes are renumbered; embeddings are recomputed
  and reseeded. Nothing outside these annexes changes.
- Searching for a heading by its exact words is a full-text concern (v2, decision 0006).

## Rejected alternatives
- Keeping rule 4 as it was.
- A minimum chunk length: it would split EN and PL differently (rule 5).
