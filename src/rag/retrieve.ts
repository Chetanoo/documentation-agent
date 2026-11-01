import type pg from 'pg';
import { embedTexts } from '../embedding.js';
import { hybridSearch, type Hit, type HybridOptions } from '../retrieval/search.js';

// Chosen by scripts/experiment-retrieval.ts (2026-11-01, 29 questions): vector only with 8 chunks
// covered 0.91 of the evidence vs 0.78 for equal-weight hybrid with 5, at about the same context size.
// textWeight 0 skips full-text search; raise it (e.g. 0.1-0.25) to turn hybrid back on.
export const RETRIEVAL = { topK: 8, candidates: 50, rrfK: 60, textWeight: 0 } as const;

// Retrieves context for many questions with a single embedding request.
export async function retrieveMany(
  db: pg.Pool | pg.Client,
  questions: string[],
  { topK = RETRIEVAL.topK, ...opts }: HybridOptions & { topK?: number } = RETRIEVAL,
): Promise<{ hits: Hit[][]; embeddingTokens: number }> {
  const { embeddings, tokens } = await embedTexts(questions);
  const hits = await Promise.all(questions.map((q, i) => hybridSearch(db, q, embeddings[i]!, topK, opts)));
  return { hits, embeddingTokens: tokens };
}
