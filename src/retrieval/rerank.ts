import type { Hit } from './search.js';

// Cohere Rerank through OpenRouter's Rerank API. The AI SDK has rerank(), but the OpenRouter provider
// doesn't implement reranking models, so this calls the endpoint directly with the same API key.
const RERANK_URL = 'https://openrouter.ai/api/v1/rerank';

export type RerankInfo = {
  model: string;
  ms: number;
  cost: number | null;
  fallback: string | null; // why the vector order was kept (timeout, HTTP error...), null if reranked
};

type RerankResponse = { results?: { index: number; relevance_score: number }[]; usage?: { cost?: number } };

// One rerank request. Returns the new order, or a reason why there is none.
async function requestOrder(
  query: string,
  hits: Hit[],
  model: string,
  timeoutMs: number,
): Promise<{ order: Hit[]; cost: number | null } | { error: string; retry: boolean }> {
  try {
    const res = await fetch(RERANK_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        query,
        // Same text the embeddings were made from: "Title > Section" + content.
        documents: hits.map((h) => `${h.crumb}\n\n${h.content}`),
        top_n: hits.length,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      // Rate limits and server errors are worth one more try; other 4xx (bad key, bad model) are not.
      return { error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, retry: res.status === 429 || res.status >= 500 };
    }
    const body = (await res.json()) as RerankResponse;
    const order = body.results?.map((r) => hits[r.index]).filter((h): h is Hit => h !== undefined);
    if (!order?.length) return { error: `unexpected response: ${JSON.stringify(body).slice(0, 200)}`, retry: false };
    return { order, cost: body.usage?.cost ?? null };
  } catch (err) {
    // Timeouts and network errors: retry.
    return { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err), retry: true };
  }
}

// Reorders hits by relevance to the query. Never throws: if every attempt fails it returns the hits in
// their original (vector) order and says why in info.fallback, so a reranker outage degrades retrieval
// instead of breaking answers. Most calls take under 1.5 s, but the API occasionally stalls for 10 s+,
// so a short timeout with a retry beats one long wait.
export async function rerankHits(
  query: string,
  hits: Hit[],
  { model, timeoutMs, attempts = 2 }: { model: string; timeoutMs: number; attempts?: number },
): Promise<{ hits: Hit[]; info: RerankInfo }> {
  const start = performance.now();
  const done = (out: Hit[], cost: number | null, fallback: string | null) => ({
    hits: out,
    info: { model, ms: Math.round(performance.now() - start), cost, fallback },
  });
  if (hits.length < 2) return done(hits, null, null);

  let lastError = '';
  for (let i = 0; i < attempts; i++) {
    const r = await requestOrder(query, hits, model, timeoutMs);
    if ('order' in r) {
      // Anything the reranker didn't return keeps its vector order at the end.
      const seen = new Set(r.order.map((h) => h.id));
      return done([...r.order, ...hits.filter((h) => !seen.has(h.id))], r.cost, null);
    }
    lastError = attempts > 1 ? `${r.error} (attempt ${i + 1}/${attempts})` : r.error;
    if (!r.retry) break;
  }
  return done(hits, null, lastError);
}
