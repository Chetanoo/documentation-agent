import { readFile, writeFile, mkdir } from 'node:fs/promises';
import pg from 'pg';
import { DATABASE_URL, EMBEDDING } from '../src/config.js';
import { embedTexts } from '../src/embedding.js';
import { hybridSearch, textSearch, vectorSearch, type Hit } from '../src/retrieval/search.js';

const KS = [1, 3, 5, 10] as const;
const MAX_K = 10;
const HYBRID = { candidates: 50, rrfK: 60 };
const MODES = ['vector', 'text', 'hybrid'] as const;
type Mode = (typeof MODES)[number];

// A fact is a list of terms that must all appear in one chunk; "a|b" means either.
type Fact = string[];
type Question = { id: string; question: string; answerable: boolean; evidence?: Fact[] };

type ModeResult = {
  coverage: Record<number, number>; // share of facts with an evidence chunk in the top k
  rr: number; // 1 / rank of the first evidence chunk (0 if none in top MAX_K)
  top: { id: string; crumb: string; evidence: boolean; score: number }[];
};
type Result = { id: string; question: string } & Record<Mode, ModeResult>;

const supports = (content: string, fact: Fact) =>
  fact.every((term) => term.split('|').some((alt) => content.includes(alt)));

function score(hits: Hit[], facts: Fact[]): ModeResult {
  const isEvidence = hits.map((h) => facts.some((f) => supports(h.content, f)));
  const first = isEvidence.indexOf(true);
  return {
    coverage: Object.fromEntries(
      KS.map((k) => [k, facts.filter((f) => hits.slice(0, k).some((h) => supports(h.content, f))).length / facts.length]),
    ),
    rr: first === -1 ? 0 : 1 / (first + 1),
    top: hits.map((h, i) => ({ id: h.id, crumb: h.crumb, evidence: isEvidence[i]!, score: Number(Number(h.score).toFixed(4)) })),
  };
}

async function main() {
  const raw = JSON.parse(await readFile('evals/ai-sdk-evals.json', 'utf8'));
  const all: Question[] = raw.questions;
  // Unanswerable questions are scored at generation time (does the bot decline?), not here.
  const qs = all.filter((q): q is Question & { evidence: Fact[] } => q.answerable && !!q.evidence?.length);

  const { embeddings, tokens } = await embedTexts(qs.map((q) => q.question)); // one request for all questions

  const db = new pg.Pool({ connectionString: DATABASE_URL });
  const results: Result[] = [];
  try {
    for (const [i, q] of qs.entries()) {
      const emb = embeddings[i]!;
      results.push({
        id: q.id,
        question: q.question,
        vector: score(await vectorSearch(db, emb, MAX_K), q.evidence),
        text: score(await textSearch(db, q.question, MAX_K), q.evidence),
        hybrid: score(await hybridSearch(db, q.question, emb, MAX_K, HYBRID), q.evidence),
      });
    }
  } finally {
    await db.end();
  }

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const summary = Object.fromEntries(
    MODES.map((m) => [
      m,
      {
        ...Object.fromEntries(KS.map((k) => [`evidence@${k}`, mean(results.map((r) => r[m].coverage[k]!))])),
        mrr: mean(results.map((r) => r[m].rr)),
      },
    ]),
  );

  console.log(`${qs.length} answerable questions (of ${all.length}), embedding ${EMBEDDING.model}, ${tokens} query tokens\n`);
  console.table(
    Object.fromEntries(
      Object.entries(summary).map(([m, s]) => [m, Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.toFixed(2)]))]),
    ),
  );

  console.log('\nhybrid misses at k=5 (✓ = evidence chunk):');
  for (const r of results.filter((r) => r.hybrid.coverage[5]! < 1)) {
    console.log(`  ${r.id}  ${r.question}`);
    for (const h of r.hybrid.top.slice(0, 5)) console.log(`     ${h.evidence ? '✓' : ' '} ${h.crumb}`);
  }

  await mkdir('evals/runs', { recursive: true });
  const file = `evals/runs/retrieval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(file, JSON.stringify({ config: { embedding: EMBEDDING, hybrid: HYBRID, ks: KS }, summary, results }, null, 2));
  console.log(`\nsaved ${file}`);
}

main();
