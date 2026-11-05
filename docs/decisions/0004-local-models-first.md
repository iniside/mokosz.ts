# 0004 — Local models first; Claude optional; OpenAI later

**Date:** 2026-11-02
**Decision (maintainer):**
- use small local models (Qwen, Gemma) in v1;
- there is no API key, so v1 must run fully locally, with the cloud API optional;
- the eval judge is a third local model;
- OpenAI is optional and moves to v2 or later.

## Context
The development machine has an RTX 4090 (24 GB VRAM) and 128 GB RAM. A smoke
test on 2026-11-02 showed `gemma4:e4b`, `qwen3.6:27b` and `gemma4:26b` all
returning valid schema JSON for a sample invoice (4 to 6 s warm) and answering
in Polish with the citation format. Local models also make the case for
regulated industries: without Langfuse Cloud keys, nothing leaves the host.

## Consequences
- Profiles `local-qwen` and `local-gemma` are the v1 defaults; `cloud-claude`
  is optional and needs `ANTHROPIC_API_KEY`.
- Embeddings are served by Ollama too (`qwen3-embedding:0.6b` or `bge-m3`,
  chosen in step 2 by retrieval recall).
- Eval judge: `mistral-small3.2:24b`, local, from a different family than the
  judged models.
- CI uses LiteLLM `mock_response` and committed embeddings; no model runs in CI.

## Rejected alternatives
- OpenAI in v1.
- Claude as a required provider or as the judge.
- A small judge model (it would be weaker than the models it grades).
