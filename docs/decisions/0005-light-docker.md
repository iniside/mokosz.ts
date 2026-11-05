# 0005 — Docker only where it pays; Langfuse Cloud by default

**Date:** 2026-11-02
**Decision (maintainer):** keep Docker, but light: in daily work it runs only the database; Langfuse defaults to the cloud.

## Context
The maintainer prefers not to work inside containers. Docker still earns its place:
pgvector on native Windows needs a Visual Studio build, reviewers expect
`docker compose up`, and CI uses a Postgres service container. Self-hosted
Langfuse v3 is a six-service stack.

## Consequences
- Dev: `docker compose up db`; API, UI and Ollama run natively.
- Full: `docker compose up` runs db, API and UI; Ollama stays on the host.
- Langfuse Cloud (free tier) by default; the app runs without Langfuse keys.
- Self-hosted Langfuse is only documented in the README (link to the official
  compose), not shipped in this repo's compose (maintainer approved, 2026-11-02).
- Setup goes through one cross-platform command, `mokosz setup`, which checks
  Docker and Ollama, pulls models and seeds the database, acting as the
  installer that downloads the dependencies.

## Rejected alternatives
- Everything in containers, including Langfuse, in the default stack.
- No Docker at all (Postgres in WSL only): the compose file would never be
  tested by the maintainer before others run it.
