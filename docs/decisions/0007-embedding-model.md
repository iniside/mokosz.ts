# 0007 — Embedding model: bge-m3

**Date:** 2026-11-03
**Decision (owner):** pick the more accurate one; a difference of a few minutes in run time
does not really matter. Applied to the measurement below: `bge-m3`.

## Context
SPEC § 2 picks the embedder by retrieval recall@5 on 20 EN/PL test queries
(`evals/retrieval/queries.json`). Both candidates run in Ollama through LiteLLM with
`num_ctx` 4096 and truncation disabled. Recall is computed by `mokosz.retrieval.recall_at_k`
from the committed float16 files: cosine similarity, the query's language only, no act or
article filter, ties broken by row order, mean of |expected ∩ top 5| / |expected|.

Measured on the RTX 4090 on 2026-11-03 (4,048 chunks, EN and PL, plus 20 queries):

| Model | recall@5 overall | EN | PL | Wall time |
|---|---|---|---|---|
| `qwen3-embedding:0.6b` | 0.650 (13/20) | 0.700 | 0.600 | 71 s |
| `bge-m3` | **0.825** (33/40) | **0.850** | **0.800** | 89 s |

`bge-m3` finds the expected chunk where `qwen3-embedding:0.6b` misses on four queries
(personal-data definition, NIS2 transposition date, AI literacy of staff, NIS2 significant
incident criteria) and is worse on one (NIS2 early warning, 0/2 against 1/2). Both miss the
NIS2 encryption and MFA query. A second `bge-m3` run reproduced the files byte for byte.

`qwen3-embedding:0.6b` was run with the query prefix from its model card
(`Instruct: {task}\nQuery:{query}`, the `get_detailed_instruct` form; the card's TEI example
puts a space after `Query:`).

## Consequences
- `EMBEDDING_MODEL = "bge-m3"`, `EMBEDDING_DIM = 1024` in `mokosz.retrieval`; `mokosz embed`
  defaults to it.
- Only `data/embeddings/bge-m3/` is committed; seeding and CI use it, and no model runs in CI.
- The chat retriever (SPEC step 3) embeds the user's query with `bge-m3` at run time, with no
  prefix.

## Rejected alternatives
- `qwen3-embedding:0.6b`: lower recall@5 overall, in EN and in PL; its speed advantage was
  not a criterion (owner).
