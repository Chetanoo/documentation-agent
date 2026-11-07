import type { FastifyInstance } from 'fastify';
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
  type LanguageModel,
} from 'ai';
import { z } from 'zod';
import type { Hit } from '../retrieval/search.js';
import { RAG_INSTRUCTIONS, buildPrompt } from '../rag/prompt.js';
import { DEFAULT_MODEL, GENERATION, MODELS, providerOptions, type ModelKey } from '../rag/models.js';
import type { ChatUIMessage } from './types.js';

export type ChatDeps = {
  retrieve: (question: string) => Promise<Hit[]>;
  model: (key: ModelKey) => LanguageModel;
};

const MAX_QUESTION_CHARS = 2000;

// useChat's default transport sends { id, messages, trigger, messageId } plus our extras.
// Messages are validated loosely: we only read the text parts of the last user message.
const Body = z.object({
  messages: z
    .array(z.object({ role: z.string(), parts: z.array(z.object({ type: z.string() }).passthrough()) }).passthrough())
    .min(1)
    .max(200),
  model: z.enum(Object.keys(MODELS) as [ModelKey, ...ModelKey[]]).optional(),
});

function lastUserQuestion(messages: z.infer<typeof Body>['messages']): string {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  if (!last) return '';
  return last.parts
    .filter((p): p is typeof p & { text: string } => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

export type ChatRouteOptions = {
  rateLimit: { max: number; timeWindow: string }; // per client IP; needs @fastify/rate-limit registered
};

export function chatRoutes(deps: ChatDeps, { rateLimit }: ChatRouteOptions) {
  return async function (app: FastifyInstance) {
    app.post('/api/chat', { config: { rateLimit } }, async (request, reply) => {
      const parsed = Body.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid request body' });

      const question = lastUserQuestion(parsed.data.messages);
      if (!question) return reply.code(400).send({ error: 'No question in the last user message' });
      if (question.length > MAX_QUESTION_CHARS)
        return reply.code(400).send({ error: `Question is longer than ${MAX_QUESTION_CHARS} characters` });

      const modelKey = parsed.data.model ?? DEFAULT_MODEL;
      const started = Date.now();

      // Stop the model call (and its cost) if the client goes away mid-answer.
      const abort = new AbortController();
      reply.raw.on('close', () => {
        if (!reply.raw.writableFinished) abort.abort();
      });

      // Used for retrieval errors (createUIMessageStream) and model errors (toUIMessageStream):
      // log the real error, send the client a generic message.
      const onError = (error: unknown) => {
        if (abort.signal.aborted) return 'Request cancelled.';
        request.log.error({ err: error }, 'chat failed');
        return 'Something went wrong while answering. Please try again.';
      };

      // Single-turn RAG: each question is answered on its own, like the eval.
      // Earlier messages are shown in the UI but not sent to the model.
      const stream = createUIMessageStream<ChatUIMessage>({
        execute: async ({ writer }) => {
          const t0 = Date.now();
          const hits = await deps.retrieve(question);
          const retrievalMs = Date.now() - t0;

          writer.write({
            type: 'start',
            messageMetadata: { model: MODELS[modelKey], sources: hits.length, retrievalMs },
          });
          // Sources go out before the answer, so the UI can show them while the text streams.
          hits.forEach((h, i) =>
            writer.write({ type: 'source-url', sourceId: String(i + 1), url: h.url, title: h.crumb }),
          );

          const result = streamText({
            model: deps.model(modelKey),
            instructions: RAG_INSTRUCTIONS,
            prompt: buildPrompt(question, hits),
            temperature: GENERATION.temperature,
            maxOutputTokens: GENERATION.maxOutputTokens,
            providerOptions,
            abortSignal: abort.signal,
            // Errors reach toUIMessageStream's onError (which logs them); skip streamText's default console log.
            onError: () => {},
            onEnd: (event) => {
              // v7: event.usage covers all steps; provider metadata lives on finalStep.
              const meta = event.finalStep.providerMetadata as { openrouter?: { usage?: { cost?: number } } } | undefined;
              request.log.info(
                {
                  model: MODELS[modelKey],
                  retrievalMs,
                  durationMs: Date.now() - started,
                  inputTokens: event.usage.inputTokens,
                  outputTokens: event.usage.outputTokens,
                  costUsd: meta?.openrouter?.usage?.cost,
                  finishReason: event.finishReason,
                },
                'chat answered',
              );
            },
          });

          writer.merge(
            toUIMessageStream({
              stream: result.stream,
              sendStart: false,
              onError,
              messageMetadata: ({ part }) =>
                part.type === 'finish'
                  ? { totalTokens: part.totalUsage.totalTokens, durationMs: Date.now() - started }
                  : undefined,
            }),
          );
        },
        onError,
      });

      // createUIMessageStreamResponse sets the SSE format and the headers useChat expects.
      const response = createUIMessageStreamResponse({ stream });
      reply.code(response.status);
      response.headers.forEach((value, key) => reply.header(key, value));
      return reply.send(response.body);
    });
  };
}
