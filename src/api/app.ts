import Fastify, { type FastifyServerOptions } from 'fastify';
import { chatRoutes, type ChatDeps } from './chat.js';

export type AppDeps = ChatDeps & {
  ping: () => Promise<void>; // throws if the database is unreachable
};

// Built from injected dependencies so tests can use a fake retriever and a mock model.
export async function buildApp(deps: AppDeps, options: FastifyServerOptions = {}) {
  const app = Fastify({ bodyLimit: 1_000_000, ...options });

  app.get('/api/health', async (_request, reply) => {
    try {
      await deps.ping();
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false, error: 'database unreachable' });
    }
  });

  await app.register(chatRoutes(deps));
  return app;
}
