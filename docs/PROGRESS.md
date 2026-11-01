# Progress

_Last updated: 2026-11-01_

## Goal

A RAG bot over the Vercel AI SDK docs, with citations and evals. The story: **built it, measured it, improved it.**

Later: a mini eval framework that compares models, prompts, cost and speed.

## The story so far

| Stage | Retrieval | Qwen correct | Mistral correct | Unanswerable declined | Hallucinated |
|---|---|---|---|---|---|
| Baseline | none | 2/29 | 2/29 | 3/6 | 3 per model |
| RAG v2 | hybrid (RRF), top 5 | 24/29 | 23/29 | 6/6 | 0 |
| **RAG v3** | **vector, top 8** | **27/29** (both runs) | **24–28/29** | **6/6** | **0** |

35 questions (29 answerable, 6 unanswerable), judged by a third model family against reference answers. Cost per full RAG run: Qwen ~$0.049, Mistral ~$0.024.

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
- **Retrieval:** **vector-only (HNSW, cosine), top 8 chunks**, chosen by the retrieval experiment (see below). Full-text search and weighted RRF are still implemented: `RETRIEVAL.textWeight` in `src/rag/retrieve.ts` turns hybrid back on (0 = vector only).
- **Generation:** the retrieved chunks as numbered `<source>` blocks (section path + URL + content). Instructions: answer only from the sources, cite `[n]` inline, never recommend migration-guide "Before" code, say "couldn't find it" instead of guessing. Same models and settings as the baseline, so retrieval is the only variable.
- **Judge rules:** grades only against the reference, never its own SDK knowledge. For answerable questions, "the information isn't available" counts as **wrong**; partial answers are graded on the part they answer.
- **Headline metric:** "correct". The judge's outdated / wrong split is noisy (see below), so the README reports those together as "not usable".
- **Picking configurations:** with 29 questions, one question ≈ 0.03. Choose the simplest option within about one question of the best, and check it doesn't trade old-question wins for new-question losses.
- **Planned:** SSE streaming, Fastify API, React chat.

## Secrets setup (done)

- The OpenRouter key lives in Bitwarden Secrets Manager.
- The machine-account token is stored outside the repo.
- A PowerShell profile function `withsecrets` sets the token, runs `bws run`, and removes the token afterwards:
  ```powershell
  withsecrets npm run <script>
  ```
  Only scripts that call OpenRouter need it (`embed`, `eval:*`, `experiment:retrieval`).
- `.claude/settings.json` denies reads of `.env*` and the secrets folder, and denies `bws`.
- Environment: Windows, WebStorm, PowerShell 5.1.

## Pipeline

```
npm run fetch-docs        llms.txt → data/corpus/ (375 pages, committed) + _manifest.json (sha256 per page)
npm run check-coverage    every eval source exists in the corpus
npm run chunk-docs        corpus → data/chunks.jsonl (1986 chunks, gitignored, deterministic)
npm run db:up             Postgres + pgvector in Docker
npm run db:migrate        schema (add -- --reset after changing embedding dims)
withsecrets npm run embed                  embed new/changed chunks only, delete stale ones
withsecrets npm run eval:retrieval         vector / text / hybrid scores at k = 1, 3, 5, 10 → evals/runs/
withsecrets npm run experiment:retrieval   compare retrieval configs on the same candidates → evals/runs/
withsecrets npm run eval:baseline          both models, no retrieval → evals/runs/baseline-<stamp>.json
withsecrets npm run eval:rag -- --dry q04  print the prompt for one question, no LLM call
withsecrets npm run eval:rag               both models answer with retrieved sources → evals/runs/rag-<stamp>.json
withsecrets npm run eval:judge             grade the latest run (baseline or rag), or pass a path → <run>.judged.json
```

`evals/runs/` is gitignored. Runs worth keeping are copied ("frozen") into `evals/baselines/` and committed together with the code that produced them.

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
| `src/retrieval/search.ts` | `vectorSearch`, `textSearch`, weighted `rrf`, `hybridSearch` (`textWeight` option; 0 skips full-text). |
| `scripts/eval-retrieval.ts` | Scores vector / text / equal-weight hybrid on evidence@k and MRR, prints misses, saves the run. |
| `scripts/experiment-retrieval.ts` | Fetches each question's top-50 vector and full-text candidates once, then scores every configuration in memory (vector only, text only, RRF with text weight 1 / 0.5 / 0.25 / 0.1) at k = 5, 8, 10, split by old/new questions, with context size and per-config misses. |
| `evals/ai-sdk-evals.json` | 35 questions (29 answerable, 6 unanswerable). q01–q20 written mostly from the v6/v7 migration guides; q21–q35 from the regular docs (MCP, chat persistence, embeddings, tools). Each has `expected_answer`, `must_include`, `stale_signals`, `sources`; answerable ones also have `evidence`. |
| `scripts/run-baseline.ts`, `scripts/judge.ts` | No-retrieval baseline + LLM judge. The judge picks the newest `baseline-*` or `rag-*` run, or takes a path. |
| `src/rag/prompt.ts` | RAG instructions, source formatting, citation parser (ignores code and index brackets like `arr[0]`). Shared with the future API. |
| `src/rag/retrieve.ts` | `RETRIEVAL` config (top 8, vector only) and `retrieveMany()`: embeds all questions in one request. |
| `scripts/run-rag.ts` | Same as `run-baseline.ts` plus retrieval. Extra fields per answer: sources (with ✓ for evidence), `evidenceInSources`, citations, invalid citations, `citesEvidence`. Records the retrieval config in the run file. `--dry <id>` prints the prompt. |
| `src/lib/pool.ts` | Shared helper for running requests in parallel. |
| `evals/baselines/` | **v3 (current):** `rag-v3-run1`, `rag-v3-run2` (+ judged), `experiment-retrieval-v1`. **v2:** `baseline-v2`, `rag-v2` (+ judged), `retrieval-v2`. **v1 (first 20 questions):** `baseline-v1`, `rag-v1` (+ judged), `retrieval-v1`. |

Corpus stats: 375 pages → 1,986 chunks, ~644k tokens (estimated), median chunk 254 tokens, p90 667. Embedding the whole corpus: 618k tokens, 51 s, ~$0.012.

## Results v3: vector top 8 (35 questions, 2 runs)

| Model | Run | Correct | Outdated | Wrong | Declined (/6) | Hallucinated | Cost | Avg latency |
|---|---|---|---|---|---|---|---|---|
| Qwen | 1 | **27/29** | 1 | 1 | 6 | 0 | $0.049 | 7.3 s |
| Qwen | 2 | **27/29** | 1 | 1 | 6 | 0 | $0.048 | 4.9 s |
| Mistral | 1 | 24/29 | 1 | 4 | 6 | 0 | $0.024 | 3.6 s |
| Mistral | 2 | **28/29** | 0 | 1 | 6 | 0 | $0.023 | 3.3 s |

- Input stays at ~3k tokens per question: 8 vector chunks are about as large as 5 hybrid ones (full-text favored long chunks).
- Evidence was missing from the sources only for q01 and q27. Both models still answered q01 correctly; **q27 (`maxParallelCalls`) is the only remaining retrieval failure**, in every run: the fact exists in a single chunk that no configuration reaches.
- **q12 (tool approval) became "outdated"** for Qwen in both runs and Mistral in run 1: they recommended the deprecated `needsApproval`. Cause: the docs themselves (see lesson below).
- Mistral run 1's other misses: q13 (put the API key into the tool's input schema: a real model error), q16 (a judge error caused by a too-narrow reference, now fixed), q26 (judge noise: the same omission was "correct" in run 2).
- Citations: no invented source numbers in either run. The cited source contained the evidence for 25–27 of 29 answers.
- Qwen is now consistently one notch more reliable (27, 27 vs. 24, 28) at twice Mistral's cost. For the demo either works; Mistral stays the cost-efficient default, Qwen the reliable one.

### Lesson: the docs can contradict themselves

The v7 guide `agents/tool-approvals` says: use `needsApproval` only with `WorkflowAgent`; for `generateText` / `streamText` use `toolApproval`. But the cookbook page **"Human-in-the-Loop with Next.js" still teaches `needsApproval: true` for `streamText`**. With 8 sources, both pages were retrieved for q12, and the models followed the stale one (Qwen cited it as `[7]`). RAG faithfully reproduces whatever the corpus says, including its outdated parts. Candidate fix: label each source with its `kind` (guide / reference / cookbook) and tell the model to prefer guides and reference when sources disagree, and to say there is a conflict.

### Lesson: the reference answers need maintenance too

Mistral's q16 answer used `model: 'openai/text-embedding-3-small'` (a plain model id string) and was judged "wrong", but the v7 embeddings page uses exactly that form. The reference only listed `openai.embeddingModel(...)`. Fixed by adding "a model id string like 'openai/text-embedding-3-small' also works" to q16's expected answer. A strict judge is only as fair as its references.

## Retrieval experiment (experiment-retrieval-v1, 29 answerable questions)

Same candidates (top 50 vector + top 50 full-text per question), one embedding request, every config scored in memory:

| Config | all @5 | all @8 | all @10 | MRR | Context @5 | Context @8 |
|---|---|---|---|---|---|---|
| **vector only** | 0.81 | **0.91** | 0.93 | **0.72** | 1.5k | 2.4k |
| text only | 0.52 | 0.59 | 0.66 | 0.33 | 3.4k | 5.5k |
| RRF text ×1 (v2) | 0.78 | 0.81 | 0.83 | 0.62 | 2.5k | 3.8k |
| RRF text ×0.5 | 0.81 | 0.88 | 0.88 | 0.71 | 2.3k | 3.4k |
| RRF text ×0.25 | 0.84 | 0.88 | **0.95** | 0.71 | 1.9k | 2.9k |
| RRF text ×0.1 | **0.88** | 0.88 | 0.91 | 0.69 | 1.6k | 2.6k |

(Context = average estimated tokens of the retrieved chunks.)

- **Winner: vector only, top 8.** Best coverage at 8, best MRR, one search instead of two, and about the same context size as the v2 setup (hybrid top 5).
- Down-weighting full-text helps at k = 5 (0.78 → 0.88), but fusion stops improving after 5; vector-only keeps improving with k.
- Old vs. new questions at k = 8: vector-only 0.94 / 0.88, so the win is not bought with losses on the old set.
- Caveat: every eval question is a full sentence. Bare identifiers ("isStepCount", "fullStream") are where full-text should help, and the eval doesn't test them yet.

## Results v2: hybrid top 5 (35 questions)

| Model | Correct | Acceptable | Outdated | Wrong | Declined (/6) | Hallucinated |
|---|---|---|---|---|---|---|
| Qwen, no retrieval | 2/29 | 3 | 7 | 17 | 3 | 3 |
| Qwen + RAG v2 | 24/29 | 0 | 0 | 5 | 6 | 0 |
| Mistral, no retrieval | 2/29 | 4 | 8 | 15 | 3 | 3 |
| Mistral + RAG v2 | 23/29 | 1 | 0 | 5 | 6 | 0 |

- Without retrieval the models invented tool limits ("128 for OpenAI"), a "30 seconds" MCP default timeout and npm download counts; with RAG, both declined all unanswerable questions.
- The new questions (q21–q33) are plain-language and not built around v7 renames, and the baseline still fails them: the models don't know features like `toolCallConcurrency`, MCP `maxRetries` or top-level embedding `dimensions`.
- Every v2 failure was a retrieval miss (q03, q09, q24, q25, q27, q33). That is what motivated the retrieval experiment.
- Retrieval v2 (`eval-retrieval`, hybrid equal weight): new questions @5: vector 0.81, full-text 0.31, hybrid 0.65. On plain-language questions full-text finds almost nothing, and its noise pushes good vector results out of the fused list.

### Lesson: the judge is reliable on clear answers and noisy on borderline ones

The judge prompt was changed after the first v2 judging, because Qwen's q03 RAG answer ("couldn't find it in the docs") had been graded "correct" for an answerable question. Both runs were re-judged with the new rule:

- **RAG run:** exactly one verdict changed (q03 → wrong), as intended.
- **Baseline run:** 12 of 70 verdicts changed, none because of the new rule. The same answers were graded differently: outdated ↔ wrong (6), correct ↔ wrong (3), declined → hallucinated (2).

RAG answers are mostly clear-cut, so their verdicts are stable. Baseline answers mix old, invented and generic code, and the judge flips on ~17% of them. Consequences: report "correct" as the headline, merge outdated + wrong into "not usable", and consider majority-of-3 judging. v3 showed the same effect once more (Mistral q26: same omission, different verdicts across runs).

## History: v1 (first 20 questions)

| Model | Correct | Outdated | Wrong | Declined (/4) | Hallucinated | Cost (20 q) | Avg latency |
|---|---|---|---|---|---|---|---|
| Qwen, no retrieval | 0/16 | 8 | 8 | 2 | 2 | $0.038 | 10.2 s |
| Qwen + RAG | 14/16 | 0 | 2 | 4 | 0 | $0.021 | 9.4 s |
| Mistral, no retrieval | 2/16 (+1 acceptable) | 4 | 9 | 3 | 1 | $0.0067 | 4.3 s |
| Mistral + RAG | 14/16 | 0 | 2 | 4 | 0 | $0.0068 | 3.5 s |

- RAG did not make answers more expensive or slower, despite ~3k extra input tokens per question: the models reason and write less when the answer is in front of them. Qwen got ~45% cheaper.
- Retrieval v1 (16 questions): hybrid evidence@5 0.88, vector 0.81, full-text 0.69. Hybrid looked best because these questions name exact APIs; v2 showed this doesn't generalize.

### Lesson: near-miss sources are where hallucination comes back

q09's sources were *related* (multi-step calls, `prepareStep`) but didn't contain the answer. In one run Mistral correctly said "couldn't find it". In the rerun it invented `result.messages` and `stopWhen: 'natural'` despite the instruction not to fill gaps from memory. When retrieval returns near-misses, a small model is tempted to fill the gap; prompt wording only partly prevents it. Better retrieval is the more reliable fix (and in v3, with the evidence retrieved, both models answered q09 correctly).

Also: temperature 0 is not deterministic through OpenRouter (requests can be routed to different providers). Treat a single run as noisy; for published numbers, run 2–3 times and report the range.

### Lesson: the first retrieval eval measured the labels, not retrieval

The first run scored retrieval by page: did the top-k chunks come from the page in each question's `sources`? Result: hybrid recall@5 = 0.41.

But `sources` recorded where each question was *written from* (13 of 16 from the migration guides), not every page that *answers* it. The v7 answers are spread across the docs: `isStepCount` is on 8 pages, `toolApproval` on 8+. Retrieval kept returning correct pages, and they were scored as misses.

Fix: score at chunk level instead. Each question got an `evidence` field: a list of facts, each a set of terms that must all appear in one retrieved chunk (e.g. `["isStepCount(", "stopWhen"]`). Same retrieval, re-scored: hybrid evidence@5 went from 0.41 → 0.94. The evidence terms need the same care: q09's first version, `responseMessages`, also matched a `prepareStep` chunk that mentions it in a different context. Tightened to `result.responseMessages`: 0.94 → 0.88, the honest number.

## Known gaps

- **Stale cookbook pages** contradict the v7 guides (e.g. `needsApproval` in "Human-in-the-Loop with Next.js"). Candidate fix: `kind` label per source + "prefer guides/reference when sources disagree" rule, measured on q12.
- **q27** (`maxParallelCalls`) is unreachable by every retrieval config: the fact lives in a single chunk. Worth checking how that chunk was cut.
- **No keyword-style questions** in the eval (bare identifiers like `isStepCount`). That is where full-text search should help; add a few and rerun the experiment before ruling hybrid out for good.
- The judge flips on ~17% of borderline answers. Majority-of-3 judging would reduce it (~3× judge cost, ~$0.20 per run).
- Single runs are noisy (OpenRouter routing). v3 has 2 runs; the runner should support N repetitions and report the range.
- Heading anchors in chunk URLs are an approximation of the site's slugs. Spot-check before relying on them for citations.
- Migration-guide chunks contain "before" (v6) code. If they start showing up as sources of wrong answers, use `kind` to down-rank them.
- Some page titles keep their YAML quotes (e.g. `"React error \"...\""`). The prompt strips them; fixing it at the source (`fetch-docs.ts`) means re-chunking and re-embedding.
- Chunker: when a tiny section is merged at the end of a page, its heading can appear twice in the chunk. Harmless for answers; fix together with the title quotes.
- The RAG prompt says "version 7"; the baseline prompt said "latest version". Telling the model the version is part of what RAG provides, but say so when presenting the comparison.
- TODO in `judge.ts`: set `MIN_INTERVAL_MS` to 0 once the OpenRouter account is no longer "new".

## Next steps

1. **Fastify API with SSE streaming** (reuses `src/rag/`): `POST /chat` → retrieve → `streamText` → stream answer + sources.
2. **React web chat:** streaming answer, clickable `[n]` citations that show the source section and link to the docs.
3. Deployment (Neon + hosting).
4. Quality follow-ups from Known gaps: source `kind` labels for stale cookbook pages, q27, keyword-style questions.
5. Later: eval framework comparing models, prompts, embedding models, cost and speed.
