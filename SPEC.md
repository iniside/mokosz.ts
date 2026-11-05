# Mokosz: agent harness with audit trail

License: EUPL-1.2. Language: TypeScript on Node.js 24, for the server, the CLI and the UI.

## One-sentence pitch
A small, production-shaped agent harness that runs fully on local models: a Mastra workflow answers questions about EU regulations with exact, verified citations, and every run is stored with its steps, tokens, cost and latency. Invoice extraction with human review is the second half of v1; its data, validator and storage exist, its workflow, API and screen do not yet.

## Goal and scope rule
A small reference implementation of production AI engineering for regulated domains.
**v1 is the whole job.** Do not start anything from "v2" until every v1 item is done, tested and in the README.
Prefer fewer features done well over many features half-done. Maintainer decisions are in `docs/decisions/` and are binding.

This code base is a TypeScript and Mastra port of the author's earlier Python implementation (decision 0010). It keeps the same routes, JSON shapes, commands and data, with the deliberate changes recorded in decision 0016 and listed in §4.

## Stack

| Concern | Used |
| --- | --- |
| Runtime and language | Node.js 24, TypeScript (run directly by Node, no build step for the server) |
| Q&A flow | Mastra workflow, Mastra Agents with structured output (zod), Mastra Memory |
| Models | AI SDK with `ollama-ai-provider-v2` (local) and `@ai-sdk/anthropic` (cloud) |
| HTTP API | Hono, served by `@hono/node-server` |
| Database | PostgreSQL + pgvector through `pg`; Mastra's `PostgresStore` (`@mastra/pg`) for workflow and Memory state |
| Migrations | `node-pg-migrate`, plain SQL files in `src/db/migrations/` |
| Invoice set | `@faker-js/faker` (seeded) and `pdfkit` |
| CLI | `commander` |
| UI | React, Vite, Tailwind, shadcn/ui (`web/`) |
| Screenshots | Playwright and `sharp` |
| Tests and quality | Vitest, oxlint, oxfmt, `tsc`; StrykerJS for mutation testing (decision 0012) |

---

## v1

### 1. Data

#### Regulations: Cellar (EU Publications Office), not the EUR-Lex website
The EUR-Lex website blocks automated clients (returns `202` with an empty body). Cellar serves the same text without a key:

```
GET https://publications.europa.eu/resource/celex/{CELEX}
Accept: application/xhtml+xml
Accept-Language: eng | pol
```

| Act | CELEX | Short name | Articles | Paragraph ids | Recitals | Annexes |
|---|---|---|---|---|---|---|
| GDPR | 32016R0679 | GDPR | 99 | 372 | 173 | - |
| AI Act | 32024R1689 | AI Act | 113 | 500 | 180 | 13 |
| NIS2 | 32022L2555 | NIS2 | 46 | 189 | 144 | 3 |

Paragraph ids are counted after rule 1 below. The raw AI Act XHTML has 509 `NNN.NNN` ids; 9 of them sit in quoted amendment text. EN and PL match exactly.

- `mokosz fetch` downloads EN and PL once; the six files (about 5.7 MB) are committed under `data/raw/`, so seeding and CI never touch the network.
- Original Official Journal texts, not consolidated versions; the README says so. Reuse is allowed under Commission Decision 2011/833/EU; the README credits the source.

#### Chunking and ids
**Citation key = `{celex}#{element_id}`**, e.g. `32024R1689#014.001`. Element ids repeat across acts (GDPR and the AI Act both have `014.001`), so a bare `element_id` is never used as a key anywhere: not in the answer schema, the verifier, the eval sets, the API or the UI. Language is a separate field; the same key exists in EN and PL.

Chunk rules, applied in order, all deterministic and position-based so EN and PL produce identical keys:
1. **Article with paragraph ids**: one chunk per paragraph; `element_id` = the XHTML id. **An id `NNN.NNN` counts only if `NNN` equals the number of the enclosing article.** Ids that fail this check are quoted amendment text and fall under rule 2. The AI Act's Arts 105–109 quote other acts: `005.004`, `005.012` and `008.005` sit in Arts 105–107, five more in Art. 108 and `011.003` in Art. 109. Taken at face value they would collide with real paragraphs or create false citations such as "Art. 5(12)".
2. **Article without paragraph ids**: one chunk per top-level numbered point (`(1)`, `(2)`… or `(a)`, `(b)`…), with `element_id` = `art_{N}.pt_{k}` (k = 1-based position). The lead-in text before the first point is `art_{N}.p_0`. An article without points gets one chunk per block, `art_{N}.p_{k}`.
   - This covers 17 articles in GDPR (including Art. 4, definitions, 26 points), 19 in the AI Act (including Art. 3, definitions, 68 points, and the quoting Arts 105–109) and 10 in NIS2.
3. **Recital:** one chunk, `element_id` = `rct_{N}`.
4. **Annex** (ids are Roman numerals, `anx_I`): one chunk per top-level point or block, `anx_{R}.p_{k}`.
   - NIS2 Annexes I and II are sector tables. They are split by **top-level row** (nested tables stay inside their row), `anx_{R}.r_{j}`. Cells spanning several rows (`rowspan`, e.g. "1. Energy / (a) Electricity") are copied into every row they span, so each row chunk keeps its sector.
   - NIS2 Annex III (the correlation table) and AI Act annex tables are kept as one chunk per table.
   - **Section headings are not chunks** (decision 0008): a heading block (`oj-ti-grseq-1`, e.g. "1. Schengen Information System", "Section 1") is joined to the block that follows it, together with any headings directly after it, so the heading words stay with their content.
   - **Dash lists stay whole** (decision 0008): top-level items labelled "—" (the AI Act Annex II list of criminal offences) are joined to the block before them, giving one chunk with the lead-in and the whole list.
5. **No length-based splitting.** The longest non-table chunk is GDPR `070.001` at 865 EN words; a token-based cap would split EN and PL differently.

Chunk metadata: `celex`, `act` (short name), `lang`, `element_id`, `kind` (paragraph | point | recital | annex), `article` (number or null), `heading` (article title, or the annex title), `text`.

The ingest tests assert that keys are unique per act, that the EN and PL key sets are identical for every act, and pin a digest of the chunk and embedding texts, so the committed embeddings keep matching the text they were computed from.

#### Invoices: generated, never real
- `mokosz generate-invoices` uses a **fixed seed** (`20261103`) with `@faker-js/faker` (Polish and German locales). It builds an `Invoice` first, checks it with the validator, then renders it to PDF with `pdfkit` and the vendored Noto Sans font in 2 layouts (a Polish and a German one, picked by the seller's country). The JSON is the ground truth. The same seed gives byte-identical files.
- Clean invoices use checksum-valid tax ids (NIP for PL, USt-IdNr for DE), drawn again until the checksum passes.
- **150 invoices: 75 PL (PLN) and 75 DE (EUR); 100 clean and 50 defective, 10 per defect class (5 per country):**
  1. line items do not add up to the net total;
  2. wrong VAT amount;
  3. invalid tax id checksum;
  4. missing issue date;
  5. VAT rate not valid for the seller's country.
- Each invoice is `{id}.pdf` plus `{id}.json` (`invoice`, `defect`, `expected_failed_rules`); `index.json` lists `id`, `country` and `defect`. All are committed under `data/invoices/`.
- Company names are invented; every PDF page is marked "SAMPLE / FICTIONAL".
- `@faker-js/faker` and `pdfkit` are dev dependencies: the generator is a development tool, loaded only by its command.

### 2. Retrieval
- **Embeddings via Ollama**, through the AI SDK `embed()` with `ollama-ai-provider-v2`: no local ML runtime in Node. The model is **`bge-m3`** (1024 dimensions, multilingual), chosen over `qwen3-embedding:0.6b` by recall@5 on 20 EN/PL test queries in `evals/retrieval/queries.json` (decision 0007). Queries get no prefix.
- The embedding call pins `num_ctx` to 4096 and disables truncation. Ollama's default context for some embedders is far larger and reserves GPU memory for nothing; the longest chunk fits in 4096.
- **Embeddings are computed locally once and committed**:
  - `data/embeddings/bge-m3/chunks.npy` (float16), with `chunks.json` listing `(citation_key, lang)` per row;
  - `data/embeddings/bge-m3/queries.npy` and `queries.json` for the retrieval test queries.

  `mokosz embed` writes them and prints recall@5; `mokosz seed` and CI load them; **no model runs in CI**.
- **Vector search only in v1** (pgvector cosine distance), no full-text search (decision 0006):
  - results are filtered with plain `WHERE` clauses by the query language and by the acts the router detected;
  - article references the router extracts ("art. 14", "Article 14", "artykuł 14") become an `(act, article)` filter, so "art. 14 AI Act" returns Article 14 even though a number carries no meaning for embeddings. The chunks of the referenced articles come first, then similarity search within the filtered acts fills up to `top_k`. Both queries order by `distance, id`, so ties are stable;
  - the embedded text gives each chunk its context: an article chunk is `"{act} {Article|Artykuł} {N} {heading}\n{text}"`, a recital `"{act} {Recital|Motyw} {N}\n{text}"`, and an annex chunk `"{act} {Annex|Załącznik} {R} {heading}\n{text}"`. A missing heading or article number is written as `None`; the committed embeddings were computed that way.
- The corpus is 3,974 chunks (EN and PL). The timing in decision 0007, measured on an RTX 4090 before the annex rules of decision 0008 merged some chunks, is about 90 s for the then 4,048 chunks plus the queries with `bge-m3`, done once.

### 3. Q&A flow (Mastra)

`router -> retriever -> (answerer -> verifier), repeated until the verifier passes or 2 attempts -> final answer`

- The workflow `qa` (`src/mastra/workflows/qa.ts`) has four steps. `router` and `answerer` are Mastra Agents whose prompts live in `src/prompts/*.md`; the model comes from the profile on every call. The answer-verify pair is a nested workflow run by `dountil`.
- The workflow is created with `autoRestartActiveRuns: false`: a run interrupted by a restart is not resumed, it ends `failed`.
- **One conversation = one Mastra Memory thread** (`threadId` = conversation id). The question is saved to the thread before the workflow starts; the verifier saves the reply. A turn that fails mid-way leaves the question without a reply. The previous turn's `filters` live in the thread metadata.
- **`router`** reads the last 10 messages plus the new one and returns structured output:
  - `lang`: `en` | `pl`;
  - `acts`: the acts the question is about (0 to 3; empty = all);
  - `article_refs: [{act, article}]`. A reference without an act takes the act from the conversation (when the previous turn's filters name exactly one act), or else from `acts` when there is exactly one; otherwise it is dropped;
  - `query`: a **standalone rewritten question**. "And what about art. 26?" after an AI Act question becomes "What does AI Act Article 26 require?".

  It is the only LLM call before retrieval.
- **`retriever`**: embeds `query` and runs the vector search with the router's filters, `top_k` from the profile. It is a fixed step of the workflow, never a tool the model may skip.
- **`answerer`** returns structured output: `claims: [{text, citations: [citation_key, ≥1]}]` and `not_found: bool`. Its request holds the answer language, the query, the retrieved chunks with their keys and headings, and on a retry the verifier's reasons.
- **`verifier`** is deterministic and fails the answer when:
  - a claim has no citation;
  - a cited key is not in the retrieved set;
  - `not_found` is false while there are no claims, or true while there are claims.

  On failure the answerer runs once more with the reasons. On a second failure the answer is "not found in the sources", in the question's language (`Not found in the sources.` / `Nie znaleziono w źródłach.`).
- Model output that does not parse against its zod schema fails the step and the run; nothing is retried or repaired outside the verifier loop.
- **Step events:** every step runs inside a wrapper (`src/mastra/workflows/wrap.ts`) that adds the step to the run's path, emits `step_started`, and on success emits `step_finished` with that step's own model, tokens and latency. The executor writes the terminal event.

#### Invoice extraction (v1, not built yet)
The planned flow is `extractor -> validator -> (done | human_review)`: invoices enter only through an upload in the UI (decision 0009), one invoice = one run, the extractor turns PDF text into an `Invoice` with structured output, the deterministic validator checks it, and a failed invoice waits for a reviewer to approve (with a note, stored as an override), edit (validated again) or reject it.

What exists as groundwork:
- the `Invoice` schema and the validator (`src/invoices/`), with case-table tests;
- migration `0004_invoices.sql`: the `invoices` table, the `pending_review` run status and the `interrupt` event type;
- the invoice store lifecycle in `src/runs/invoices.ts`: create an invoice with its extraction run, interrupt for review, claim a reviewer's decision (approve, edit or reject), finish or fail the extraction, and list invoices. Startup marks the invoices of interrupted runs `failed`;
- the generated set in `data/invoices/` (§1).

There is **no extraction workflow, no invoice API and no approval screen** yet.

**Validator rules** (deterministic, no LLM; every rule is always evaluated and reports every problem it finds). Money is the bigint `Decimal` of `src/decimal.ts`, which keeps its scale (decision 0013); VAT per rate group is rounded half-up to 2 places; amounts match within an inclusive tolerance of ±0.01.
- `required_fields`: number, issue date, seller name, seller tax id, **seller country** (the rate rule depends on it), currency, at least one line; each present and parseable.
- `line_net`: line `net = quantity × unit_net`.
- `lines_total`: the sum of line nets equals `total_net`.
- `vat_rate_country`: the rate is valid for the seller's country. PL: 23, 8, 5, 0, `zw`, `np`; DE: 19, 7, 0. `zw` and `np` count as rate 0 in the arithmetic.
- `vat_total`: VAT per rate group equals `rate × net` of that group, and the sum equals `total_vat`.
- `gross_total`: `total_net + total_vat = total_gross`.
- `tax_id`: the checksum, after removing spaces and dashes:
  - PL NIP: 10 digits (a printed `PL` prefix is stripped), weights 6,5,7,2,3,4,5,6,7, sum mod 11 equals the last digit; a remainder of 10 is invalid;
  - DE USt-IdNr: `DE` + 9 digits, ISO 7064 MOD 11,10.

#### `Invoice` schema
Fields the validator must be able to find missing are **nullable in the schema**. Otherwise structured output forces the model to invent them. Objects are strict (no extra keys).

```
Invoice
  number: string | null
  issue_date: date | null         # YYYY-MM-DD
  sale_date: date | null
  currency: string | null         # ISO 4217
  seller: Party
  buyer: Party
  lines: Line[]
  total_net: Decimal | null
  total_vat: Decimal | null
  total_gross: Decimal | null

Party
  name: string | null
  tax_id: string | null           # NIP or USt-IdNr as printed
  country: string | null          # ISO 3166 alpha-2
  address: string | null

Line
  description: string
  quantity: Decimal
  unit_net: Decimal | null
  vat_rate: string | null         # "23", "7", "zw", "np"
  net: Decimal | null
```

In JSON, money and quantities are strings ("3000.00").

#### Models
- Each node calls its Mastra Agent through one module, `src/llm/models.ts`, which builds the AI SDK model from the profile, records tokens, cost and latency per call (also on failures), and validates the output. **Answer tokens are not streamed**: the answer is structured JSON and the verifier may reject the first draft. The UI shows step progress and reveals the answer only after the verifier passes.
- **v1 is local-first, via Ollama** on the host GPU. Profile model names carry a provider prefix: `ollama_chat/<model>` or `anthropic/<model>`.
- **Profiles** (`profiles/*.yaml`) set `timeout_s`, retrieval `top_k`, and per node (`router`, `answerer`): the model, and optionally `num_ctx`, `think`, `temperature` and `keep_alive` (`num_ctx`, `think` and `keep_alive` apply to Ollama models only; a cloud node that sets one fails to load).

  | Profile | Router | Answerer | Needs |
  |---|---|---|---|
  | `local-qwen` (default) | `qwen3.6:27b` | `qwen3.6:27b` | GPU with about 24 GB |
  | `local-gemma` | `gemma4:26b` | `gemma4:26b` | GPU with about 24 GB |
  | `cloud-claude` (optional; no eval row in v1) | `claude-haiku-5-5` | `claude-sonnet-5-5` | `ANTHROPIC_API_KEY` |

  - **One local LLM per profile, for every node.** Measured on an RTX 4090: `qwen3.6:27b` (17 GB) plus the embedder fills the card; a separate small router gets evicted and every turn reloads both models. The router's output is a few dozen tokens, so the big model routes in about a second.
  - The cloud profile does not set `temperature`: these models accept only the default temperature, and a request with another value is refused before it is sent.
  - Every profile still needs Ollama for the `bge-m3` query embedding.
- Cost: the cloud models are priced from the table in `src/llm/prices.ts`; local models cost 0.
- A **cold start** (model load) takes 10 to 15 s from the disk cache.
- The app reaches Ollama at `OLLAMA_BASE_URL` (default `http://localhost:11434`).

### 4. API
A plain Hono app with only the app's own routes (no Mastra server routes, decision 0011), on port 8000 by default.

| Method and path | Purpose |
|---|---|
| `POST /api/conversations` | new conversation → `201 {id}` |
| `GET /api/conversations/{id}` | `{id, turns}`; each turn is `{run_id, question, answer, status, created_at, metrics: {path, models, tokens_in, tokens_out, cost_usd, latency_ms}, citations}`, built from `runs` and their `final` events; `citations` maps each cited key to `{label, act, article, heading}` |
| `POST /api/conversations/{id}/messages` | `{text, profile?}` → `202 {run_id}`; starts a Q&A run |
| `GET /api/runs/{id}/events` | SSE (`EventSource`); resumes after `?after=N` or `Last-Event-ID` |
| `GET /api/citations/{celex}/{element_id}?lang=en\|pl` | `{citation_key, lang, act, article, heading, label, text}` for the citation panel |
| `GET /api/health` | `{status: ok\|degraded, db, ollama}`; 200 when the database is reachable, 503 when it is not |

**Contract:**
- Client errors are JSON `{detail: string}` with the app's own message: 404 for an unknown conversation, run, citation, profile or path, 409 for a conflict, 422 for invalid input. An unexpected server error is a plain 500.
- A wrong method on a known path is 404; `HEAD` is answered like `GET`; a trailing slash is 404.
- Path ids must be canonical hyphenated UUIDs; uppercase is accepted and lowercased; braced, `urn:uuid:` and 32-hex forms are 422.
- A JSON body needs a JSON `Content-Type`; invalid JSON, a non-finite number, a wrong shape or an unknown field is 422. `text` must be non-empty after trimming.
- A request body over 64 KB is `413 {detail}`.
- When the server is bound to a loopback address (the default, `127.0.0.1`), a `Host` header whose name is not `localhost`, `127.0.0.1`, `[::1]` or the bound address is `403 {detail}`, on any port. Bound to another address, `Host` is not checked.
- `created_at` is ISO 8601 UTC with milliseconds, e.g. `2026-11-04T21:41:36.590Z`.

**Run lifecycle:**
- A run executes as a background task in the API process (the executor), never inside the request. A client disconnect does not cancel the run.
- Step start and finish, the final result and an error are stored as `run_events` with a per-run `seq`. Token counts are stored per step (in/out) and summed per run, with cost, latency, the path and the models; individual tokens are never stored.
- The SSE endpoint replays the stored events after the requested `seq`, then follows new ones until the run ends; a reload or a late connection loses nothing. An idle stream gets a `: ping` comment every 15 s.
- On startup, runs left in `running` are marked `failed` ("interrupted by restart"), and so are their invoices. On shutdown, active runs are cancelled and end `failed` ("interrupted by shutdown").
- **Source of truth for chat history shown in the UI:** the `runs` table (one row per turn, with the question) and each run's `final` event. Mastra Memory holds the conversation for the model; the UI never reads it.
- **409 Conflict** for a new message while a run is active on the same conversation, enforced by a unique index on running runs. The UI disabling its button is not the guard.

SSE frames are `event: <type>`, `data: <JSON>`, `id: <seq>`. Types and payloads:
- `step_started` `{node}`;
- `step_finished` `{node, model, tokens_in, tokens_out, latency_ms}`;
- `final` `{lang, not_found, claims: [{text, citations: [citation_key]}]}`;
- `error` `{message}`.

#### Planned API (v1, **not built yet**)
None of these routes or events exists in the code; they are the contract for the rest of v1.

| Method and path | Purpose |
|---|---|
| `POST /api/invoices` | multipart PDF, `profile?` → `{invoice_id, run_id}`; starts an extraction run |
| `GET /api/invoices?status=` | queue: `running`, `pending_review`, `approved` (by a reviewer, incl. after edit or override), `rejected`, `done` (passed validation with no review), `failed` (extraction error such as a model timeout or invalid JSON, or interrupted by a restart) |
| `GET /api/invoices/{id}` | extracted invoice, failed rules, decision |
| `GET /api/invoices/{id}/pdf` | the uploaded PDF |
| `POST /api/invoices/{id}/decision` | `{action: approve\|edit\|reject, invoice?, note?}`; resumes the suspended extraction run |
| `GET /api/runs?kind=&status=` | runs list |
| `GET /api/runs/{id}` | run with its steps and path |
| `GET /api/graphs/{qa\|extraction}` | the workflow's step topology for the run-detail graph (React Flow), taken from the Mastra workflow definition |

- **409 Conflict** for a decision on an invoice that is not `pending_review`.
- On startup, runs waiting for a reviewer stay `pending_review`; only `running` runs are marked `failed`.
- SSE gains `interrupt` `{invoice_id, failed_rules}`, and an extraction run's `final` is `{invoice_id, status}`.

### 5. Storage
- PostgreSQL 17 + pgvector (`pgvector/pgvector:0.8.7-pg17` in `compose.yaml`, published on `127.0.0.1:5433`), reached through `pg`. The app's tables are owned by `node-pg-migrate` (SQL files in `src/db/migrations/`, history in `pgmigrations`); `mokosz setup` migrates to head.
- Mastra's `PostgresStore` keeps workflow snapshots and Memory threads and messages in the `mastra` schema of the same database. It has its own connection pool, so its queries cannot take the connections that run writes need.
- **Tables** (migrations 0001–0004):
  - `chunks` (the metadata above, `embedding vector(1024)`, unique `(celex, element_id, lang)`);
  - `runs` (`kind` qa | extraction, `thread_id`, `conversation_id` or `invoice_id`, `question` for Q&A, `status` running | pending_review | done | failed, `profile`, `models`, `tokens_in`, `tokens_out`, `cost_usd`, `latency_ms`, `path`, `error`, `created_at`, `finished_at`);
  - `run_events` (`run_id`, `seq`, `type`, `payload` JSON, `created_at`);
  - `invoices` (groundwork: `status`, `run_id`, `thread_id`, `pdf_path`, `extracted`, `failed_rules`, `final`, `decision`, `override`, `note`, `decided_at`, `created_at`).
- Conversations are Memory threads, not a table of their own.
- Eval results are files, not tables (see §6).
- Settings come from the environment, then `.env` in the working directory, then defaults: `DATABASE_URL`, `OLLAMA_BASE_URL`, `DEFAULT_PROFILE`, `ANTHROPIC_API_KEY`. Names are exact and upper-case; an unknown name in `.env` is an error; there is no `${VAR}` expansion. `ANTHROPIC_API_BASE`, or else `ANTHROPIC_BASE_URL` (default `https://api.anthropic.com`), is read from the process environment only, never from `.env`.

### 6. Evals
As implemented (decision 0015):
- **Retrieval:** 20 EN/PL queries in `evals/retrieval/queries.json`; `mokosz embed` prints recall@5 per model.
- **Q&A set** in `evals/qa/items.json`: 30 items, 15 EN and 15 PL, 5 of them unanswerable from the three acts (expected: `not_found`). Each answerable item has expected citation keys, a short reference answer, and evidence quotes; a test checks that every expected key exists and its chunk contains the quote. The set was written by a model from the regulation texts and is not reviewed by a lawyer.
- **`mokosz eval [--profile <name>] [--repeat N]`** asks every item in a new conversation through the real executor and workflow, after one warm-up turn, and reports:
  - citation precision and recall over citation keys, macro and micro, on answerable items; a key counts only when the answer is in the item's language;
  - correct abstentions (unanswerable → `not_found`), false abstentions (answerable → `not_found`), `not_found` accuracy and failed turns;
  - latency p50 and p95 (nearest rank) over the turns after the warm-up; the warm-up's latency is reported as the cold start.
- **Results are files:** `evals/results/{YYYY-MM-DD-HHMM}-{profile}-qa.csv` (one row per item and repeat) and `evals/results/{YYYY-MM-DD-HHMM}-{profile}.md` (the summary with profile, models, git sha and date). The README shows the latest table.
- Every eval question is a real conversation in the database. An eval may run next to `serve`: it does not mark live runs failed.
- **Not built yet:** the LLM judge (`mistral-small3.2:24b`, local, in a separate pass after all answers), the invoice extraction eval (per-field accuracy, defect recall per class, false-positive rate on clean invoices), cost in the summary, variance across repeats, and a private gitignored invoice set.

### 7. Observability
- Every run's status, steps, tokens, cost, latency, path and models are persisted in Postgres (`runs`, `run_events`) and shown under each answer.
- **Planned, not built yet: Langfuse tracing**, one integration only, called from our code:
  - one trace per run, one span per workflow step (in the step wrapper), and one generation per LLM call (recorded in `src/llm/models.ts`);
  - Langfuse Cloud (free tier) by default, using `LANGFUSE_*` keys in `.env` (decision 0005). With the keys set, prompts and invoice text leave the host; this is acceptable only because uploaded invoices are the synthetic set and the regulations are public. The README must say it plainly: "with Langfuse keys, traces go to Langfuse Cloud; without them, nothing leaves the machine";
  - without keys, tracing is off and the app still runs; cost, tokens, latency and the path are always persisted in Postgres;
  - self-hosting Langfuse is only documented in the README, with a link to the official compose, not added to this repo's compose.

### 8. Web UI (React + Vite + Tailwind + shadcn/ui, dark theme)
**The UI is a first-class deliverable, not a debug page** (decision 0002). Most people who open the repo judge it from the README images in seconds. Every screen must look finished, and handles empty, loading and error states.

Built:
1. **Chat (hero screen, first README image):**
   - the conversation; while a run is active, the current step is shown, and the verified answer appears when it is done;
   - citations as chips in the answer; clicking one opens a side panel with the exact text (EN/PL toggle) and the article heading;
   - a small strip under each answer: path, tokens, cost, latency, model;
   - the conversation id in the URL, and a "New conversation" button.

Not built yet: the **approval queue** (upload, invoices by status, PDF next to the extracted form with failed rules on their fields, Approve / Edit / Reject), **run detail** (the workflow graph with the run's path, a step timeline) and a **runs list**.

In development, Vite proxies `/api` to `127.0.0.1:8000`.

**Screenshots:**
- The demo data is **real usage** of the local profiles: the maintainer's own conversations.
- `mokosz screenshots` (Playwright) opens the built UI served by `vite preview`, writes `docs/img/chat.png` from a conversation with an answer, and records `docs/img/chat.gif` by asking a question through the UI, assembled from frame screenshots with `sharp`.
- README images are always produced this way, never by hand.

### 9. Repo, tooling and CI
- **`mokosz` CLI** (`src/cli.ts`, commander), run as `npx mokosz`, the same on Windows, Linux and macOS, with no `make`:

  | Command | What it does |
  |---|---|
  | `mokosz setup [--profile <name>]…` | checks Docker and Ollama, pulls the Ollama models of the given profiles (default: `DEFAULT_PROFILE`) plus `bge-m3`, starts `db` with `docker compose up -d --wait db`, migrates and seeds. An unreachable Ollama is a warning, and no models are pulled |
  | `mokosz fetch [--force]` | downloads the regulations into `data/raw/`; existing files are kept unless `--force` |
  | `mokosz embed [--model <name>]…` | embeds the chunks and the retrieval queries into `data/embeddings/{model}/` (default `bge-m3`) and prints recall@5 |
  | `mokosz seed` | loads chunks and their committed embeddings into Postgres (invoices enter only through the upload, decision 0009) |
  | `mokosz generate-invoices [--out <dir>] [--seed <n>]` | builds the invoice set; the defaults reproduce the committed `data/invoices/` |
  | `mokosz serve [--host 127.0.0.1] [--port 8000] [--reload]` | runs the API until Ctrl+C; `--reload` restarts it on file changes (`node --watch`) |
  | `mokosz eval [--profile <name>] [--repeat N]` | runs the Q&A eval |
  | `mokosz screenshots [--url http://localhost:4173] [--conversation <uuid>] [--question <text>]` | captures the README images |

  A failed command exits 1; a usage error gets commander's message and a non-zero exit; `serve` exits 3 when the app cannot start (database or runtime), and 1 when it cannot bind the port.
- **Running it:** `docker compose up -d` (or `mokosz setup`) starts only Postgres + pgvector. The API (`mokosz serve`), the UI (`npm run dev` in `web/`) and Ollama run natively. A full `docker compose up` with the API and the built UI is not built yet.
- **Layout:**
  - `src/`: `api/` (Hono routes), `mastra/` (workflow, agents, Memory), `runs/` (executor, run and invoice stores), `llm/` (profiles, models, prices, Ollama pull), `retrieval/`, `ingest/`, `invoices/` (schema, validator, tax ids, generator, PDF), `evals/`, `db/` (pool and migrations), `prompts/`, and the root modules `cli.ts`, `command.ts` (shared command errors and helpers), `setup.ts`, `screenshots.ts`, `settings.ts`, `citations.ts` (citation labels), `decimal.ts` (the money type) and `text.ts`;
  - `web/`;
  - `tests/`, mirroring `src/`, with shared helpers in `tests/support/` and the Claude Code hook tests in `tests/hooks/`;
  - `profiles/`, `evals/`, `data/`.
- Tooling: `npm` with committed lockfiles for the root and `web/`; oxlint (correctness, suspicious, import and async rules) and oxfmt for lint and formatting; `tsc --noEmit` for types.
- **GitHub Actions** runs:
  - `node`: lint, format check, typecheck, and Vitest against a Postgres + pgvector service container, using the committed embeddings, with LLM calls replaced by AI SDK mock models (`ai/test`). No model, no network, no keys; a test project that collects no files fails. The eval pipeline and its scores are tested the same way; quality numbers come only from local runs;
  - `web`: the UI lint and build;
  - `node-windows`: the hook tests, which need no database;
  - `mutation` (manual only): StrykerJS over the pure modules, non-gating.
- **README:** the GIF and screenshot at the top, an architecture sketch, the eval table, how to run and develop it, and the licences.

### Order of work for the rest of v1 (none of it built yet)
The UI is built together with each feature, not at the end.
1. The extraction workflow (extractor, validator, suspend for review and resume with a decision), the invoice endpoints and the interrupt events. **Approval queue screen.**
2. Langfuse tracing, `GET /api/runs`, `GET /api/runs/{id}` and the workflow graph endpoint. **Run detail and Runs list screens.**
3. The invoice eval, the LLM judge, cost and variance in the eval summary, and the cloud profile row.
4. The full `docker compose up` (db, API, built UI), demo usage of the new screens, their screenshots, and the README update.

---

## v2 (only after v1 is complete)
- The router's act/language detection as a trained classifier on the embeddings, compared with the LLM router on accuracy, cost and latency.
- Full-text search (Postgres `tsvector`; `english` for EN, `simple` for PL) and hybrid search with reciprocal rank fusion, with the retrieval mode (`vector` | `fts` | `hybrid`) as a profile parameter compared in evals on recall@5 and citation accuracy.
- MCP server: `search_regulations`, `extract_document`, `get_run`.
- Guardrails: a prompt-injection detector on retrieved text and uploads (with poisoned seed documents), PII masking in logs and traces, and a guardrails log screen.
- OpenAI as an additional cloud provider, and Azure OpenAI with it.
- Roles `analyst` / `reviewer` (from a header, no real auth): only a reviewer can approve, and tool permissions are set per role.
- Deploy on Azure: Container Apps, Postgres Flexible Server, Azure OpenAI, and an Azure Function for blob-triggered extraction, with IaC in Bicep or Terraform.
- An evals screen in the UI.

## Out of scope
Auth, multi-tenancy, production operations, fine-tuning, contracts (invoices only), OpenAI in v1, an MCP client, time-travel UI, self-hosted Langfuse in this repo's compose.
