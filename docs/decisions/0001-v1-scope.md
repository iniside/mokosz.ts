# 0001 — Keep v1 small; no cloud infrastructure in v1

**Date:** 2026-11-02
**Decision (owner):** no overscoping. v1 stays small, and cloud infrastructure (Azure) is out of v1.

## Context
The goal is a complete, working system that shows production practice end to
end: an API, an agent graph with persistence and human review, retrieval with
verifiable citations, evals, observability and a UI. Each extra platform or
provider adds setup and maintenance without making that core more convincing.

## Consequences
- v1 is the list in `SPEC.md` § v1; nothing from v2 starts before v1 is done.
- Azure deploy (Container Apps, Postgres Flexible Server, Functions, IaC) is a
  v2 item, together with Azure OpenAI.

## Rejected alternatives
- A cloud deploy in v1.
- Three LLM providers, an MCP client, time-travel UI and Terraform in v1.
