/**
 * Where does retrieval put the evidence for a question? Prints the rank (within the top 50) of every
 * chunk that contains an evidence fact, for vector and full-text search, plus the vector top 8.
 * Use it to debug a retrieval miss and to try rephrasings of the same question.
 *
 *   withsecrets npm run rank '--' q27
 *   withsecrets npm run rank '--' q27 "How do I limit parallel requests in embedMany?"
 *   withsecrets npm run rank '--' "any question" --term embedMany,maxParallelCalls
 *
 * Ids (q27) use the question text and its evidence from the eval set. Free-text queries use the evidence
 * of the first id given, or --term (comma-separated terms that must all appear in one chunk).
 * One embedding request for all queries, no LLM calls.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { DATABASE_URL } from '../src/config.js';
import { embedTexts } from '../src/embedding.js';
import { textSearch, vectorSearch, type Hit } from '../src/retrieval/search.js';

const DEPTH = 50;
const SHOW_TOP = 8;

type Fact = string[];
type Question = { id: string; question: string; evidence?: Fact[] };

// Same rule as eval-retrieval.ts: a fact's terms must all appear in one chunk; "a|b" = either.
const supports = (content: string, fact: Fact) =>
  fact.every((term) => term.split('|').some((alt) => content.includes(alt)));

const hasEvidence = (h: Hit, facts: Fact[]) => facts.some((f) => supports(h.content, f));

function evidenceRanks(hits: Hit[], facts: Fact[]): string {
  const found = hits.flatMap((h, i) => (hasEvidence(h, facts) ? [`#${i + 1} ${h.crumb}`] : []));
  return found.length ? found.join('\n            ') : `not in top ${DEPTH}`;
}

async function main() {
  const args = process.argv.slice(2);
  const termIdx = args.indexOf('--term');
  const termFact: Fact | null = termIdx === -1 ? null : (args[termIdx + 1] ?? '').split(',').filter(Boolean);
  const rest = termIdx === -1 ? args : args.filter((_, i) => i !== termIdx && i !== termIdx + 1);
  if (rest.length === 0) {
    console.error('Usage: npm run rank -- <q-id | "question"> ... [--term a,b]');
    process.exit(1);
  }

  const { questions } = JSON.parse(await readFile(path.resolve('evals/ai-sdk-evals.json'), 'utf8')) as {
    questions: Question[];
  };
  const byId = new Map(questions.map((q) => [q.id, q]));

  const firstId = rest.find((a) => byId.has(a));
  const defaultFacts: Fact[] = termFact ? [termFact] : (firstId ? byId.get(firstId)?.evidence : undefined) ?? [];
  if (defaultFacts.length === 0) {
    console.error('No evidence to look for: pass a question id that has evidence, or --term.');
    process.exit(1);
  }

  const queries = rest.map((a) => {
    const q = byId.get(a);
    return q ? { label: q.id, text: q.question, facts: termFact ? [termFact] : q.evidence ?? defaultFacts } : { label: 'text', text: a, facts: defaultFacts };
  });

  const db = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    const { embeddings } = await embedTexts(queries.map((q) => q.text));
    for (const [i, q] of queries.entries()) {
      const [vec, txt] = await Promise.all([vectorSearch(db, embeddings[i]!, DEPTH), textSearch(db, q.text, DEPTH)]);
      console.log(`\n[${q.label}] ${q.text}`);
      console.log(`  looking for: ${q.facts.map((f) => f.join(' + ')).join('  OR  ')}`);
      console.log(`  vector:   ${evidenceRanks(vec, q.facts)}`);
      console.log(`  text:     ${evidenceRanks(txt, q.facts)}`);
      console.log(`  vector top ${SHOW_TOP}:`);
      for (const [j, h] of vec.slice(0, SHOW_TOP).entries())
        console.log(`    ${String(j + 1).padStart(2)} ${hasEvidence(h, q.facts) ? '✓' : ' '} ${h.kind.padEnd(15)} ${h.crumb}`);
    }
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
