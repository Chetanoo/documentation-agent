import type pg from 'pg';

export type Hit = {
  id: string;
  path: string;
  url: string;
  crumb: string;
  kind: string;
  content: string;
  score: number;
};

const COLS = 'id, path, url, crumb, kind, content';

// Nearest chunks by cosine distance (uses the HNSW index). score = cosine similarity.
export async function vectorSearch(db: pg.Pool | pg.Client, embedding: number[], k: number): Promise<Hit[]> {
  const { rows } = await db.query<Hit>(
    `select ${COLS}, 1 - (embedding <=> $1::vector) as score
     from chunks order by embedding <=> $1::vector limit $2`,
    [JSON.stringify(embedding), k],
  );
  return rows;
}

// Full-text search. Questions are natural language, so terms are OR-ed (websearch_to_tsquery would AND
// every word and match almost nothing). Lexemes come from the same 'english' config as the index and are
// cast with ::tsquery so they aren't re-parsed. ts_rank_cd rewards chunks matching more and rarer terms,
// and the title/section weight (A) beats body text (B).
export async function textSearch(db: pg.Pool | pg.Client, query: string, k: number): Promise<Hit[]> {
  const { rows } = await db.query<Hit>(
    `with q as (
       select (select string_agg(quote_literal(l), ' | ')
               from unnest(tsvector_to_array(to_tsvector('english', $1))) l)::tsquery as tsq
     )
     select ${COLS}, ts_rank_cd(tsv, q.tsq) as score
     from chunks, q
     where q.tsq is not null and tsv @@ q.tsq
     order by score desc limit $2`,
    [query, k],
  );
  return rows;
}

// Reciprocal rank fusion: score = sum over lists of weight / (rrfK + rank). Only ranks matter,
// so the incomparable scores of the two searches never have to be normalized.
// weights[i] defaults to 1; a weight of 0 ignores that list entirely.
export function rrf(lists: Hit[][], k: number, rrfK = 60, weights: number[] = []): Hit[] {
  const fused = new Map<string, Hit>();
  lists.forEach((list, li) => {
    const w = weights[li] ?? 1;
    if (w === 0) return;
    list.forEach((hit, i) => {
      const prev = fused.get(hit.id);
      fused.set(hit.id, { ...hit, score: (prev?.score ?? 0) + w / (rrfK + i + 1) });
    });
  });
  return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, k);
}

// textWeight scales full-text results relative to vector results (1 = equal, 0 = vector only).
export type HybridOptions = { candidates?: number; rrfK?: number; textWeight?: number };

export async function hybridSearch(
  db: pg.Pool | pg.Client,
  query: string,
  embedding: number[],
  k: number,
  { candidates = 50, rrfK = 60, textWeight = 1 }: HybridOptions = {},
): Promise<Hit[]> {
  const [vec, txt] = await Promise.all([
    vectorSearch(db, embedding, candidates),
    textWeight === 0 ? Promise.resolve([]) : textSearch(db, query, candidates),
  ]);
  return rrf([vec, txt], k, rrfK, [1, textWeight]);
}
