# 0016 — Idiomatic TypeScript, no emulation of Python's APIs

**Date:** 2026-11-05
**Decision (owner):** this was meant to be a port from Python to idiomatic TypeScript, not an
imitation of its API; and 1500 lines is not that much, so we will certainly do it.

Extends decision 0014 from the list of known differences to the code and its tests.

## Context
The port kept a layer that reproduces Python and its libraries in TypeScript: `src/python.ts`
(`repr`, `str.strip`, `int()`, `round()`, float repr, `Fraction`, a JSON parser returning `Map`
and `bigint`), `src/llm/pydantic.ts` (pydantic's lax coercion and error shape),
`src/api/validation.ts` (FastAPI and pydantic validation messages, Starlette header semantics),
Click/Typer error texts in `src/cli.ts`, Python's `decimal` context and signals in
`src/decimal.ts`, and python-dotenv in `src/dotenv.ts`. Golden fixtures generated from the Python
app (`tests/fixtures/python-*.json`, `tests/fixtures/generate/*.py`) pin this layer byte for byte.

## Consequences
- What stays is the behaviour a user of the app sees: API routes and JSON shapes (including the
  `detail` field of an error response), CLI commands and options, answers, citations, data.
- The Python emulation layer is removed and replaced with plain TypeScript, zod, commander and
  Node built-ins. Error texts become the app's own or the library's.
- `src/decimal.ts` stays only as far as decision 0013 needs exact money arithmetic, without
  Python's context or signals.
- The Python-generated golden fixtures and their generators are deleted; tests state the expected
  behaviour from `SPEC.md` directly.

## Rejected alternatives
- Keeping the emulation because it already works and is tested.
