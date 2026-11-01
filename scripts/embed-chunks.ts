import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { embedMany } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { DATABASE_URL, EMBEDDING } from '../src/config.js';
import type { Chunk } from './chunk-docs.js';

const CHUNKS = 'data/chunks.jsonl';
const BATCH = 200; // ~70k tokens per request; the provider declares no per-call limit, so we batch ourselves

const openrouter = createOpenRouter();
const model = openrouter.textEmbeddingModel(EMBEDDING.model);

// Whole chunk + model: any change to text, metadata or model re-embeds that chunk.
const hashOf = (c: Chunk) =>
  createHash('sha256').update(EMBEDDING.model).update('\n').update(JSON.stringify(c)).digest('hex');

async function embedBatch(values: string[]): Promise<{ embeddings: number[][]; tokens: number }> {
  const { embeddings, usage } = await embedMany({ model, values, maxRetries: 3 });
  return { embeddings, tokens: usage.tokens };
}

async function upsert(db: pg.Client, rows: { c: Chunk; hash: string; embedding: number[] }[]) {
  const cols = ['id', 'path', 'url', 'title', 'section', 'crumb', 'kind', 'content', 'tokens', 'hash', 'embedding_model', 'embedding'];
  const params: unknown[] = [];
  const tuples = rows.map(({ c, hash, embedding }) => {
    const vals = [c.id, c.path, c.url, c.title, c.section, [c.title, ...c.section].join(' > '), c.kind, c.content, c.tokens, hash, EMBEDDING.model, JSON.stringify(embedding)];
    const start = params.length;
    params.push(...vals);
    return `(${vals.map((_, i) => `$${start + i + 1}${i === vals.length - 1 ? '::vector' : ''}`).join(', ')})`;
  });
  await db.query(
    `insert into chunks (${cols.join(', ')}) values ${tuples.join(', ')}
     on conflict (id) do update set ${cols.slice(1).map((c) => `${c} = excluded.${c}`).join(', ')}`,
    params,
  );
}

async function main() {
  const chunks: Chunk[] = (await readFile(CHUNKS, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  try {
    const existing = new Map(
      (await db.query<{ id: string; hash: string }>('select id, hash from chunks')).rows.map((r) => [r.id, r.hash]),
    );
    const todo = chunks.map((c) => ({ c, hash: hashOf(c) })).filter(({ c, hash }) => existing.get(c.id) !== hash);
    console.log(`${chunks.length} chunks, ${chunks.length - todo.length} unchanged, ${todo.length} to embed with ${EMBEDDING.model}`);

    let tokens = 0;
    const t0 = Date.now();
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      const res = await embedBatch(batch.map(({ c }) => c.embed_text));
      const dims = res.embeddings[0]?.length;
      if (dims !== EMBEDDING.dims) throw new Error(`model returned ${dims} dims, schema expects ${EMBEDDING.dims}`);
      // Each batch is committed on its own, so a failure midway keeps the finished batches.
      await upsert(db, batch.map((b, j) => ({ ...b, embedding: res.embeddings[j]! })));
      tokens += res.tokens;
      console.log(`  ${Math.min(i + BATCH, todo.length)}/${todo.length}  (${tokens} tokens)`);
    }

    const ids = chunks.map((c) => c.id);
    const del = await db.query('delete from chunks where not (id = any($1))', [ids]);
    console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${tokens} tokens embedded, ${del.rowCount} stale chunks deleted`);
  } finally {
    await db.end();
  }
}

main();
