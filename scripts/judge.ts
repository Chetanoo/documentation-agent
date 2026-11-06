/**
 * LLM judge: grades every answer in a run file against the reference answers
 * in the eval set.
 *
 * Run (from your own terminal):
 *   withsecrets npm run eval:judge                      -> judges the latest run in evals/runs
 *   withsecrets npm run eval:judge -- path/to/run.json  -> judges a specific run file
 *   ... --questions evals/questions-v7-hard.json        -> reference answers from another set
 *                                                          (default: the set the run recorded, else ai-sdk-evals.json)
 *
 * Output: <run-file>.judged.json next to the run file, plus a summary table.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateText, Output } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { z } from 'zod';
import { runPool } from '../src/lib/pool.js';

// Judge comes from a third model family so it isn't grading its own family's answers.
const JUDGE_MODEL = 'google/gemini-3.6-flash';
const CONCURRENCY = 5;

// TODO: New OpenRouter accounts are limited to 20 req/min per model.
// Set to 0 once the account is no longer "new" (check: run with 0 and watch for 429s).
const MIN_INTERVAL_MS = 3500;
let nextSlot = 0;
async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_INTERVAL_MS;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

const ANSWERABLE_VERDICTS = ['correct', 'acceptable', 'outdated', 'wrong'] as const;
const UNANSWERABLE_VERDICTS = ['declined', 'hallucinated'] as const;
type Verdict =
  | (typeof ANSWERABLE_VERDICTS)[number]
  | (typeof UNANSWERABLE_VERDICTS)[number]
  | 'skipped'
  | 'judge-error';

// The judge must NOT use its own knowledge of the SDK: it may be just as outdated
// as the models being graded. It grades only against the reference we give it.
const JUDGE_INSTRUCTIONS = `You grade answers to developer questions about the Vercel AI SDK, version 7.
Your own knowledge of this SDK may be outdated. Do NOT rely on it to decide what is correct.
Grade ONLY against the reference provided with each question.

For answerable questions, pick exactly one verdict:
- "correct": the answer's main recommendation matches the reference key points. Minor omissions are fine.
- "acceptable": the answer does not use the reference approach, but gives a generic, valid solution
  that does not depend on SDK APIs the reference contradicts (for example, a plain JavaScript pattern).
- "outdated": the answer relies on APIs listed as outdated, or on names the reference says were renamed,
  deprecated or removed.
- "wrong": the answer contradicts the reference, or its core solution relies on SDK functions, options,
  packages or behavior that the reference contradicts or that appear to be invented.
  An answer that says the information isn't available is also "wrong", even if it is honest about it.
  If the answer covers the main recommendation and only says a secondary detail is missing,
  grade the part it answered.

For unanswerable questions (the docs do not contain the answer), pick exactly one verdict:
- "declined": the answer says it doesn't know or can't find it. Pointing to where to look is fine.
  Mentioning general, uncontroversial context is fine.
- "hallucinated": the answer states specific facts as true (dates, numbers, names, version plans)
  that the reference does not support.

Keep the reason to one or two sentences and name the specific API or claim that decided the verdict.`;

type Question = {
  id: string;
  answerable: boolean;
  question: string;
  expected_answer: string[];
  stale_signals: string[];
};

type RunResult = {
  model: string;
  id: string;
  answerable: boolean;
  status: string;
  answer: string | null;
};

type Judgment = {
  model: string;
  id: string;
  answerable: boolean;
  verdict: Verdict;
  reason: string;
  judgeCostUsd: number | null;
};

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error('OPENROUTER_API_KEY is not set. Run via: withsecrets npm run eval:judge');
  process.exit(1);
}
const openrouter = createOpenRouter({ apiKey });

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  if (!value) throw new Error(`${name} needs a value`);
  return value;
}

async function findRunFile(): Promise<string> {
  const args = process.argv.slice(2);
  const arg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--questions');
  if (arg) return path.resolve(arg);

  const dir = path.resolve('evals/runs');
  const files = (await readdir(dir))
    .filter((f) => /^(baseline|rag)-/.test(f) && f.endsWith('.json') && !f.endsWith('.judged.json'))
    // sort by the ISO timestamp after the prefix, so baseline and rag runs interleave correctly
    .sort((a, b) => a.slice(a.indexOf('-') + 1).localeCompare(b.slice(b.indexOf('-') + 1)));
  const latest = files.at(-1);
  if (!latest) throw new Error(`No run files found in ${dir}`);
  return path.join(dir, latest);
}

function buildPrompt(q: Question, answer: string): string {
  return [
    `QUESTION:\n${q.question}`,
    `ANSWERABLE FROM THE DOCS: ${q.answerable ? 'yes' : 'no'}`,
    `REFERENCE (what the docs say):\n${q.expected_answer.map((p) => `- ${p}`).join('\n')}`,
    q.stale_signals.length
      ? `OUTDATED APIs (using these as the recommendation means "outdated"):\n${q.stale_signals.map((s) => `- ${s}`).join('\n')}`
      : '',
    `ANSWER TO GRADE:\n"""\n${answer}\n"""`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function judgeOne(q: Question, r: RunResult): Promise<Judgment> {
  const base = { model: r.model, id: r.id, answerable: r.answerable };

  // Truncated, empty or failed answers were never real answers, so there's nothing to grade.
  if (!r.answer || ['error', 'truncated', 'empty'].includes(r.status)) {
    return { ...base, verdict: 'skipped', reason: `run status: ${r.status}`, judgeCostUsd: null };
  }

  const verdicts = q.answerable ? ANSWERABLE_VERDICTS : UNANSWERABLE_VERDICTS;
  const schema = z.object({
    reason: z.string().describe('One or two sentences naming the API or claim that decided it'),
    verdict: z.enum(verdicts),
  });

  try {
    await throttle();
    const result = await generateText({
      model: openrouter(JUDGE_MODEL, { usage: { include: true } }),
      instructions: JUDGE_INSTRUCTIONS,
      prompt: buildPrompt(q, r.answer),
      output: Output.object({ schema }),
      temperature: 0,
      maxOutputTokens: 4000,
      providerOptions: {
        openrouter: { reasoning: { max_tokens: 2000 } },
      },
    });

    const meta = result.finalStep.providerMetadata as
      | { openrouter?: { usage?: { cost?: number } } }
      | undefined;

    return {
      ...base,
      verdict: result.output.verdict,
      reason: result.output.reason,
      judgeCostUsd: meta?.openrouter?.usage?.cost ?? null,
    };
  } catch (err) {
    return {
      ...base,
      verdict: 'judge-error',
      reason: err instanceof Error ? err.message : String(err),
      judgeCostUsd: null,
    };
  }
}

function summarize(models: string[], judgments: Judgment[]) {
  return models.map((model) => {
    const rows = judgments.filter((j) => j.model === model);
    const count = (v: Verdict) => rows.filter((j) => j.verdict === v).length;
    const answerable = rows.filter((j) => j.answerable).length;
    const unanswerable = rows.length - answerable;
    const costs = rows.map((j) => j.judgeCostUsd).filter((c): c is number => c !== null);

    return {
      model,
      correct: `${count('correct')}/${answerable}`,
      acceptable: count('acceptable'),
      outdated: count('outdated'),
      wrong: count('wrong'),
      declined: `${count('declined')}/${unanswerable}`,
      hallucinated: count('hallucinated'),
      'skipped/err': count('skipped') + count('judge-error'),
      'judge cost ($)': costs.length ? +costs.reduce((s, c) => s + c, 0).toFixed(4) : 'n/a',
    };
  });
}

async function main() {
  const runFile = await findRunFile();
  console.log(`Judging ${runFile} with ${JUDGE_MODEL}\n`);

  const run = JSON.parse(await readFile(runFile, 'utf8')) as {
    questionsFile?: string;
    models: string[];
    results: RunResult[];
  };
  // --questions wins; otherwise the file the run recorded; runs older than that field used the original set.
  const questionsFile = flag('--questions') ?? run.questionsFile ?? 'evals/ai-sdk-evals.json';
  console.log(`References from ${questionsFile}\n`);
  const { questions } = JSON.parse(await readFile(path.resolve(questionsFile), 'utf8')) as {
    questions: Question[];
  };
  const byId = new Map(questions.map((q) => [q.id, q]));

  const tasks = run.results.map((r) => async () => {
    const q = byId.get(r.id);
    if (!q) throw new Error(`Question ${r.id} not found in eval set`);
    const j = await judgeOne(q, r);
    console.log(`${j.model}  ${j.id}  ${j.verdict}  - ${j.reason}`);
    return j;
  });

  const judgments = await runPool(tasks, CONCURRENCY);

  const outFile = runFile.replace(/\.json$/, '.judged.json');
  await writeFile(
    outFile,
    JSON.stringify({ runFile: path.basename(runFile), questionsFile, judgeModel: JUDGE_MODEL, judgments }, null, 2),
  );

  console.log('');
  console.table(summarize(run.models, judgments));
  console.log(`\nJudgments saved to ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
