import type pg from 'pg';
import { embedTexts } from '../embedding.js';
import { hybridSearch, type Hit, type HybridOptions } from '../retrieval/search.js';

export const RETRIEVAL = { topK: 5, candidates: 50, rrfK: 60 } as const;

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
