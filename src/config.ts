// Embedding model and its vector size. Changing either means re-running db:migrate (with --reset) and embed.
// Fallback candidate: 'qwen/qwen3-embedding-8b' (check its output dimensions before switching).
export const EMBEDDING = {
  model: 'openai/text-embedding-3-small',
  dims: 1536,
} as const;

export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/docrag';
