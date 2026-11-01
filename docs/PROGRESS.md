# Progress

_Last updated: 2026-11-01_

## Goal

A RAG bot over the Vercel AI SDK docs, with citations and evals. The story: **built it, measured it, improved it.**

Later: a mini eval framework that compares models, prompts, cost and speed.

## Decisions

- **Core:** Node/TS API on Fastify. React web chat is the primary demo. Telegram adapter is optional, later.
- **First docs source:** Vercel AI SDK v7. It's current, and it has many breaking changes from v6 that models don't know about:
  - `system` → `instructions`
  - `stepCountIs` → `isStepCount`
  - `fullStream` → `stream`
  - `onFinish` → `onEnd`
  - `usage` now covers all steps, with `finalStep` for per-step values
  - `toolApproval`, `toolsContext` / `contextSchema`
  - `@ai-sdk/otel`
  - Node 22+, ESM-only
- **Ingestion source:** `/llms.txt`. It is not an index: it's the full docs concatenated (541 pages, each with its own frontmatter). We split it locally instead of fetching pages one by one.
- **Corpus scope:** unprefixed `/docs/*` (= v7) and `/cookbook/*`. Excluded: provider pages (for now) and migration guides older than 5→6 (full of stale code).
- **Models:** via OpenRouter ($10 credit limit).
  - Contestants: `qwen/qwen3.8-27b`, `mistralai/mistral-small-2603`
  - Judge: `google/gemini-3.6-flash` (a third model family)
- **Embeddings:** `openai/text-embedding-3-small` via OpenRouter (1536 dims, $0.02 / 1M tokens). Fallback candidate: Qwen3 Embedding 8B (check its dimensions first: pgvector HNSW indexes at most 2000).
- **LLM client:** the AI SDK itself, with `@openrouter/ai-sdk-provider` (3.x line = AI SDK v7). Note: this provider still uses `textEmbeddingModel`, not the v6+ name `embeddingModel`.
- **Database:** Postgres 17 + pgvector in Docker locally (port 5433, because 5432 is taken on this machine). Neon later for deployment (same SQL).
- **Retrieval:** hybrid. Vector search (HNSW, cosine) + full-text search (`tsvector`, terms OR-ed, title/section weighted above body), merged with reciprocal rank fusion (k = 60, 50 candidates from each side).
- **Generation:** top 5 hybrid chunks as numbered `<source>` blocks (section path + URL + content). Instructions: answer only from the sources, cite `[n]` inline, never recommend migration-guide "Before" code, say "couldn't find it" instead of guessing. Same models and settings as the baseline, so retrieval is the only variable.
- **Planned:** SSE streaming, Fastify API, React chat.

## Secrets setup (done)

- The OpenRouter key lives in Bitwarden Secrets Manager.
- The machine-account token is stored outside the repo.
- A PowerShell profile function `withsecrets` sets the token, runs `bws run`, and removes the token afterwards:
  ```powershell
  withsecrets npm run <script>
  ```
  Only scripts that call OpenRouter need it (`embed`, `eval:retrieval`, `eval:rag`, baseline, judge).
- `.claude/settings.json` denies reads of `.env*` and the secrets folder, and denies `bws`.
- Environment: Windows, WebStorm, PowerShell 5.1.

## Pipeline

```
npm run fetch-docs        llms.txt → data/corpus/ (375 pages, committed) + _manifest.json (sha256 per page)
npm run check-coverage    every eval source exists in the corpus
npm run chunk-docs        corpus → data/chunks.jsonl (1986 chunks, gitignored, deterministic)
npm run db:up             Postgres + pgvector in Docker
npm run db:migrate        schema (add -- --reset after changing embedding dims)
withsecrets npm run embed            embed new/changed chunks only, delete stale ones
withsecrets npm run eval:retrieval   vector / text / hybrid scores → evals/runs/
withsecrets npm run eval:rag -- --dry q04   print the prompt for one question, no LLM call
withsecrets npm run eval:rag         both models answer with top-5 sources → evals/runs/rag-<stamp>.json
withsecrets npm run eval:judge       grade the latest run (baseline or rag) → <run>.judged.json
```

## Repo contents

| Path | What it is |
|---|---|
| `data/corpus/` | Snapshot of the v7 docs + cookbook as Markdown. `.gitattributes` marks it `-text` so line endings (and hashes) don't change on Windows. |
| `scripts/fetch-docs.ts` | Splits `llms.txt` by frontmatter, filters by path, writes pages + manifest. Section index pages are stored as `_index.md`. |
| `scripts/check-coverage.ts` | Checks that every eval `sources` URL exists in the corpus. |
| `scripts/chunk-docs.ts` | Splits pages at `##`/`###` (never inside code fences). Merges sections < 120 tokens into the next; splits sections > 800 tokens at paragraphs, top-level list items, nested list items (parent line repeated) and table rows (header repeated). Each chunk has `content` and `embed_text` (= "Title > Section" + content), `kind`, `url` with anchor. |
| `scripts/db-migrate.ts`, `src/db/schema.ts` | `chunks` table: metadata, `vector(1536)` with HNSW index, generated weighted `tsvector` with GIN index. |
| `scripts/embed-chunks.ts` | Batches of 200, hash per chunk (model + chunk) so reruns only embed what changed, each batch committed separately. |
| `src/config.ts` | Embedding model + dims, `DATABASE_URL` default. |
| `src/embedding.ts` | Embedding model + `embedTexts()`. |
| `src/retrieval/search.ts` | `vectorSearch`, `textSearch`, `rrf`, `hybridSearch`. |
| `scripts/eval-retrieval.ts` | Scores all three modes on evidence@k and MRR, prints misses, saves the run. |
| `evals/ai-sdk-evals.json` | 20 questions (16 answerable, 4 unanswerable). Each has `expected_answer`, `must_include`, `stale_signals`, `sources`; answerable ones also have `evidence`. |
| `scripts/run-baseline.ts`, `scripts/judge.ts` | No-retrieval baseline + LLM judge. The judge picks the newest `baseline-*` or `rag-*` run, or takes a path. |
| `src/rag/prompt.ts` | RAG instructions, source formatting, citation parser (ignores code and index brackets like `arr[0]`). Shared with the future API. |
| `src/rag/retrieve.ts` | Embeds all questions in one request, hybrid top 5 per question. |
| `scripts/run-rag.ts` | Same as `run-baseline.ts` plus retrieval. Extra fields per answer: sources (with ✓ for evidence), `evidenceInSources`, citations, invalid citations, `citesEvidence`. `--dry <id>` prints the prompt. |
| `src/lib/pool.ts` | Shared helper for running requests in parallel. |
| `evals/baselines/` | `baseline-v1.json` (+ judged): generation "before". `rag-v1.json` (+ judged): generation "after". `retrieval-v1.json`: retrieval measurement. |

Corpus stats: 375 pages → 1,986 chunks, ~644k tokens (estimated), median chunk 254 tokens, p90 667. Embedding the whole corpus: 618k tokens, 51 s, ~$0.012.

## Baseline results (no retrieval)

| Model | Correct | Acceptable | Outdated | Wrong | Declined (/4) | Hallucinated |
|---|---|---|---|---|---|---|
| Qwen 3.8 27B | 0 | 0 | 8 | 8 | 2 | 2 |
| Mistral Small 4 | 2 | 1 | 4 | 9 | 3 | 1 |

- Qwen gives outdated v4/v5 code. Mistral invents APIs.
- Qwen costs about 6× more and is 2.5× slower.
- The judge is calibrated but slightly lenient on invented side details.

## RAG results (rag-v1): before → after

Same 20 questions, same models and settings, same judge. Only change: top-5 hybrid sources in the prompt.

| Model | Correct | Acceptable | Outdated | Wrong | Declined (/4) | Hallucinated | Cost (20 q) | Avg latency |
|---|---|---|---|---|---|---|---|---|
| Qwen, no retrieval | 0/16 | 0 | 8 | 8 | 2 | 2 | $0.038 | 10.2 s |
| **Qwen + RAG** | **14/16** | 0 | **0** | 2 | **4** | **0** | $0.021 | 9.4 s |
| Mistral, no retrieval | 2/16 | 1 | 4 | 9 | 3 | 1 | $0.0067 | 4.3 s |
| **Mistral + RAG** | **14/16** | 0 | **0** | 2 | **4** | **0** | $0.0068 | 3.5 s |

- Outdated answers went to zero for both models, and so did hallucinations on unanswerable questions.
- RAG did not make answers more expensive or slower, despite ~3k extra input tokens per question: the models reason and write less when the answer is in front of them. Qwen got ~45% cheaper.
- Both models now score the same, so the 6× cost difference for Qwen buys nothing here. Mistral is the better choice for this bot.
- Citations: no invented source numbers. Every answer judged correct cited a source that contains the evidence (14/16 for both).
- The same 2 questions fail for both models (q03, q09), and both are **retrieval misses**: the evidence was not in the 5 sources. Generation is no longer the bottleneck.
- Reproduced in a second run with the same result (14/16, 4/4 declined, 0 hallucinated).

### Lesson: near-miss sources are where hallucination comes back

q09's sources were *related* (multi-step calls, `prepareStep`) but didn't contain the answer. In one run Mistral correctly said "couldn't find it". In the rerun it invented `result.messages` and `stopWhen: 'natural'` despite the instruction not to fill gaps from memory. When retrieval returns near-misses, a small model is tempted to fill the gap; prompt wording only partly prevents it. Better retrieval is the more reliable fix.

Also: temperature 0 is not deterministic through OpenRouter (requests can be routed to different providers). Treat a single run as noisy; for published numbers, run 2–3 times and report the range.

## Retrieval results (retrieval-v1)

16 answerable questions, top-k chunks, `text-embedding-3-small`:

| Mode | evidence@1 | evidence@3 | evidence@5 | evidence@10 | MRR |
|---|---|---|---|---|---|
| Vector | 0.53 | 0.81 | 0.81 | **0.94** | 0.69 |
| Full-text | 0.38 | 0.56 | 0.69 | 0.81 | 0.49 |
| **Hybrid (RRF)** | **0.56** | **0.75** | **0.88** | 0.91 | **0.69** |

- Hybrid beats both single modes at k = 5, which is the number of chunks generation uses.
- Misses at k = 5: q03 (Node version + ESM: two facts, the ESM / `require()` one exists in a single migration-guide chunk) and q09 (`result.responseMessages`).
- Vector alone finds both q03 and q09 within its top 10; hybrid doesn't. Full-text finds nothing useful for them, and its noise pushes the right chunks out of the fused list (hybrid@10 0.91 < vector@10 0.94). Candidates to try: weight vector above full-text in RRF, or pass 8 chunks instead of 5.
- With 16 questions, one question ≈ 6 points. Read it as "retrieval works", not as a precise number.

### Lesson: the first retrieval eval measured the labels, not retrieval

The first run scored retrieval by page: did the top-k chunks come from the page in each question's `sources`? Result: hybrid recall@5 = 0.41.

But `sources` recorded where each question was *written from* (13 of 16 from the migration guides), not every page that *answers* it. The v7 answers are spread across the docs: `isStepCount` is on 8 pages, `toolApproval` on 8+. Retrieval kept returning correct pages (`agents/loop-control`, `reference/ai-sdk-core/tool-loop-agent` with "Default: isStepCount(20)", `agents/tool-approvals`), and they were scored as misses.

Fix: score at chunk level instead. Each question got an `evidence` field: a list of facts, each a set of terms that must all appear in one retrieved chunk (e.g. `["isStepCount(", "stopWhen"]`). A chunk counts if it actually contains the answer. Same retrieval, re-scored: hybrid evidence@5 went from 0.41 → 0.94. Page-level scoring was also lenient in another way: a 25-chunk reference page counted as a hit even when the retrieved chunk didn't contain the answer.

The evidence terms need the same care. q09's first version, `responseMessages`, also matched a `prepareStep` chunk that mentions it in a different context, so retrieval got credit for a chunk that doesn't answer the question. The RAG run exposed it (a model built a wrong answer on that chunk). Tightened to `result.responseMessages`: evidence@5 0.94 → 0.88, which is the honest number.

## Known gaps

- 13 of the 16 answerable questions come from the v6/v7 migration guides. Need more on tool calling, embeddings, chat persistence and MCP. Add them before tuning anything else.
- Heading anchors in chunk URLs are an approximation of the site's slugs. Spot-check before relying on them for citations.
- Migration-guide chunks contain "before" (v6) code. If they start showing up as sources of wrong answers, use `kind` to down-rank them.
- Some page titles keep their YAML quotes (e.g. `"React error \"...\""`). The prompt strips them; fixing it at the source (`fetch-docs.ts`) means re-chunking and re-embedding.
- Chunker: when a tiny section is merged at the end of a page, its heading can appear twice in the chunk. Harmless for answers; fix together with the title quotes.
- Single runs are noisy (see above). The eval runner should support N repetitions and report the range.
- The RAG prompt says "version 7"; the baseline prompt said "latest version". Telling the model the version is part of what RAG provides, but say so when presenting the comparison.
- TODO in `judge.ts`: set `MIN_INTERVAL_MS` to 0 once the OpenRouter account is no longer "new".

## Next steps

1. **Expand the eval set** (tool calling, embeddings, chat persistence, MCP), each question with `evidence` checked against the corpus. Before any tuning, otherwise we'd be tuning on q03 and q09 alone.
2. **Retrieval tuning,** measured with `eval:retrieval` first (cheap): weighted RRF (vector > full-text), top 8 instead of 5, sub-queries for multi-part questions.
3. RAG eval on the expanded set (2–3 runs) → rag-v2.
4. Fastify API with SSE streaming (reuses `src/rag/`).
5. React web chat.
6. Deployment (Neon + hosting).
7. Later: eval framework comparing models, prompts, embedding models, cost and speed.
