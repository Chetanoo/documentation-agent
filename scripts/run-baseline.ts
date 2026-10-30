/**
 * Baseline eval: asks each model the eval questions WITHOUT any retrieval,
 * so we can later compare against the RAG pipeline.
 *
 * Run (from your own terminal, not the agent's):
 *   withsecrets npm run eval:baseline
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateText } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { runPool } from '../src/lib/pool.js';

// Pin exact model IDs so runs are reproducible. Check them on openrouter.ai/models.
const MODELS = ['qwen/qwen3.8-27b', 'mistralai/mistral-small-2603'];

// Token budget. Reasoning is capped so the model always has room left for the
// visible answer; maxOutputTokens covers reasoning + answer together.
const REASONING_MAX_TOKENS = 4000;
const MAX_OUTPUT_TOKENS = 12000;

// How many requests run at the same time.
const CONCURRENCY = 5;

// Neutral prompt: no version hints, no docs. This is what "the model alone" knows.
const INSTRUCTIONS = `You are an expert on the Vercel AI SDK (the "ai" npm package), latest version.
Answer the developer's question concisely, with a short TypeScript example when useful.
If you are not sure or don't have the information, say so instead of guessing.`;

type Question = {
  id: string;
  category: string;
  answerable: boolean;
  question: string;
  expected_answer: string[];
  must_include: string[];
  stale_signals: string[];
};

type Status = 'pass' | 'fail' | 'truncated' | 'empty' | 'error' | 'unanswerable';

type RunResult = {
  model: string;
  id: string;
  answerable: boolean;
  status: Status;
  answer: string | null;
  finishReason: string | null;
  error: string | null;
  missing: string[]; // must_include items not found in the answer
  staleHits: string[]; // outdated APIs found in the answer (verify with judge later)
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
};

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error('OPENROUTER_API_KEY is not set. Run via: withsecrets npm run eval:baseline');
  process.exit(1);
}

const openrouter = createOpenRouter({ apiKey });

function statusFor(q: Question, text: string, finishReason: string, missing: string[]): Status {
  // A cut-off or empty answer is a run problem, not a knowledge gap, so it's
  // counted separately instead of as a failure (otherwise the baseline looks
  // worse than it really is and the RAG improvement gets inflated).
  if (finishReason === 'length') return 'truncated';
  if (text.trim() === '') return 'empty';
  if (!q.answerable) return 'unanswerable';
  return missing.length === 0 ? 'pass' : 'fail';
}

async function askOne(modelId: string, q: Question): Promise<RunResult> {
  const base = { model: modelId, id: q.id, answerable: q.answerable };
  const start = performance.now();

  try {
    const result = await generateText({
      // usage.include asks OpenRouter to return the real cost of each call
      model: openrouter(modelId, { usage: { include: true } }),
      instructions: INSTRUCTIONS,
      prompt: q.question,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      temperature: 0,
      providerOptions: {
        // Ignored by models that don't reason.
        openrouter: { reasoning: { max_tokens: REASONING_MAX_TOKENS } },
      },
    });

    const text = result.text;
    const finishReason = result.finalStep.finishReason;
    const missing = q.must_include.filter((s) => !text.includes(s));
    const meta = result.finalStep.providerMetadata as
        | { openrouter?: { usage?: { cost?: number } } }
        | undefined;

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

    return {
      model,
      'pass (of valid)': `${count('pass')}/${valid.length}`,
      truncated: count('truncated'),
      empty: count('empty'),
      errors: rows.filter((r) => r.status === 'error').length,
      'stale API hits': `${withStale.length}/${valid.length}`,
      'avg latency (s)': ok.length
          ? +(ok.reduce((s, r) => s + r.latencyMs, 0) / ok.length / 1000).toFixed(1)
          : 0,
      'reasoning tok': rows.reduce((s, r) => s + r.reasoningTokens, 0),
      'cost ($)': costs.length ? +costs.reduce((s, c) => s + c, 0).toFixed(4) : 'n/a',
    };
  });
}

async function main() {
  const evalPath = path.resolve('evals/ai-sdk-evals.json');
  const { questions } = JSON.parse(await readFile(evalPath, 'utf8')) as {
    questions: Question[];
  };

  const tasks = MODELS.flatMap((modelId) =>
      questions.map((q) => async () => {
        const r = await askOne(modelId, q);
        const detail =
            r.status === 'fail'
                ? ` missing: ${r.missing.join(', ')}`
                : r.status === 'error'
                    ? ` ${r.error}`
                    : '';
        console.log(`${modelId}  ${q.id}  ${r.status}${detail}`);
        return r;
      }),
  );

  const results = await runPool(tasks, CONCURRENCY);

  const outDir = path.resolve('evals/runs');
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `baseline-${stamp}.json`);
  await writeFile(
      outFile,
      JSON.stringify(
          {
            models: MODELS,
            instructions: INSTRUCTIONS,
            settings: { REASONING_MAX_TOKENS, MAX_OUTPUT_TOKENS, temperature: 0 },
            results,
          },
          null,
          2,
      ),
  );

  console.log('');
  console.table(summarize(results));
  console.log(`\nFull answers saved to ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
