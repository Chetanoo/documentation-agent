/**
 * API server entry point.
 *
 *   withsecrets npm run dev:api     (restarts on file changes; Vite serves the web app)
 *   withsecrets npm run start:api
 *
 * Environment:
 *   OPENROUTER_API_KEY   required
 *   DATABASE_URL         defaults to the local Docker database (see src/config.ts)
 *   PORT, HOST           default 3000 / 127.0.0.1; use HOST=0.0.0.0 in a container
 *   WEB_DIST             path to the built web app (web/dist) to serve it from this server
 *   TRUST_PROXY          "true" behind a hosting provider's proxy, so rate limits see real client IPs
 *   CHAT_RATE_LIMIT      questions per minute per client IP (default 6)
 */
import pg from 'pg';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { DATABASE_URL } from '../config.js';
import { retrieveMany } from '../rag/retrieve.js';
import { MODELS } from '../rag/models.js';
import { buildApp } from '../../../../Downloads/app.js';

if (!process.env.OPENROUTER_API_KEY) {
  console.error('OPENROUTER_API_KEY is not set. Run via: withsecrets npm run dev:api');
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';

const db = new pg.Pool({
  connectionString: DATABASE_URL,
  max: 5,
  // Release idle connections well before a serverless database (Neon) suspends and drops them.
  idleTimeoutMillis: 60_000,
});

const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });

const app = await buildApp(
  {
    retrieve: async (question) => (await retrieveMany(db, [question])).hits[0] ?? [],
    model: (key) => openrouter(MODELS[key], { usage: { include: true } }),
    ping: async () => {
      await db.query('select 1');
    },
  },
  {
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: process.env.TRUST_PROXY === 'true',
    webDist: process.env.WEB_DIST,
    chatRateLimit: { max: Number(process.env.CHAT_RATE_LIMIT ?? 6), timeWindow: '1 minute' },
  },
);

// An idle connection closed by the database (e.g. Neon suspending) emits 'error' on the pool.
// Without a listener that crashes the process; with one, the pool just opens a new connection.
db.on('error', (err) => app.log.warn({ err }, 'idle database connection closed'));

app.addHook('onClose', async () => {
  await db.end();
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info(`${signal} received, shutting down`);
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port: PORT, host: HOST });
