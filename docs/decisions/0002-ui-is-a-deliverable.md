# 0002 — The UI is a first-class deliverable

**Date:** 2026-11-02
**Decision (maintainer):** the project needs a real UI, so that anyone opening the repository sees the system working in the README images.

## Context
An earlier proposal treated the frontend as secondary to the backend. The
maintainer overruled it: the README images are the first impression of the project.

## Consequences
- `SPEC.md` § 8: the chat screen is the hero screen; the approval queue and run
  detail follow; every screen must look finished on real data.
- The UI is built together with each feature (`SPEC.md` Order of work), so the
  README has an image from step 3 onwards.
- README images come only from `mokosz screenshots` (Playwright) on real usage
  data: the maintainer's own chat usage and uploads of the generated invoices
  (`SPEC.md` § 8).

## Rejected alternatives
- A UI built last, or reduced to a debug page.
