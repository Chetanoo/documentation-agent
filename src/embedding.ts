import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { embedMany, type EmbeddingModel } from 'ai';
import { EMBEDDING } from './config.js';

// The OpenRouter provider still uses the pre-v6 method name (textEmbeddingModel).
export const embeddingModel: EmbeddingModel = createOpenRouter().textEmbeddingModel(EMBEDDING.model);

export async function embedTexts(values: string[]): Promise<{ embeddings: number[][]; tokens: number }> {
  const { embeddings, usage } = await embedMany({ model: embeddingModel, values, maxRetries: 3 });
  return { embeddings, tokens: usage.tokens };
}
