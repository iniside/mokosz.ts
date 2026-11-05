# 0006 — Vector search only in v1; full-text search later

**Date:** 2026-11-02
**Decision (owner):** no full-text search for now.

## Context
The owner's earlier semantic code search (arcsem, over a large C++ repo) was
dropped because full-text search usually worked better there and full indexing
took very long. This corpus is far smaller: 1,567 EN paragraphs and recitals
embed in 36 s (`qwen3-embedding:0.6b`) or 67 s (`bge-m3`) on the RTX 4090, so
EN+PL takes about 1 to 2 minutes, once.

## Consequences
- v1 retrieval is pgvector similarity with metadata filters (language, act,
  article number extracted by the router).
- Article-number queries ("art. 14 AI Act") are served by the `article = N`
  filter, not by full-text matching.
- Full-text and hybrid search, and their comparison in evals, move to v2.

## Rejected alternatives
- Hybrid search (pgvector + `tsvector` + RRF) in v1.
