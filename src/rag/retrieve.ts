import type pg from 'pg';
import { embedTexts } from '../embedding.js';
import { runPool } from '../lib/pool.js';
import { hybridSearch, type Hit, type HybridOptions } from '../retrieval/search.js';
import { rerankHits, type RerankInfo } from '../retrieval/rerank.js';

export type RetrievalConfig = HybridOptions & {
  topK: number;
  rerankModel: string | null; // null = keep the vector order
  rerankCandidates: number; // how many vector results the reranker reorders
  rerankTimeoutMs: number; // per attempt
  rerankAttempts: number; // after the last failed attempt, fall back to the vector order
};

// Vector only, top 8: chosen by scripts/experiment-retrieval.ts (2026-11-01): 0.91 of the evidence vs 0.78
// for equal-weight hybrid with 5. textWeight 0 skips full-text search; raise it (0.1-0.25) for hybrid.
// Rerank: chosen by scripts/experiment-rerank.ts (2026-11-05): reranking the vector top 30 put the first
// evidence chunk at rank 1 for 28 of 29 questions; evidence@8 0.91 → 0.97 (q27 found at last).
export const RETRIEVAL: RetrievalConfig = {
  topK: 8,
  candidates: 50,
  rrfK: 60,
  textWeight: 0,
  rerankModel: 'cohere/rerank-5-fast',
  rerankCandidates: 30,
  // Typical calls take 0.6-1.4 s; in one run 10 of 35 stalled past 10 s. Two short attempts cap the
  // added wait at ~6 s, and a failure only means the vector order (v4 quality) for that question.
  rerankTimeoutMs: 3_000,
  rerankAttempts: 2,
};

// Retrieves context for many questions with a single embedding request.
export async function retrieveMany(
  db: pg.Pool | pg.Client,
  questions: string[],
  config: RetrievalConfig = RETRIEVAL,
): Promise<{ hits: Hit[][]; embeddingTokens: number; rerank: (RerankInfo | null)[] }> {
  const { topK, rerankModel, rerankCandidates, rerankTimeoutMs, rerankAttempts } = config;
  const { embeddings, tokens } = await embedTexts(questions);

  const results = await runPool(
    questions.map((q, i) => async () => {
      const pool = await hybridSearch(db, q, embeddings[i]!, rerankModel ? rerankCandidates : topK, config);
      if (!rerankModel) return { hits: pool, rerank: null };
      const r = await rerankHits(q, pool, { model: rerankModel, timeoutMs: rerankTimeoutMs, attempts: rerankAttempts });
      return { hits: r.hits.slice(0, topK), rerank: r.info };
    }),
    5,
  );

  return { hits: results.map((r) => r.hits), embeddingTokens: tokens, rerank: results.map((r) => r.rerank) };
}
