/**
 * Does a reranker fix what vector search ranks too low? For each answerable eval question:
 * vector top N candidates → Cohere Rerank (via OpenRouter) → compare evidence@k and MRR with plain vector order.
 *
 *   withsecrets npm run experiment:rerank                 -> rerank-5-fast, 30 candidates
 *   withsecrets npm run experiment:rerank '--' --pro      -> rerank-5-pro instead
 *
 * One embedding request plus one rerank request per question (~29). Saves evals/runs/experiment-rerank-<stamp>.json.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { DATABASE_URL } from '../src/config.js';
import { embedTexts } from '../src/embedding.js';
import { vectorSearch, type Hit } from '../src/retrieval/search.js';
import { runPool } from '../src/lib/pool.js';

const CANDIDATES = 30;
const KS = [5, 8, 10] as const;
const MODEL = process.argv.includes('--pro') ? 'cohere/rerank-5-pro' : 'cohere/rerank-5-fast';
const RERANK_URL = 'https://openrouter.ai/api/v1/rerank';

type Fact = string[];
type Question = { id: string; question: string; answerable: boolean; evidence?: Fact[] };

// Same rule as eval-retrieval.ts: a fact's terms must all appear in one chunk; "a|b" = either.
const supports = (content: string, fact: Fact) =>
  fact.every((term) => term.split('|').some((alt) => content.includes(alt)));

// Share of the question's facts found in the top k chunks.
const coverage = (hits: Hit[], facts: Fact[], k: number) =>
  facts.filter((f) => hits.slice(0, k).some((h) => supports(h.content, f))).length / facts.length;

// 1 / rank of the first chunk that supports any fact (0 if none).
const reciprocalRank = (hits: Hit[], facts: Fact[]) => {
  const i = hits.findIndex((h) => facts.some((f) => supports(h.content, f)));
  return i === -1 ? 0 : 1 / (i + 1);
};

const firstEvidenceRank = (hits: Hit[], facts: Fact[]) => {
  const i = hits.findIndex((h) => facts.some((f) => supports(h.content, f)));
  return i === -1 ? null : i + 1;
};

type RerankResponse = { results?: { index: number; relevance_score: number }[]; usage?: { cost?: number } };

async function rerank(query: string, hits: Hit[]): Promise<{ hits: Hit[]; cost: number | null }> {
  const res = await fetch(RERANK_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      query,
      // Same text the embeddings were made from: "Title > Section" + content.
      documents: hits.map((h) => `${h.crumb}\n\n${h.content}`),
      top_n: hits.length,
    }),
  });
  if (!res.ok) throw new Error(`rerank ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as RerankResponse;
  if (!body.results) throw new Error(`rerank: unexpected response ${JSON.stringify(body).slice(0, 300)}`);
  return { hits: body.results.map((r) => hits[r.index]!), cost: body.usage?.cost ?? null };
}

const avg = (xs: number[]) => +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2);

async function main() {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('OPENROUTER_API_KEY is not set. Run via: withsecrets npm run experiment:rerank');
    process.exit(1);
  }
  const { questions } = JSON.parse(await readFile(path.resolve('evals/ai-sdk-evals.json'), 'utf8')) as {
    questions: Question[];
  };
  const selected = questions.filter((q) => q.answerable && q.evidence?.length);

  const db = new pg.Pool({ connectionString: DATABASE_URL });
  let rows;
  try {
    const { embeddings } = await embedTexts(selected.map((q) => q.question));
    rows = await runPool(
      selected.map((q, i) => async () => {
        const facts = q.evidence!;
        const vector = await vectorSearch(db, embeddings[i]!, CANDIDATES);
        const start = performance.now();
        const reranked = await rerank(q.question, vector);
        const ms = Math.round(performance.now() - start);
        const row = {
          id: q.id,
          vectorRank: firstEvidenceRank(vector, facts),
          rerankRank: firstEvidenceRank(reranked.hits, facts),
          vector: Object.fromEntries(KS.map((k) => [k, coverage(vector, facts, k)])),
          reranked: Object.fromEntries(KS.map((k) => [k, coverage(reranked.hits, facts, k)])),
          vectorRR: reciprocalRank(vector, facts),
          rerankRR: reciprocalRank(reranked.hits, facts),
          rerankMs: ms,
          cost: reranked.cost,
          rerankedTop: reranked.hits.slice(0, 8).map((h) => ({ id: h.id, crumb: h.crumb, evidence: facts.some((f) => supports(h.content, f)) })),
        };
        console.log(`${q.id}  first evidence: vector #${row.vectorRank ?? '-'}  →  reranked #${row.rerankRank ?? '-'}  (${ms} ms)`);
        return row;
      }),
      5,
    );
  } finally {
    await db.end();
  }

  const summary = ['vector', 'reranked'].map((name) => {
    const cov = (k: number) => avg(rows.map((r) => (name === 'vector' ? r.vector : r.reranked)[k]!));
    return {
      config: name === 'vector' ? `vector top ${CANDIDATES} order` : `${MODEL}`,
      '@5': cov(5),
      '@8': cov(8),
      '@10': cov(10),
      mrr: avg(rows.map((r) => (name === 'vector' ? r.vectorRR : r.rerankRR))),
    };
  });

  const changed = rows.filter((r) => r.vector[8] !== r.reranked[8]);
  const costs = rows.map((r) => r.cost).filter((c): c is number => c !== null);
  console.log('');
  console.table(summary);
  console.log(`\n@8 changed: ${changed.map((r) => `${r.id} ${r.vector[8]}→${r.reranked[8]}`).join(', ') || 'none'}`);
  console.log(`still missing @8 after rerank: ${rows.filter((r) => r.reranked[8]! < 1).map((r) => r.id).join(', ') || 'none'}`);
  console.log(`rerank latency: avg ${Math.round(avg(rows.map((r) => r.rerankMs)))} ms, max ${Math.max(...rows.map((r) => r.rerankMs))} ms`);
  console.log(`rerank cost: ${costs.length ? `$${costs.reduce((a, b) => a + b, 0).toFixed(4)}` : 'not reported (check the OpenRouter activity page)'}`);

  const outDir = path.resolve('evals/runs');
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, `experiment-rerank-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await writeFile(outFile, JSON.stringify({ model: MODEL, candidates: CANDIDATES, summary, rows }, null, 2));
  console.log(`\nSaved to ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
