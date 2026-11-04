// Models and generation settings shared by the RAG eval (scripts/run-rag.ts) and the API,
// so what the eval measures is what the API serves.

export const MODELS = {
  qwen: 'qwen/qwen3.8-27b',
  mistral: 'mistralai/mistral-small-2603',
} as const;

export type ModelKey = keyof typeof MODELS;

// Mistral: about Qwen's quality on the eval (24–28 vs 27/29) at half the cost and twice the speed.
export const DEFAULT_MODEL: ModelKey = 'mistral';

export const GENERATION = {
  temperature: 0,
  // Covers reasoning + answer; reasoning is capped so there is always room left for the answer.
  maxOutputTokens: 12000,
  reasoningMaxTokens: 4000,
} as const;

// Ignored by models that don't reason.
export const providerOptions = {
  openrouter: { reasoning: { max_tokens: GENERATION.reasoningMaxTokens } },
};
