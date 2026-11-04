import { existsSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyServerOptions } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { chatRoutes, type ChatDeps } from '../../../../Downloads/chat.js';

export type AppDeps = ChatDeps & {
  ping: () => Promise<void>; // throws if the database is unreachable
};

export type AppOptions = FastifyServerOptions & {
  webDist?: string | undefined; // built web app (web/dist) to serve; omit in development (Vite serves it)
  chatRateLimit?: { max: number; timeWindow: string } | undefined;
};

// Built from injected dependencies so tests can use a fake retriever and a mock model.
export async function buildApp(deps: AppDeps, options: AppOptions = {}) {
  const { webDist, chatRateLimit = { max: 6, timeWindow: '1 minute' }, ...fastifyOptions } = options;
  const app = Fastify({ bodyLimit: 1_000_000, ...fastifyOptions });

  // Limits are opt-in per route (only /api/chat costs money).
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `You've asked ${context.max} questions in the last minute. Try again in ${context.after}.`,
    }),
  });

  // Liveness: doesn't touch the database, so the host's health checks don't keep a
  // serverless database (Neon) awake and burn its free compute hours.
  app.get('/api/health', async () => ({ ok: true }));

  // Readiness: checks the database too. Call it by hand, not from a frequent health check.
  app.get('/api/ready', async (_request, reply) => {
    try {
      await deps.ping();
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false, error: 'database unreachable' });
    }
  });

  await app.register(chatRoutes(deps, { rateLimit: chatRateLimit }));

  if (webDist) {
    const root = path.resolve(webDist);
    if (!existsSync(path.join(root, 'index.html'))) throw new Error(`No index.html in ${root}: build the web app first`);
    await app.register(fastifyStatic, { root, wildcard: false });
    // Single-page app: unknown non-API GETs get index.html; unknown API routes stay 404 JSON.
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'Not found' });
    });
  }

  return app;
}
