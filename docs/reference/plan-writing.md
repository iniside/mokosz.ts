# Plan Writing

Every plan, however small, follows these steps in order.

## 0. Keep the owner's shape

Open the plan's **Context** with the requested outcome and the explicit
exclusions, in the owner's words. For every new module, service, dependency,
storage, abstraction or public contract the request does not name, state which
requirement cannot be met without it. If none, it is out of scope. If you
believe it is needed anyway, ask one blocking question.

## 1. Map what exists

For anything new, list the existing code that overlaps with it and say why it
cannot be extended.

## 2. Close only the questions that matter

Before approval, answer only questions that could change scope, architecture,
data contracts or feasibility (for example: which Mastra or AI SDK API
exists in the pinned version, or what the current code actually does). Record
other uncertainty for the implementer.

## 3. Write an ordered sequence of steps, not a catalogue

Steps are numbered `1, 2, 3…` (a split renumbers; no `2a`). Each step states:

- **(a) what** is touched: files, symbols, endpoints, tables;
- **(b) why now**: the dependency that puts it before the next step;
- **(c) how**: the contract and behaviour, including what dies (the old path
  removed in this step), without prescribing private details;
- **(d) validation**: the tests this step adds (always in this step, by its
  implementer) and the gates that must be green;
- **(e) lane**: `[inline]`, `[opus]`, `[sonnet]` or `[test-author]`
  (mapped to agents and models in `CLAUDE.md`).

A step that encodes a formula or rule (VAT, a tax id checksum, a metric) carries a
small case table: inputs → expected value. Cases the spec does not decide are
owner questions before approval.

## 4. Hostile review before the owner sees it

Dispatch `hostile-reviewer` on the plan. It checks scope against the request
first, then gaps, ambiguity and rule conflicts, and returns a punch list.
Address it, or note deferred items with a reason, before showing the plan.

## 5. After approval

Copy the plan to `docs/plans/YYYY-MM-DD-HHMM-<topic>-plan.md` and commit it on
its own. The plan slug (`<topic>`) is what commit subjects reference.
