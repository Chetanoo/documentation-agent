import type { UIMessage } from 'ai';

// Mirrors src/api/types.ts in the repo root (kept separate so the web app has a single copy of
// the `ai` package types). The API stream is the contract: if one side changes, change both.

export type ModelKey = 'mistral' | 'qwen';

export type ChatMetadata = {
  model?: string | undefined;
  sources?: number | undefined;
  retrievalMs?: number | undefined;
  totalTokens?: number | undefined;
  durationMs?: number | undefined;
};

export type ChatUIMessage = UIMessage<ChatMetadata>;

export const MODEL_OPTIONS: { key: ModelKey; id: string; label: string; hint: string }[] = [
  { key: 'mistral', id: 'mistralai/mistral-small-2603', label: 'Mistral Small', hint: 'Faster' },
  { key: 'qwen', id: 'qwen/qwen3.8-27b', label: 'Qwen 3.8 27B', hint: 'Slower, more thorough' },
];

export const modelLabel = (id: string | undefined) =>
  MODEL_OPTIONS.find((m) => m.id === id)?.label ?? id ?? 'Unknown model';
