/**
 * Retrieval experiment: scores several retrieval configurations on the same questions.
 *
 * Each question is embedded once (one request for all), and its top-N vector and full-text
 * candidates are fetched once. Every configuration is then computed in memory from those
 * two lists, so all variants are compared on identical data.
 *
 * Run:
 *   withsecrets npm run experiment:retrieval
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import pg from 'pg';
import { DATABASE_URL, EMBEDDING } from '../src/config.js';
import { embedTexts } from '../src/embedding.js';
import { rrf, textSearch, vectorSearch, type Hit } from '../src/retrieval/search.js';

const CANDIDATES = 50; // per search, same as hybridSearch's default
const RRF_K = 60;
const KS = [5, 8, 10] as const;

// The configurations to compare. textWeight scales full-text relative to vector in RRF.
type Config = { name: string; mode: 'vector' | 'text' | 'fused'; textWeight?: number };
const CONFIGS: Config[] = [
  { name: 'vector only', mode: 'vector' },
  { name: 'text only', mode: 'text' },
  { name: 'rrf text×1 (current)', mode: 'fused', textWeight: 1 },
  { name: 'rrf text×0.5', mode: 'fused', textWeight: 0.5 },
  { name: 'rrf text×0.25', mode: 'fused', textWeight: 0.25 },
  { name: 'rrf text×0.1', mode: 'fused', textWeight: 0.1 },
];

// A fact is a list of terms that must all appear in one chunk; "a|b" means either.
type Fact = string[];
type Question = { id: string; question: string; answerable: boolean; evidence?: Fact[] };

const supports = (content: string, fact: Fact) =>
  fact.every((term) => term.split('|').some((alt) => content.includes(alt)));

const coverage = (hits: Hit[], facts: Fact[], k: number) =>
  facts.filter((f) => hits.slice(0, k).some((h) => supports(h.content, f))).length / facts.length;

const reciprocalRank = (hits: Hit[], facts: Fact[]) => {
  const i = hits.findIndex((h) => facts.some((f) => supports(h.content, f)));
  return i === -1 ? 0 : 1 / (i + 1);
};

const estTokens = (hits: Hit[]) => hits.reduce((s, h) => s + Math.ceil(h.content.length / 4), 0);

function rank(c: Config, vec: Hit[], txt: Hit[], k: number): Hit[] {
  if (c.mode === 'vector') return vec.slice(0, k);
  if (c.mode === 'text') return txt.slice(0, k);
  return rrf([vec, txt], k, RRF_K, [1, c.textWeight ?? 1]);
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const fmt = (x: number) => x.toFixed(2);

async function main() {
  const { questions } = JSON.parse(await readFile('evals/ai-sdk-evals.json', 'utf8')) as { questions: Question[] };
  const qs = questions.filter((q): q is Question & { evidence: Fact[] } => q.answerable && !!q.evidence?.length);

  const { embeddings, tokens } = await embedTexts(qs.map((q) => q.question));

  const db = new pg.Pool({ connectionString: DATABASE_URL });
  const lists: { vec: Hit[]; txt: Hit[] }[] = [];
  try {
    for (const [i, q] of qs.entries()) {
      const [vec, txt] = await Promise.all([
        vectorSearch(db, embeddings[i]!, CANDIDATES),
        textSearch(db, q.question, CANDIDATES),
      ]);
      lists.push({ vec, txt });
    }
  } finally {
    await db.end();
  }

  const maxK = Math.max(...KS);
  // per config, per question: coverage at each k, reciprocal rank, context tokens at each k
  const perConfig = CONFIGS.map((c) => {
    const rows = qs.map((q, i) => {
      const hits = rank(c, lists[i]!.vec, lists[i]!.txt, maxK);
      return {
        id: q.id,
        coverage: Object.fromEntries(KS.map((k) => [k, coverage(hits, q.evidence, k)])) as Record<number, number>,
        rr: reciprocalRank(hits, q.evidence),
        tokens: Object.fromEntries(KS.map((k) => [k, estTokens(hits.slice(0, k))])) as Record<number, number>,
        top: hits.map((h) => ({ id: h.id, crumb: h.crumb, evidence: q.evidence.some((f) => supports(h.content, f)) })),
      };
    });
    return { config: c, rows };
  });

  const isNew = (id: string) => Number(id.slice(1)) >= 21; // q21+ written from the regular docs
  const groups: [string, (id: string) => boolean][] = [
    ['all', () => true],
    ['old q01-q20', (id) => !isNew(id)],
    ['new q21+', isNew],
  ];

  const summary = perConfig.map(({ config, rows }) => {
    const s: Record<string, string | number> = { config: config.name };
    for (const [g, sel] of groups) {
      const r = rows.filter((x) => sel(x.id));
      for (const k of KS) s[`${g} @${k}`] = Number(fmt(mean(r.map((x) => x.coverage[k]!))));
    }
    s['mrr'] = Number(fmt(mean(rows.map((x) => x.rr))));
    for (const k of [5, 8] as const) s[`ctx tok @${k}`] = Math.round(mean(rows.map((x) => x.tokens[k]!)));
    return s;
  });

  console.log(`${qs.length} answerable questions, ${EMBEDDING.model}, ${tokens} query tokens, ${CANDIDATES} candidates per search\n`);
  const pick = (keys: string[]) =>
    summary.map((s) => Object.fromEntries([['config', s.config], ...keys.map((k) => [k, s[k]])]));
  console.log('Evidence coverage, all questions:');
  console.table(pick(['all @5', 'all @8', 'all @10', 'mrr', 'ctx tok @5', 'ctx tok @8']));
  console.log('By question set:');
  console.table(pick(['old q01-q20 @5', 'new q21+ @5', 'old q01-q20 @8', 'new q21+ @8']));

  // Which questions each config misses at k=5 and k=8: shows whether a gain is real or a swap.
  console.log('Misses (coverage < 1) per config:');
  for (const { config, rows } of perConfig) {
    const miss = (k: number) => rows.filter((r) => r.coverage[k]! < 1).map((r) => r.id).join(' ') || '-';
    console.log(`  ${config.name.padEnd(22)} @5: ${miss(5)}`);
    console.log(`  ${''.padEnd(22)} @8: ${miss(8)}`);
  }

  await mkdir('evals/runs', { recursive: true });
  const file = `evals/runs/experiment-retrieval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(
    file,
    JSON.stringify({ embedding: EMBEDDING, candidates: CANDIDATES, rrfK: RRF_K, ks: KS, summary, perConfig }, null, 2),
  );
  console.log(`\nsaved ${file}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
