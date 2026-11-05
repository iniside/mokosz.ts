# 0011 — Amendments to the port mapping (formatter, HTTP server, step events, question timing)

**Date:** 2026-11-04
**Decision (owner):** answers to the four questions of the port plan (in git history), each the
recommended option:
- formatter: oxfmt plus `.oxlintrc`;
- HTTP server: plain Hono, only our routes;
- step events: a step wrapper, as in Python;
- question timing: at the start, as in Python.

Amends decision 0010 where the two disagree.

## Context
The plan review found that the decision 0010 mapping would either add behaviour the Python app
does not have or lose behaviour it has:
- the Python CI had a formatter gate (`ruff format --check`) and ruff rules beyond the defaults;
- the Mastra server registers all its built-in routes (workflow start, Memory threads, agents),
  a second public way to run a turn with no `runs` row and no events;
- Mastra enqueues workflow stream events without backpressure, so an executor reading
  `run.stream()` sees a step start after the step has already called the model;
- Python adds the question to the conversation at the start of the turn, and a test pins that a
  turn failing mid-graph keeps the question without a reply.

## Consequences
- **Formatter and lint:** `oxfmt` with a format check in CI and in every implementer's gates;
  `.oxlintrc.json` enabling the correctness, suspicious and import categories and async rules
  (the role of ruff `E,F,I,UP,B,ASYNC,SIM`).
- **HTTP server:** a plain Hono app served by `@hono/node-server` with only the Python app's
  routes at the same `/api/...` paths; Mastra runs in-process (agents, workflow, Memory,
  storage). No Mastra built-in routes, so `registerApiRoute` and the `apiPrefix` move of 0010 do
  not apply.
- **Step events:** every workflow step runs inside a wrapper ported from `wrapper.py`, which
  adds the step to the path, emits `step_started`, and on success emits `step_finished` with
  that step's own tokens, model and latency. The executor drives the run and writes the terminal
  event; it does not derive step events from `run.stream()`.
- **Question timing:** the question is saved to the Memory thread before the workflow starts; the
  verifier saves the reply. A turn that fails mid-way leaves the question without a reply, as in
  Python.

## Rejected alternatives
- Prettier; no formatter gate.
- The Mastra server with built-in routes under `/mastra/api`.
- Step events mapped from `run.stream()` in the executor.
- Saving the question and the reply together at the end of the run.
