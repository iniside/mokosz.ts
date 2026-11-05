# 0010 — Port to TypeScript, Node.js and Mastra, without reinterpretation

**Date:** 2026-11-03
**Decision (maintainer):**
- we need a port of the same application, but in TypeScript, Node.js and Mastra instead; no
  reinterpretation and no new functionality, only a port of the workflow and the functionality
  implemented there;
- on the proposed Mastra mapping: tell me what it looks like idiomatically in Mastra, and we may
  do it that way (answered with the consequences below);
- perhaps first copy the development workflow and adapt it to the type of project.

## Context
The reference was the author's earlier Python implementation as of 2026-11-03: the Q&A flow
is complete end to end (graph, API, SSE, chat UI); invoices are done up to step 3 of the invoices
plan (schema, validator, tax ids, generator, `invoices` table and its store), with no extraction
graph, invoice endpoints or approval screen. `SPEC.md` (copied unchanged) and decisions 0001–0009
still bind; where they name a Python technology, the mapping below applies.

## Consequences
- **Scope:** only what the Python code does. Unimplemented `SPEC.md` items (extraction graph,
  invoice API and screen, Langfuse, `/api/graphs`, run list and detail, `mokosz eval`) are not
  ported; they follow the same order of work later, in Mastra form.
- **Q&A graph → Mastra workflow:** `router → retriever → dountil(answerer → verifier, passed or
  2 iterations) → finish`; `router` and `answerer` are Mastra Agents with `structuredOutput`
  (Zod) and prompts from `src/prompts/*.md`; the model comes from the profile through the request
  context; the workflow sets `autoRestartActiveRuns: false`, so interrupted runs end `failed` as
  before.
- **Conversation memory:** Mastra Memory, one thread per conversation (replaces the
  `conversations` table and the LangGraph checkpointer); the router reads the last 10 messages;
  the question and the verified reply are saved at the end of the run; the previous `filters`
  live in the thread metadata. Workflow state is in `PostgresStore` (`@mastra/pg`), same database.
- **Runs and events:** own `runs` and `run_events` tables (seq replay, one running run per
  conversation, totals) fed by the executor from `run.stream()`; `runs.id` is the Mastra run id.
- **Retrieval:** the `chunks` table and the two SQL queries of `search.py`, unchanged, through
  `pg`; query embedding with the AI SDK `embed()` and `ollama-ai-provider-v2` (`bge-m3`).
- **Models:** AI SDK providers (`ollama-ai-provider-v2` for local, `@ai-sdk/anthropic` for cloud);
  profiles stay YAML with the same keys; cloud cost from a price table for the `cloud-claude`
  models, local cost 0.
- **API:** routes on the Mastra server (`registerApiRoute`, Hono) at the same `/api/...` paths and
  port 8000, with the same response shapes, `{detail}` errors and SSE format, so `web/` is reused
  unchanged.
- **Invoices:** Zod schemas, the validator with `decimal.js` (half-up), tax ids, the `invoices`
  table and store; the generator is ported with seeded `@faker-js/faker` and `pdfkit`, and the TS
  generator regenerates `data/invoices/` (two runs byte-identical); the Python set is not
  reproduced.
- **Tooling:** migrations as SQL files, CLI with `commander` (same commands), screenshots with
  Playwright for Node, tests with Vitest on real Postgres and AI SDK mock models; data files,
  profiles, prompts, eval queries and `web/` are copied unchanged.
- **Development workflow:** `AGENTS.md`, `CLAUDE.md`, the agents, `docs/reference/`, the PR
  template and CI are carried over and adapted; the Claude Code hooks and the git `commit-msg`
  hook are rewritten in TypeScript and run by Node, so the repo needs no Python.

## Rejected alternatives
- Mastra `PgVector` for retrieval: no guaranteed `ORDER BY distance, id` tie order and no lookup
  by citation key for the citation endpoint.
- Keeping the Python invoice set byte for byte: Faker JS and reportlab cannot reproduce it.
- Mastra's default boot-time restart of active runs: the Python app marks them `failed`.
