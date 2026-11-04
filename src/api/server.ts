/**
 * API server entry point.
 *
 *   withsecrets npm run dev:api     (restarts on file changes)
 *   withsecrets npm run start:api
 */
import pg from 'pg';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { DATABASE_URL } from '../config.js';
import { retrieveMany } from '../rag/retrieve.js';
import { MODELS } from '../rag/models.js';
import { buildApp } from './app.js';

if (!process.env.OPENROUTER_API_KEY) {
  console.error('OPENROUTER_API_KEY is not set. Run via: withsecrets npm run dev:api');
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1'; // set HOST=0.0.0.0 inside a container

const db = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });

const app = await buildApp(
  {
    retrieve: async (question) => (await retrieveMany(db, [question])).hits[0] ?? [],
    model: (key) => openrouter(MODELS[key], { usage: { include: true } }),
    ping: async () => {
      await db.query('select 1');
    },
  },
  { logger: { level: process.env.LOG_LEVEL ?? 'info' } },
);

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
