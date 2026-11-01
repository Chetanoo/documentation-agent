# Progress

_Last updated: 2026-10-30_

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
- **Ingestion source:** every docs page is available as Markdown at `<url>.md`, and `/llms.txt` indexes all pages.
- **Models:** via OpenRouter ($10 credit limit).
  - Contestants: `qwen/qwen3.8-27b`, `mistralai/mistral-small-2603`
  - Judge: `google/gemini-3.6-flash` (a third model family)
- **LLM client:** the AI SDK itself, with `@openrouter/ai-sdk-provider`.
- **Planned stack:** Postgres + pgvector, hybrid search (full-text + vector, merged with reciprocal rank fusion), chunking by headings, SSE streaming.

## Secrets setup (done)

- The OpenRouter key lives in Bitwarden Secrets Manager.
- The machine-account token is stored outside the repo.
- A PowerShell profile function `withsecrets` sets the token, runs `bws run`, and removes the token afterwards:
  ```powershell
  withsecrets npm run <script>
  ```
- `.claude/settings.json` denies reads of `.env*` and the secrets folder, and denies `bws`.
- Environment: Windows, WebStorm, PowerShell 5.1.

## Repo contents

| Path | What it is |
|---|---|
| `evals/ai-sdk-evals.json` | 20 questions (16 answerable, 4 unanswerable). Each has `expected_answer`, `must_include`, `stale_signals`, `sources`. |
| `scripts/run-baseline.ts` | Asks each model the questions with no retrieval. Reasoning capped at 4k tokens, total output 12k, 5 calls in parallel. Writes to `evals/runs/` (gitignored). |
| `scripts/judge.ts` | Grades answers as correct / acceptable / outdated / wrong; unanswerable ones as declined / hallucinated. Uses `Output.object`. Throttled under 20 requests/min. |
| `src/lib/pool.ts` | Shared helper for running requests in parallel. |
| `evals/baselines/baseline-v1.json` (+ judged file) | The official "before" snapshot. |

Known gaps:
- 13 of the 16 answerable questions come from the v6/v7 migration guides. Need more on tool calling, embeddings, chat persistence and MCP.
- TODO in `judge.ts`: set `MIN_INTERVAL_MS` to 0 once the OpenRouter account is no longer "new".

## Baseline results (no retrieval)

| Model | Correct | Acceptable | Outdated | Wrong | Declined (/4) | Hallucinated |
|---|---|---|---|---|---|---|
| Qwen 3.8 27B | 0 | 0 | 8 | 8 | 2 | 2 |
| Mistral Small 4 | 2 | 1 | 4 | 9 | 3 | 1 |

- Qwen gives outdated v4/v5 code. Mistral invents APIs.
- Qwen costs about 6× more and is 2.5× slower.
- The judge is calibrated but slightly lenient on invented side details.

## Next steps

1. Commit `evals/baselines/` if not done yet.
2. **Ingestion:** fetch pages via `llms.txt` and `.md` URLs → chunk by headings with metadata (URL, section path) → embed → pgvector.
3. **Measure retrieval alone first:** recall@k against each question's expected sources, before writing any generation code.
4. Generation with citations.
5. RAG eval run (the "after" numbers).
6. Web UI.
7. Deployment.
