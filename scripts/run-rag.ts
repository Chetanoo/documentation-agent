/**
 * RAG eval: same questions, models and settings as run-baseline.ts, but each question
 * gets the retrieved chunks (see RETRIEVAL in src/rag/retrieve.ts) as numbered sources. Retrieval is the only change.
 *
 * Run (from your own terminal):
 *   withsecrets npm run eval:rag                 -> full run, writes evals/runs/rag-<stamp>.json
 *   withsecrets npm run eval:rag -- --dry q04    -> print the prompt for one question, no LLM call
 *
 * Then grade it with the same judge:
 *   withsecrets npm run eval:judge -- evals/runs/rag-<stamp>.json
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { generateText } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { runPool } from '../src/lib/pool.js';
import { DATABASE_URL, EMBEDDING } from '../src/config.js';
import { RETRIEVAL, retrieveMany } from '../src/rag/retrieve.js';
import { RAG_INSTRUCTIONS, buildPrompt, parseCitations } from '../src/rag/prompt.js';
import type { Hit } from '../src/retrieval/search.js';

// Keep identical to run-baseline.ts so the comparison is fair.
const MODELS = ['qwen/qwen3.8-27b', 'mistralai/mistral-small-2603'];
const REASONING_MAX_TOKENS = 4000;
const MAX_OUTPUT_TOKENS = 12000;
const CONCURRENCY = 5;

type Fact = string[];
type Question = {
  id: string;
  category: string;
  answerable: boolean;
  question: string;
  expected_answer: string[];
  must_include: string[];
  stale_signals: string[];
  evidence?: Fact[];
};

type Status = 'pass' | 'fail' | 'truncated' | 'empty' | 'error' | 'unanswerable';

type Source = { n: number; id: string; crumb: string; url: string; evidence: boolean };

type RunResult = {
  model: string;
  id: string;
  answerable: boolean;
  status: Status;
  answer: string | null;
  finishReason: string | null;
  error: string | null;
  missing: string[];
  staleHits: string[];
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
  // RAG-only fields
  sources: Source[];
  evidenceInSources: boolean | null; // did retrieval deliver the answer? (null = no evidence defined)
  citations: number[];
  invalidCitations: number[]; // cited numbers that don't exist
  citesEvidence: boolean | null; // does at least one cited source contain the evidence?
};

// Same rule as eval-retrieval.ts: a fact's terms must all appear in one chunk; "a|b" = either.
const supports = (content: string, fact: Fact) =>
  fact.every((term) => term.split('|').some((alt) => content.includes(alt)));

function statusFor(q: Question, text: string, finishReason: string, missing: string[]): Status {
  if (finishReason === 'length') return 'truncated';
  if (text.trim() === '') return 'empty';
  if (!q.answerable) return 'unanswerable';
  return missing.length === 0 ? 'pass' : 'fail';
}

function sourcesFor(q: Question, hits: Hit[]): Source[] {
  return hits.map((h, i) => ({
    n: i + 1,
    id: h.id,
    crumb: h.crumb,
    url: h.url,
    evidence: !!q.evidence?.some((f) => supports(h.content, f)),
  }));
}

async function askOne(
  openrouter: ReturnType<typeof createOpenRouter>,
  modelId: string,
  q: Question,
  hits: Hit[],
): Promise<RunResult> {
  const sources = sourcesFor(q, hits);
  const hasEvidence = !!q.evidence?.length;
  const base = {
    model: modelId,
    id: q.id,
    answerable: q.answerable,
    sources,
    evidenceInSources: hasEvidence ? sources.some((s) => s.evidence) : null,
  };
  const start = performance.now();

  try {
    const result = await generateText({
      model: openrouter(modelId, { usage: { include: true } }),
      instructions: RAG_INSTRUCTIONS,
      prompt: buildPrompt(q.question, hits),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      temperature: 0,
      providerOptions: {
        openrouter: { reasoning: { max_tokens: REASONING_MAX_TOKENS } },
      },
    });

    const text = result.text;
    const finishReason = result.finalStep.finishReason;
    const missing = q.must_include.filter((s) => !text.includes(s));
    const citations = parseCitations(text);
    const cited = sources.filter((s) => citations.includes(s.n));
    const meta = result.finalStep.providerMetadata as { openrouter?: { usage?: { cost?: number } } } | undefined;

    return {
      ...base,
      status: statusFor(q, text, finishReason, missing),
      answer: text,
      finishReason,
      error: null,
      missing,
      staleHits: q.stale_signals.filter((s) => text.includes(s)),
      latencyMs: Math.round(performance.now() - start),
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
      reasoningTokens: result.usage.outputTokenDetails?.reasoningTokens ?? 0,
      costUsd: meta?.openrouter?.usage?.cost ?? null,
      citations,
      invalidCitations: citations.filter((n) => n < 1 || n > sources.length),
      citesEvidence: hasEvidence ? cited.some((s) => s.evidence) : null,
    };
  } catch (err) {
    return {
      ...base,
      status: 'error',
      answer: null,
      finishReason: null,
      error: err instanceof Error ? err.message : String(err),
      missing: q.must_include,
      staleHits: [],
      latencyMs: Math.round(performance.now() - start),
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      costUsd: null,
      citations: [],
      invalidCitations: [],
      citesEvidence: null,
    };
  }
}

function summarize(results: RunResult[]) {
  return MODELS.map((model) => {
    const rows = results.filter((r) => r.model === model);
    const answerable = rows.filter((r) => r.answerable);
    const count = (s: Status) => answerable.filter((r) => r.status === s).length;
    const valid = answerable.filter((r) => r.status === 'pass' || r.status === 'fail');
    const withStale = valid.filter((r) => r.staleHits.length > 0);
    const ok = rows.filter((r) => r.status !== 'error');
    const costs = rows.map((r) => r.costUsd).filter((c): c is number => c !== null);
    const checked = valid.filter((r) => r.citesEvidence !== null);

    return {
      model,
      'pass (of valid)': `${count('pass')}/${valid.length}`,
      truncated: count('truncated'),
      empty: count('empty'),
      errors: rows.filter((r) => r.status === 'error').length,
      'stale API hits': `${withStale.length}/${valid.length}`,
      'uncited answers': `${valid.filter((r) => r.citations.length === 0).length}/${valid.length}`,
      'cites evidence': `${checked.filter((r) => r.citesEvidence).length}/${checked.length}`,
      'bad citations': rows.reduce((s, r) => s + r.invalidCitations.length, 0),
      'avg latency (s)': ok.length ? +(ok.reduce((s, r) => s + r.latencyMs, 0) / ok.length / 1000).toFixed(1) : 0,
      'avg input tok': ok.length ? Math.round(ok.reduce((s, r) => s + r.inputTokens, 0) / ok.length) : 0,
      'cost ($)': costs.length ? +costs.reduce((s, c) => s + c, 0).toFixed(4) : 'n/a',
    };
  });
}

async function main() {
  const { questions } = JSON.parse(await readFile(path.resolve('evals/ai-sdk-evals.json'), 'utf8')) as {
    questions: Question[];
  };

  const dryIdx = process.argv.indexOf('--dry');
  const dryId = dryIdx === -1 ? null : process.argv[dryIdx + 1];
  const selected = dryId ? questions.filter((q) => q.id === dryId) : questions;
  if (dryId && selected.length === 0) throw new Error(`No question with id ${dryId}`);

  if (!process.env.OPENROUTER_API_KEY) {
    console.error('OPENROUTER_API_KEY is not set. Run via: withsecrets npm run eval:rag');
    process.exit(1);
  }
  const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });

  // Retrieval runs once per question and is shared by both models.
  const db = new pg.Pool({ connectionString: DATABASE_URL });
  let retrieved: Awaited<ReturnType<typeof retrieveMany>>;
  try {
    retrieved = await retrieveMany(db, selected.map((q) => q.question));
  } finally {
    await db.end();
  }
  const hitsById = new Map(selected.map((q, i) => [q.id, retrieved.hits[i]!]));

  if (dryId) {
    const q = selected[0]!;
    console.log(`=== INSTRUCTIONS ===\n${RAG_INSTRUCTIONS}\n\n=== PROMPT ===\n${buildPrompt(q.question, hitsById.get(q.id)!)}`);
    console.log('\n=== SOURCES ===');
    for (const s of sourcesFor(q, hitsById.get(q.id)!)) console.log(`[${s.n}] ${s.evidence ? '✓' : ' '} ${s.crumb}`);
    return;
  }

  const tasks = MODELS.flatMap((modelId) =>
    questions.map((q) => async () => {
      const r = await askOne(openrouter, modelId, q, hitsById.get(q.id)!);
      const detail =
        r.status === 'fail' ? ` missing: ${r.missing.join(', ')}` : r.status === 'error' ? ` ${r.error}` : '';
      const cite = r.answer ? `  cites ${r.citations.join(',') || '-'}${r.citesEvidence === false ? ' (no evidence)' : ''}` : '';
      console.log(`${modelId}  ${q.id}  ${r.status}${detail}${cite}`);
      return r;
    }),
  );

  const results = await runPool(tasks, CONCURRENCY);

  const outDir = path.resolve('evals/runs');
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `rag-${stamp}.json`);
  await writeFile(
    outFile,
    JSON.stringify(
      {
        models: MODELS,
        instructions: RAG_INSTRUCTIONS,
        settings: { REASONING_MAX_TOKENS, MAX_OUTPUT_TOKENS, temperature: 0 },
        retrieval: { ...RETRIEVAL, mode: RETRIEVAL.textWeight === 0 ? 'vector' : 'hybrid', embedding: EMBEDDING, embeddingTokens: retrieved.embeddingTokens },
        results,
      },
      null,
      2,
    ),
  );

  const retrievalMisses = questions.filter((q) => q.evidence?.length && !sourcesFor(q, hitsById.get(q.id)!).some((s) => s.evidence));
  console.log(`\nretrieval: evidence missing from sources for ${retrievalMisses.map((q) => q.id).join(', ') || 'none'}`);
  console.log('');
  console.table(summarize(results));
  console.log(`\nFull answers saved to ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
