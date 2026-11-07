# Progress

_Last updated: 2026-11-06_

## Goal

A RAG bot over the Vercel AI SDK docs, with citations and evals. The story: **built it, measured it, improved it.**

**Live:** [ask-ai-docs-agent.onrender.com](https://ask-ai-docs-agent.onrender.com) (free instance, ~1 min to wake up after 15 idle minutes).

**Status (2026-11-06):** the doc bot is done and only gets maintenance. Next comes a mini eval framework in its own repo, with this bot as its first user (see Next steps).

## The story so far

| Stage | Retrieval | Qwen correct | Mistral correct | Unanswerable declined | Hallucinated |
|---|---|---|---|---|---|
| Baseline | none | 2/29 | 2/29 | 3/6 | 3 per model |
| RAG v2 | hybrid (RRF), top 5 | 24/29 | 23/29 | 6/6 | 0 |
| RAG v3 | vector, top 8 | 27/29 (both runs) | 24–28/29 | 6/6 | 0 |
| RAG v4 | vector, top 8 + source kinds | 28/29 (both runs) | 28/29 (both runs) | 6/6 | 0 |
| **RAG v5** | **vector top 30 → rerank → top 8** | **29/29** (both runs) | **29/29** (both runs) | **6/6** | **0** |

35 questions (29 answerable, 6 unanswerable), judged by a third model family against reference answers. Cost per full RAG run: Qwen ~$0.049, Mistral ~$0.024.

v4 labels each source with its kind (guide / reference / cookbook / ...) and tells the model to prefer guides when sources disagree. v5 reranks the vector top 30 with Cohere Rerank and keeps the top 8, which fixed the last miss (q27). At 29/29 the 35-question eval is saturated: it can no longer tell a better configuration from an equally good one.

Two harder sets followed (168 questions, 203 in total). v5 scores 70/72 (Qwen) and 71/72 (Mistral) for hard 1, and 84/87 (Qwen) and 83/87 (Mistral) for hard 2. Unanswerable questions: 8/8 declined. See "Results v5 on harder sets".

Around v3: the same pipeline behind a streaming API, a React chat with clickable citations, and a public deployment with cost limits. The demo runs exactly the configuration the evals measured (same retrieval, models and settings, from the same modules).

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
- **Models:** via OpenRouter.
  - Contestants: `qwen/qwen3.8-27b`, `mistralai/mistral-small-2603`
  - Judge: `google/gemini-3.6-flash` (a third model family)
  - In the demo: Mistral is the default ("Faster"), Qwen the alternative ("Slower, more thorough").
- **Embeddings:** `openai/text-embedding-3-small` via OpenRouter (1536 dims, $0.02 / 1M tokens). Fallback candidate: Qwen3 Embedding 8B (check its dimensions first: pgvector HNSW indexes at most 2000).
- **LLM client:** the AI SDK itself, with `@openrouter/ai-sdk-provider` (3.x line = AI SDK v7). Note: this provider still uses `textEmbeddingModel`, not the v6+ name `embeddingModel`.
- **Database:** Postgres 17 + pgvector in Docker locally (port 5432, see `docker-compose.yml`; set `DATABASE_URL` to use another). Neon in production (same SQL, same scripts).
- **Retrieval:** **vector (HNSW, cosine) top 30 → `cohere/rerank-5-fast` via OpenRouter → top 8.** Vector-only was chosen by the retrieval experiment, the reranker by the rerank experiment (see below). Reranking uses 2 attempts of 3 s each and falls back to the vector order, so a reranker outage means v4-quality retrieval, not an error. Full-text search and weighted RRF are still implemented: `RETRIEVAL.textWeight` in `src/rag/retrieve.ts` turns hybrid back on (0 = vector only); `rerankModel: null` turns reranking off.
- **Generation:** the retrieved chunks as numbered `<source>` blocks (kind + section path + URL + content). Instructions: answer only from the sources, cite `[n]` inline, never recommend migration-guide "Before" code, say "couldn't find it" instead of guessing, and (v4) when sources disagree, follow guides and reference over cookbook examples. Same models and settings as the baseline, so retrieval is the only variable. Settings live in `src/rag/models.ts` (temperature 0, max output 12k tokens, reasoning capped at 4k), shared by the eval runner and the API.
- **Judge rules:** grades only against the reference, never its own SDK knowledge. For answerable questions, "the information isn't available" counts as **wrong**; partial answers are graded on the part they answer.
- **Headline metric:** "correct". The judge's outdated / wrong split is noisy (see below), so the README reports those together as "not usable".
- **Picking configurations:** with 29 questions, one question ≈ 0.03. Choose the simplest option within about one question of the best, and check it doesn't trade old-question wins for new-question losses.
- **API protocol:** the AI SDK's UI message stream, so the frontend uses `useChat` as-is instead of a custom SSE client.
- **Hosting:** one Docker service on Render's free tier that serves both the API and the built web app (one URL, no CORS). Fly.io was the first choice but its signup needs a working card.

## Secrets setup (done)

- The OpenRouter key lives in Bitwarden Secrets Manager.
- The machine-account token is stored outside the repo.
- A PowerShell profile function `withsecrets` sets the token, runs `bws run`, and removes the token afterwards:
  ```powershell
  withsecrets npm run <script>
  ```
  Scripts that call OpenRouter need it (`embed`, `eval:*`, `experiment:retrieval`, `dev:api`, `start:api`).
- Alternative for anyone else: scripts load `.env` if it exists (`src/env.ts`, via `process.loadEnvFile`). Variables already set in the environment take precedence, so `withsecrets` and `.env` don't conflict. `.env.example` lists `OPENROUTER_API_KEY` and an optional `DATABASE_URL`.
- **Production key:** a separate OpenRouter key with its own small credit limit, set only in Render's environment variables (with Neon's `DATABASE_URL`). It is backed up in Bitwarden under a different name / project, so `withsecrets` never injects it into local runs.
- `.claude/settings.json` denies reads of `.env*` and the secrets folder, and denies `bws`.
- Environment: Windows, WebStorm, PowerShell 5.1.

## Pipeline

```
npm run fetch-docs        llms.txt → data/corpus/ (375 pages, committed) + _manifest.json (sha256 per page)
npm run check-coverage    every eval source exists in the corpus (pass question files after '--'; default ai-sdk-evals.json)
npm run chunk-docs        corpus → data/chunks.jsonl (1982 chunks, gitignored, deterministic)
npm run db:up             Postgres + pgvector in Docker
npm run db:migrate        schema (add -- --reset after changing embedding dims)
withsecrets npm run embed                  embed new/changed chunks only, delete stale ones
withsecrets npm run eval:retrieval         vector / text / hybrid scores at k = 1, 3, 5, 10 → evals/runs/
withsecrets npm run experiment:retrieval   compare retrieval configs on the same candidates → evals/runs/
withsecrets npm run experiment:rerank      vector top 30 vs reranked: evidence@k, MRR, latency, cost → evals/runs/
withsecrets npm run rank '--' q27          where vector and full-text search rank a question's evidence (top 50)
withsecrets npm run eval:baseline          both models, no retrieval → evals/runs/baseline-<stamp>.json
withsecrets npm run eval:rag '--' --dry q04  print the prompt for one question, no LLM call
withsecrets npm run eval:rag               both models answer with retrieved sources → evals/runs/rag-<stamp>.json
withsecrets npm run eval:judge             grade the latest run (baseline or rag), or pass a path → <run>.judged.json
withsecrets npm run eval:rag '--' --questions evals/questions-v7-hard.json      another question set (recorded in the run)
withsecrets npm run eval:judge '--' <run> --questions evals/questions-v7-hard.json  needed for runs made before the field existed

withsecrets npm run dev:api                API with reload on http://127.0.0.1:3000
cd web; npm run dev                        web app on http://localhost:5173 (proxies /api to :3000)
npm run ask -- "question" --model qwen     ask the running API from the terminal
```

In PowerShell, quote the separator (`'--'`): a bare `--` is dropped and npm reads `--dry` as its own `--dry-run`. Free-text queries with spaces don't survive `withsecrets` + npm (each word arrives as a separate argument), so `rank` is reliable with question ids only.

`evals/runs/` is gitignored. Runs worth keeping are copied ("frozen") into `evals/baselines/` and committed together with the code that produced them.

Loading Neon uses the same scripts with `DATABASE_URL` pointed at it: `db:migrate`, then `embed`.

## Repo contents

| Path | What it is |
|---|---|
| `data/corpus/` | Snapshot of the v7 docs + cookbook as Markdown. `.gitattributes` marks it `-text` so line endings (and hashes) don't change on Windows. |
| `scripts/fetch-docs.ts` | Splits `llms.txt` by frontmatter, filters by path, writes pages + manifest. Section index pages are stored as `_index.md`. |
| `scripts/check-coverage.ts` | Checks that every eval `sources` URL exists in the corpus. |
| `scripts/chunk-docs.ts` | Splits pages at `##`/`###` (never inside code fences). Groups sections < 120 tokens with the following ones (labeled by the first section, later headings kept inline); splits sections > 800 tokens at paragraphs, top-level list items, nested list items (parent line repeated) and table rows (header repeated). Each chunk has `content` and `embed_text` (= "Title > Section" + content), `kind`, `url` with anchor. |
| `scripts/db-migrate.ts`, `src/db/schema.ts` | `chunks` table: metadata, `vector(1536)` with HNSW index, generated weighted `tsvector` with GIN index. |
| `scripts/embed-chunks.ts` | Batches of 200, hash per chunk (model + chunk) so reruns only embed what changed, each batch committed separately. |
| `src/env.ts`, `.env.example` | Optional `.env` loading (imported by every script via `tsx --import`). |
| `src/config.ts` | Embedding model + dims, `DATABASE_URL` default (local Docker). |
| `src/embedding.ts` | Embedding model + `embedTexts()`. |
| `src/retrieval/search.ts` | `vectorSearch`, `textSearch`, weighted `rrf`, `hybridSearch` (`textWeight` option; 0 skips full-text). |
| `scripts/eval-retrieval.ts` | Scores vector / text / equal-weight hybrid on evidence@k and MRR, prints misses, saves the run. |
| `scripts/experiment-retrieval.ts` | Fetches each question's top-50 vector and full-text candidates once, then scores every configuration in memory (vector only, text only, RRF with text weight 1 / 0.5 / 0.25 / 0.1) at k = 5, 8, 10, split by old/new questions, with context size and per-config misses. |
| `evals/ai-sdk-evals.json` | 35 questions (29 answerable, 6 unanswerable). q01–q20 written mostly from the v6/v7 migration guides; q21–q35 from the regular docs (MCP, chat persistence, embeddings, tools). Each has `expected_answer`, `must_include`, `stale_signals`, `sources`; answerable ones also have `evidence`. |
| `evals/questions-v7-hard.json` | Hard 1: 75 questions (72 + 3 unanswerable). Same schema. Categories: version-trap, behavior, agents, multi-hop, code, false-premise, unanswerable. |
| `evals/questions-v7-hard-2.json` | Hard 2: 93 questions (88 + 5 unanswerable) across ~25 doc pages. Extra fields: `topic`, `difficulty_predicted` (easy / medium / hard), and `snapshot_gap` on tel-07. `anc-01` and `anc-02` are anchors re-asking two facts that failed in hard 1. |
| `scripts/run-baseline.ts`, `scripts/judge.ts` | No-retrieval baseline + LLM judge. The judge picks the newest `baseline-*` or `rag-*` run, or takes a path. |
| `src/rag/prompt.ts` | RAG instructions and source formatting (with `kind`). Shared by the eval runner and the API. |
| `src/rag/citations.ts` | The one citation parser, used by the eval runner (`parseCitations`) and the web app (re-exported from `web/src/lib/citations.ts`). No imports, so it compiles under both tsconfigs. |
| `src/rag/retrieve.ts` | `RETRIEVAL` config (vector top 30 → rerank → top 8) and `retrieveMany()`: embeds all questions in one request, reranks 5 at a time, reports rerank latency/cost/fallbacks per question. Used by the eval runner and the API. |
| `src/retrieval/rerank.ts` | `rerankHits()`: OpenRouter Rerank API (the OpenRouter AI SDK provider has no reranking models). Never throws: retries timeouts, 429 and 5xx once, then falls back to the vector order and says why. |
| `scripts/experiment-rerank.ts` | Reranks each answerable question's vector top 30 and compares evidence@5/8/10, MRR, first-evidence rank, latency and cost. |
| `scripts/rank-of.ts` | Debug tool: rank of a question's evidence in vector and full-text top 50, plus the vector top 8. |
| `src/rag/models.ts` | The two models, `DEFAULT_MODEL` (Mistral), generation settings and provider options. |
| `scripts/run-rag.ts` | Same as `run-baseline.ts` plus retrieval. Extra fields per answer: sources (with kind and ✓ for evidence), `evidenceInSources`, citations, invalid citations, `citesEvidence`. Records the retrieval config and the question file in the run file. `--dry <id>` prints the prompt; `--questions <file>` picks the question set. |
| `src/lib/pool.ts` | Shared helper for running requests in parallel. |
| `src/api/server.ts` | Entry point: checks the key, creates the pg pool, builds the app, shuts down cleanly on SIGINT/SIGTERM. |
| `src/api/app.ts` | `buildApp()`: rate limiting, `/api/health`, `/api/ready`, static web app with SPA fallback, JSON 404 for unknown `/api/*`. |
| `src/api/chat.ts`, `src/api/types.ts` | `POST /api/chat` and the message metadata type shared with the web app. |
| `scripts/ask-api.ts` | CLI client for the API: prints the sources, the streamed answer and the metadata. |
| `web/` | React chat (own `package.json` and `tsconfig`). `src/lib/citations.ts` (re-exports the shared parser), `src/lib/highlight.ts` (code highlighting), `src/components/` (Answer, Sources, Composer, EmptyState). |
| `Dockerfile`, `.dockerignore` | Two stages: build the web app (copies `src/rag/citations.ts` in for it), then type-check and run the server with `tsx`. |
| `docker-compose.yml` | Local Postgres + pgvector on port 5432. |
| `README.md`, `docs/screenshot.png` | Public write-up with results, lessons and the live link. |
| `evals/baselines/` | **v5 (current):** `rag-v5-run1`, `rag-v5-run2` (+ judged), `experiment-rerank-v1`; harder sets: `rag-v5-hard1-run1` (+ judged), `rag-v5-hard2-run1` (+ judged). **v4:** `rag-v4-run1`, `rag-v4-run2` (+ judged). **v3:** `rag-v3-run1`, `rag-v3-run2` (+ judged), `experiment-retrieval-v1`. **v2:** `baseline-v2`, `rag-v2` (+ judged), `retrieval-v2`. **v1 (first 20 questions):** `baseline-v1`, `rag-v1` (+ judged), `retrieval-v1`. |

Corpus stats: 375 pages → 1,982 chunks, ~645k tokens (estimated), median chunk 256 tokens, p90 669. Embedding the whole corpus: 618k tokens, 51 s, ~$0.012.

## API

`POST /api/chat` with `{ messages, model }` (the `useChat` request body plus the model key).

1. Validates the body with zod and takes the last user message (single-turn, max 2,000 characters).
2. Retrieves the top 8 chunks with the same `RETRIEVAL` config as the evals.
3. Streams in the UI message stream protocol:
   - a `start` part with metadata (model),
   - the 8 sources as `source-url` parts (`sourceId` "1"–"8", matching the `[n]` numbers in the prompt), **before** the answer, so the UI can show them while the model writes,
   - the answer from `streamText`, merged with `toUIMessageStream({ sendStart: false })`,
   - final metadata: time, tokens, cost (OpenRouter's `usage: { include: true }`).
4. If the client disconnects, the model call is aborted (no paying for answers nobody reads).
5. Errors are logged on the server with details; the client gets a generic message.

Other routes:
- `/api/health` → `{ ok: true }` without touching the database (liveness; doesn't keep Neon awake).
- `/api/ready` → pings the database, 503 if it's down.

Protection for a public demo:
- `@fastify/rate-limit` on `/api/chat` only: 6 questions per minute per visitor (`CHAT_RATE_LIMIT`), with a readable message ("You've asked 6 questions in the last minute. Try again in …").
- `TRUST_PROXY=true` in production, so the limit keys on the visitor's IP and not on Render's proxy.
- pg pool: max 5 connections, idle connections closed after 60 s, and pool errors are logged instead of crashing the process (Neon closes idle connections when it suspends).

### Lesson: the stream hides model errors unless you ask for them

At first, a failed model call (e.g. a provider error from OpenRouter) reached the browser as "An error occurred." and nothing was logged. `toUIMessageStream` swallows errors by default; passing an `onError` that logs the real error and returns a generic message fixed both sides. `streamText` also gets `onError: () => {}` so the same error isn't logged twice.

## Web app

Vite 8, React 19, Tailwind 4, `useChat` with `DefaultChatTransport`.

- Each question is a heading with its answer below; the sources sit in a margin on desktop.
- The model is chosen in the header and sent with each request (`sendMessage(..., { body: { model } })`).
- Markdown via react-markdown. Code highlighting with lowlight and only 7 registered languages (bash, diff, javascript, json, shell, typescript, xml): highlight.js with every language had pushed the bundle to 733 kB.
- **Citations as footnotes:** each `[n]` becomes a small marker linked to source n. Pointing at a marker highlights the source; clicking scrolls to it. Adjacent markers form one group that never wraps apart (a word joiner before them, `nowrap` on the group).
- The source list says "Cited X of Y sources"; uncited sources are faded. On mobile only the cited ones are shown, with "Show all 8 sources".
- Source titles are cleaned up (backticks and "(2/3)" chunk counters removed).
- A meta line under each answer: model, seconds, tokens.
- Errors are shown under the answer with "Try again" (`regenerate`); rate-limit and other JSON error bodies are turned into readable text.
- Empty state: four example questions and a note that this is an unofficial project over a November 1, 2026 snapshot.

### Lesson: every model invents its own citation format

The prompt asks for `[n]` inline. In practice the answers contained:

| Format | Example | Handling |
|---|---|---|
| Inline, as asked | `…with isStepCount [3].` | Marker after the word |
| Several | `[4][7]`, `[1, 3]` | One group of markers |
| A paragraph of only citations | `[1][4]` on its own line | Rendered as a "Sources: 1, 4" line, not a stray "14" |
| Inside code, as a comment | `saveChat(...); // [2]` | Not linked (code stays code), but counted as cited |
| Double brackets | `[[2]][[3]]`, `[[2], [3]]` | Unwrapped first; otherwise rendered as "²]³]" |
| Not a citation | `arr[0]`, `fn()[1]`, `[text](url)` | Left alone |

Each format only showed up when someone asked the live demo a new kind of question. All of them are handled in one parser, `src/rag/citations.ts`, shared by the web app and the evals. Before the merge the evals had their own, older parser; tested against every format above, it differed only on code-comment citations (missed) and markdown links like `[1](url)` (wrongly counted), so earlier citation stats are barely affected. A stricter prompt ("cite only in prose, as [n]") would help, but it changes the prompt, so it needs a full eval rerun.

## Deployment

- **App:** Render free tier, one Docker web service built from the repo's `Dockerfile` and redeployed on every push to `main`.
  - Stage 1 builds `web/` into `web/dist`.
  - Stage 2 installs dependencies (including `tsx`, which runs the TypeScript server) and copies `src/`, `tsconfig.json` and `web/dist`.
  - `NODE_ENV=production`, `HOST=0.0.0.0`, `WEB_DIST=web/dist`, `TRUST_PROXY=true`; Render sets `PORT`. Runs as the `node` user.
  - Sleeps after 15 idle minutes; the first request after that takes about a minute.
- **Database:** Neon free plan, US East (personal account: the Vercel-managed Neon account couldn't create projects). Loaded with `db:migrate` + `embed` from the local machine. Suspends after 5 idle minutes; 100 CU-hours per month is far more than a demo needs.
- **Cost control:** the rate limit above, and the production OpenRouter key's own credit limit, which caps what the public demo can ever spend.

### Lesson: a broken import only showed up at runtime

The first deploy crashed with `ERR_MODULE_NOT_FOUND`: `server.ts` imported `'../../../../Downloads/app.js'`. WebStorm had written that path when the file was copied in from the Downloads folder. Locally it worked, because the file existed in Downloads; in the container it didn't. The Docker build runs `tsx` without a type check, so nothing caught it before startup. Fix: `import { buildApp } from './app.js'`. Prevention, now in place: the Docker build runs `tsc` on the server before it ships (`npm run typecheck` does the same locally for server + web). Inside the image only the repo's files exist, so an import like this fails the build instead of the live server. One catch: the image has `src/` but not `scripts/`, so TypeScript inferred a different source root than locally and newer versions require it to be explicit (TS5011). Fixed with `"rootDir": "."` in `tsconfig.json`, which also replaced a `"declaration": true` that did nothing under `noEmit`. (`"include"` had been inside `compilerOptions`, where it was ignored; moved to the top level.)

## Results v5 on harder sets (168 questions, 1 run each)

The v5 config is unchanged. Both sets were written with Claude from the live docs on 2026-11-06 (the snapshot is from 2026-11-01), and questions duplicating `ai-sdk-evals.json` were removed. Judge: `google/gemini-3.6-flash`.

| Set | Model | Correct | Not correct | Declined | Hallucinated | Cost | Avg latency |
|---|---|---|---|---|---|---|---|
| Hard 1 | Qwen | **70/72** | bh-14 (wrong), cd-01 (outdated) | 3/3 | 0 | $0.143 | 5.2 s |
| Hard 1 | Mistral | **71/72** | bh-14 (wrong) | 3/3 | 0 | $0.067 | 4.1 s |
| Hard 2 | Qwen | **84/87** | data-01, anc-01 (wrong), anc-02 (outdated) | 5/5 | 0 | $0.181 | 6.8 s |
| Hard 2 | Mistral | **83/87** | ui-02 (outdated), data-01, code-01, anc-01 (wrong) | 5/5 | 0 | $0.077 | 4.5 s |

- **Hard 1 is graded with the fixed references.** As first judged: Qwen 68/72, Mistral 69/72. The ag-02, ag-07 and ag-15 verdicts were reference errors (see the lesson below). After the fixes, all three are correct for both models.
- **Mistral's cd-01 is graded leniently.** Its v7 rewrite renames everything else but silently drops the `onStepFinish` callback. The judge graded that "acceptable" in the first pass and "correct" in the re-judge, the same leniency as q26 in v4. Counting it as a miss gives Mistral 70/72.
- **Hard 2 leaves out tel-07, a snapshot gap.** Its answer (the `gen_ai.client.inference.duration` metric and `MeterProvider`) is in the live docs but appears nowhere in `data/corpus`. Both models said the docs don't mention it, which is the faithful answer for this snapshot. With tel-07 counted: Qwen 84/88, Mistral 83/88. The question carries a `snapshot_gap` note.
- **data-01 was ambiguous.** A tool-part answer solves it too. It has since been rewritten to ask about custom data parts from `createUIMessageStream`, and the frozen run used the old wording.
- **The real misses are the same two facts in both sets.** First, v7 excludes request and response bodies by default (bh-14 / anc-01): the evidence wasn't retrieved in either set. Second, the `onStepFinish` → `onStepEnd` rename in a code rewrite (cd-01 / anc-02). For hard 1 the evidence was retrieved, and still Qwen kept `onStepFinish` and Mistral dropped the callback. For hard 2 the evidence wasn't retrieved. Mistral only: ui-02 recommended the removed `handleSubmit` / `input` / `setInput`, and code-01 forgot `sendSources: true`.
- **Evidence reached the sources** for 71/72 answerable questions in hard 1 (all but bh-14) and 83/88 in hard 2 (all but err-01, data-04, tel-07, anc-01, anc-02). Both models still answered err-01 and data-04 correctly, and Mistral answered anc-02 correctly. Rerank: 0 fallbacks, ~0.85 s average.
- **Models tie.** Under the judge they differ on 1 question in hard 1 and 3 in hard 2 (exact McNemar p = 1.0 both times).
- By category, hard 1: version-trap 44/44, multi-hop 14/14, false-premise 8/8, behavior 34/36, agents 28/28, code 13/14 (answers from both models).
- **Cost:** judging was $0.12 for hard 1 and $0.16 for hard 2, about half of each run's total. Unit costs from the OpenRouter log: judge ~$0.00086 per answer, Qwen ~$0.0014 (median 5.1 s), Mistral ~$0.00065 (median 3.1 s), rerank ~$0.0002 per question.

**Takeaway:** with the best config the bot answers about 97% of realistic docs questions, however they're phrased. The remaining misses come from retrieval competition between sections of the same page, not from question wording. Pushing accuracy lower would take contrived or ambiguous questions. So these sets are for comparing configurations through ablations (see Next steps), not for chasing the last few questions.

### Lesson: predicted difficulty didn't predict actual difficulty

Every hard-2 question was labeled easy / medium / hard before the run. Raw: hard 66/72 answers, medium 97/100, easy 14/14. But the "hard" failures are the two anchors (picked because they had already failed) and the snapshot gap. Without those three questions, "hard" scored 65/66, the same as medium. Tricky phrasing, false premises and version traps didn't hurt. What fails is a fact sitting in a chunk that loses to other sections of its own page. Difficulty here comes from competing chunks, not from phrasing.

### Lesson: the string check and the judge reached opposite conclusions

On hard 1 the `must_include` check passed Qwen on 69/72 and Mistral on 63/72. Mistral alone failed 6 questions and Qwen alone failed none: exact McNemar p = 0.03, a "significant" difference. The judge disagreed with the string check on 9 of the 144 answers and found the models tied (they differ only on cd-01, p = 1.0). Reading the 9 disagreements, the string check was mostly wrong. It failed correct paraphrases, and it flagged stale names that an answer mentions only to say they're deprecated. On hard 2 the two methods disagreed on 9 answers. A string check works as a cheap pre-filter and a pointer to cases worth a human look. It isn't a score to compare models on. That disagreement report goes into the eval framework.

### Lesson: the references were wrong again, once because the docs contradict themselves

Hard 1 had three bad references, all found by reading verdicts that looked wrong:
- **ag-07** (what `prepareStep` can return): the list was incomplete. The v7 migration guide also lists `instructions` and `runtimeContext`. Now marked as not exhaustive.
- **ag-15** (conditional tool approval): `needsApproval` was listed as stale, but it's correct for `WorkflowAgent`. Same mistake as q12 in v4.
- **ag-02** (`WorkflowAgent` default step limit): the docs disagree. The loop-control guide says there's no default limit; the `WorkflowAgent` reference says `generate()` defaults to 20 and `stream()` is unbounded. Qwen followed the reference page and was graded wrong. The reference now accepts either page.

Also: bh-07 dropped `finalStep` from `must_include`, because correct answers don't need it. This makes five reference fixes in total (q12, q16, ag-02, ag-07, ag-15), and in four of them the model knew a correct detail the reference didn't list. Hand-labeling the disputed verdicts and measuring agreement with the judge belongs in the framework.

## Results v5: reranking (35 questions, 2 runs)

Changes from v4: (1) the chunker fix below, (2) retrieval takes the vector top 30 and reranks them with `cohere/rerank-5-fast`, keeping the top 8. Prompt, models and settings unchanged.

| Model | Run | Correct | Declined (/6) | Hallucinated | Cost | Avg latency |
|---|---|---|---|---|---|---|
| Qwen | 1 | **29/29** | 6 | 0 | $0.051 | 6.2 s |
| Qwen | 2 | **29/29** | 6 | 0 | $0.050 | 7.1 s |
| Mistral | 1 | **29/29** | 6 | 0 | $0.029 | 4.0 s |
| Mistral | 2 | **29/29** | 6 | 0 | $0.028 | 3.8 s |

- **q27 correct in 4 of 4 answers** (v1–v4: never). Both models now answer `embedMany` + `maxParallelCalls`.
- Evidence reached the sources for 28 of 29 questions; the exception, q01, is answered correctly anyway.
- Reranking: $0.007 per run, avg 0.8–1.3 s per question, 0 fallbacks in both frozen runs. Input grew from ~3.1k to ~3.5k tokens per question (the reranker prefers somewhat longer chunks); answer cost is unchanged.
- Citations: no invented numbers; the cited source contains the evidence for 27–28 of 29 answers. Mistral left 1–2 answers uncited per run.
- **A third run was discarded:** with a single 10 s timeout, 10 of 35 rerank calls stalled and fell back to vector order. It still scored 29/29 (q27 wasn't among the fallbacks), but it didn't measure the reranker. That led to 2 attempts × 3 s (below); the replacement run had 0 fallbacks, with one call needing the retry (3.9 s).

### Rerank experiment (experiment-rerank-v1, 29 answerable questions)

Each question's vector top 30, reranked by `cohere/rerank-5-fast` (after the chunker fix):

| Order | @5 | @8 | @10 | MRR |
|---|---|---|---|---|
| vector | 0.78 | 0.91 | 0.93 | 0.71 |
| **reranked** | **0.97** | **0.97** | **0.97** | **0.97** |

- The first evidence chunk moved to rank 1 for 28 of 29 questions (q27: #12 → #1; q05, q13, q15, q30: #7–8 → #1). No question got worse. q01's evidence isn't in the top 30 either way.
- Cost ~$0.0002 per question. Latency usually 0.6–1.2 s, but 4 of 29 calls took 3.8–7.5 s.
- @5 = @8 after reranking, so top 5 would likely give the same answers with ~40% less context. Not tested end to end yet.

### Lesson: the miss was in the question, not the chunk

`rank-of` showed q27's answer at vector rank #12. The question, "I need to embed thousands of document chunks **for RAG**…", pulled seven "RAG Agent" cookbook chunks into the top 8: the embedding matched the topic of the question, not what it asked for. The single word "many" put the right chunk at #3. Embedding similarity measures topical overlap; a reranker reads the question and the passage together and judges whether the passage answers it. That fixed q27 and moved the evidence to rank 1 almost everywhere, for $0.0002 and ~1 s per question.

### Lesson: the chunker mislabeled every merged section

The first hypothesis for q27 was the chunk itself: "### Parallel Requests" was too short to stand alone, so the chunker merged it into the next section and labeled the chunk with that section's heading, "Settings > Retries", while the "Retries" heading was missing from the text. Fixed in `chunk-docs.ts` (a merged chunk is labeled by its first section, later headings stay inline): 703 of 1,982 chunks got new embedded text, 87 chunks lost a duplicated heading, and citation links now point to where a chunk starts. It didn't fix q27 and barely moved retrieval (vector @8 0.91 → 0.91, @5 0.81 → 0.78, MRR 0.72 → 0.71). It was kept because labels and links are now right. Measuring the hypothesis before building on it saved a wrong conclusion.

### Lesson: an external API in the request path needs a fallback and a short timeout

The reranker answered in ~1 s in one run and stalled for 10 s+ on a third of the calls six minutes later. `rerankHits` never throws: it retries timeouts, 429 and 5xx once with a 3 s limit each, then keeps the vector order. The eval runner records every fallback and warns at the start of the output, because a run with fallbacks doesn't measure the reranker.

## Results v4: source kinds (35 questions, 2 runs)

The one change from v3: every source carries `kind="guide|reference|cookbook|migration-guide|troubleshooting"`, and the instructions say guides and reference describe the current API, cookbook examples can lag behind, and when sources disagree the model should follow the guide or reference and mention the conflict. Retrieval, models and settings are unchanged.

| Model | Run | Correct | Not correct | Declined (/6) | Hallucinated | Cost | Avg latency |
|---|---|---|---|---|---|---|---|
| Qwen | 1 | **28/29** | q27 (wrong) | 6 | 0 | $0.051 | 5.6 s |
| Qwen | 2 | **28/29** | q27 (wrong) | 6 | 0 | $0.042 | 6.6 s |
| Mistral | 1 | **28/29** | q27 (acceptable) | 6 | 0 | $0.026 | 4.5 s |
| Mistral | 2 | **28/29** | q27 (wrong) | 6 | 0 | $0.027 | 4.1 s |

- **q12 fixed in 4 of 4 answers** (v3: 3 of 4 recommended the deprecated `needsApproval`). The stale cookbook page was still retrieved every time, now labeled `cookbook`, and no answer followed it.
- **The only miss is q27** (`maxParallelCalls`), the known retrieval failure (fixed in v5). Both models are now at the ceiling of what retrieval delivers.
- Input grew by ~100 tokens per question (3.1k); cost and latency are within v3's range.
- Citations: no invented numbers. Mistral answered 3 questions without any citation in run 1 (q09, q10, q33), none in run 2.
- Judged with the corrected q12 reference (below). Re-judging also flipped Mistral run 1 q26 from "acceptable" to "correct" without any change to that question: judge noise. In both runs Mistral's q26 answer omits `convertToModelMessages`, and the judge mostly accepts it, so it's arguably lenient there.

### Lesson: labels beat instructions about content

v3 already told the model to follow the sources, and it did: it followed the wrong source. It had no way to tell an outdated cookbook page from the current guide, because both looked like "a source". One attribute per source plus one sentence on how to rank them fixed it, at ~100 tokens. Metadata the pipeline already had (`kind` came from the URL path at chunking time) was worth putting in front of the model.

### Lesson: the reference was wrong again, in the same way as q16

Qwen's second q12 answer used `toolApproval` and then added "with `WorkflowAgent`, approval is set on the tool with `needsApproval`". That is exactly what the v7 guide says. The reference only said "`needsApproval` is deprecated in v7", so the judge graded it "outdated". The reference now says it is deprecated for `generateText` / `streamText` / `ToolLoopAgent` and still used with `WorkflowAgent`. Both v4 runs were re-judged with it. Two of the three reference fixes so far (q12, q16) were cases where the model knew a correct detail that the reference didn't list.

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
- Seen in the live demo too: an answer whose first example used an undefined `coreMessages` variable (a leftover of the AI SDK 3–4 `CoreMessage` name) next to a correct second example. 27/29 is not 29/29.

### Lesson: the docs can contradict themselves (fixed in v4)

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

- **All three sets are close to saturated** for v5 (100%, 97–99%, 95–97%). They can separate clearly worse configurations (ablations), not ones that differ by a question or two.
- **Two known retrieval misses:** the default exclusion of response bodies (bh-14 / anc-01) and `onStepFinish` → `onStepEnd` (cd-01 / anc-02). In both, other sections of the same page outrank the chunk with the answer.
- **Snapshot drift:** the live docs already have sections the 2026-11-01 snapshot lacks (tel-07, the telemetry Metrics section). Refreshing the snapshot means re-chunking, re-embedding and rerunning the evals.- **Reranker latency** varies: ~1 s typically, occasional stalls. Worst case adds ~6 s before falling back. Watch the API logs.
- **No keyword-style questions** in the evals (bare identifiers like `isStepCount`). That is where full-text search should help; add a few and rerun the experiment before ruling hybrid out for good.
- **Citation format isn't enforced.** A "cite only in prose" rule in the prompt would reduce the variety, but needs a full eval rerun.
- **Single-turn.** Follow-ups ("and for streamText?") are answered without the earlier question; multi-turn needs query rewriting before retrieval.
- **Mistral sometimes doesn't cite** (3 of 29 answers in v4 run 1, 1–2 in v5). The UI then shows no markers and fades all sources.
- **q26 grading is lenient:** Mistral's answers omit `convertToModelMessages` and are usually graded correct. Tighten the reference if it matters.
- Free-tier cold start: ~1 minute after 15 idle minutes (Render), plus Neon waking up.
- The judge flips on ~17% of borderline answers. Majority-of-3 judging would reduce it (~3× judge cost, ~$0.20 per run).
- Single runs are noisy (OpenRouter routing). v3–v5 have 2 runs each on the original set, the hard sets 1 run each. The eval framework will run N repetitions and report the range.
- Heading anchors in chunk URLs are an approximation of the site's slugs. Spot-check before relying on them for citations.
- Migration-guide chunks contain "before" (v6) code. Now labeled `migration-guide` in the prompt; if they still mislead, down-rank them in retrieval.
- Some page titles keep their YAML quotes (e.g. `"React error \"...\""`). The prompt strips them; fixing it at the source (`fetch-docs.ts`) means re-chunking and re-embedding.
- The RAG prompt says "version 7"; the baseline prompt said "latest version". Telling the model the version is part of what RAG provides, but say so when presenting the comparison.
- TODO in `judge.ts`: set `MIN_INTERVAL_MS` to 0 once the OpenRouter account is no longer "new".

## Next steps

Done: API, web chat, deployment, README, `.env` support; one shared citation parser; type check in the Docker build; v4 source kinds (q12); chunker labels fixed; v5 reranking (q27; 29/29 for both models); two harder eval sets (168 questions, ~97% for v5).

**Decision (2026-11-06):** stop improving the doc bot. It gets maintenance only. Next is the eval framework, then a GitHub PR code-review agent.

1. **Mini eval framework, in its own repo** (TypeScript), so it reads as a reusable tool. This bot is its first user.
   - **Boundary:** a target is a plain async function `(case) => { output, usage?, latencyMs?, context? }`. The framework knows nothing about RAG; the bot supplies an adapter like `makeRagTarget({ model, topK, rerank })`.
   - **Pieces:** datasets (id, question, reference, tags); scorers (LLM judge, `must_include`, citation check, retrieval evidence); a runner (targets × cases × N repetitions, concurrency, cache); reporters (CLI table, JSON, later HTML). Config is a TS file.
   - **Statistics:** pass rates with Wilson confidence intervals; paired comparison on the same cases (exact McNemar or bootstrap) that prints "significant" or "no detectable difference".
   - **Cost control:** cache target outputs and judge verdicts by hash; a dry-run cost estimate and `--max-cost`; an early-stop majority judge (2 calls, a 3rd only on disagreement, ~2.1 calls per answer).
   - **Reports:** cost split into generation vs judging, cost per correct answer, latency, per-tag breakdowns, and a string-check vs judge disagreement report.
   - **Judge calibration:** hand-label ~30 verdicts and report agreement. The disputed hard-1 verdicts (ag-02, ag-07, ag-15, cd-01) are the first labeled examples.
   - **First comparison:** the v5 config vs ablations on all 203 questions: no rerank, top 3 and top 5, hybrid vs vector-only, no retrieval, and the prompt without the "your knowledge is outdated" line. Optionally, a frontier model as a ceiling.
   - Budget: ~$20 on OpenRouter. A full 93-question run for both models plus judging costs ~$0.40.
2. **GitHub PR code-review agent.**

Doc bot maintenance, when needed:
- Refresh the snapshot (covers tel-07), then rerun all three sets.
- Top 5 instead of 8 after reranking (it's one of the ablations above).
- Multi-turn: rewrite follow-up questions into standalone ones before retrieval.
- "Cite only in prose, as [n]" in the prompt, if citation formats or Mistral's uncited answers become a problem. Needs a full rerun.
