# 0014 — The port matches functionality, not library-level details

**Date:** 2026-11-04
**Decision (maintainer):** it was never meant to be a literal port, only a port of the functionality;
the same applies to point 2. The answer to the list of known differences in the project's TODO
list (in git history).

Clarifies decision 0010.

## Context
After the port, about twenty differences from the Python app remained. They are details of
libraries and frameworks, not of the app: FastAPI's generated `/docs`, `/redoc` and
`/openapi.json`; error texts from undici, the AI SDK, xmldom and TextDecoder instead of httpx,
LiteLLM, lxml and CPython codecs; uvicorn and Typer output styling; faker-js data style; PDF
geometry and GIF palette from pdfkit and libvips instead of reportlab and Pillow; statements that
pg or Mastra cannot cancel.

## Consequences
- These differences are accepted and are not ported; the list moves to "Not doing".
- FastAPI's `/docs`, `/redoc` and `/openapi.json` are not added: they are FastAPI's generated API
  documentation, not a feature of the app, and the UI does not use them.
- Later work aims at the same behaviour for users of the app (API contract, answers, citations,
  CLI commands, data), not at reproducing a Python library's exact strings or byte layout.

## Rejected alternatives
- Porting each difference to match the Python libraries exactly.
