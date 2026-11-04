// Types shared by the API and the web app (type-only: safe to import from the browser bundle).
import type { UIMessage } from 'ai';
import type { ModelKey } from '../rag/models.js';

export type { ModelKey };

// Sent at the start of the answer (model, retrieval) and completed when it finishes (tokens, duration).
// Fields may be missing or undefined (e.g. a provider that reports no token usage).
export type ChatMetadata = {
  model?: string | undefined;
  sources?: number | undefined;
  retrievalMs?: number | undefined;
  totalTokens?: number | undefined;
  durationMs?: number | undefined;
};

// Message parts used by this app: 'text' for the answer and 'source-url' for each retrieved source.
// A source's sourceId is its citation number as a string ("1".."8"), matching [n] in the answer.
export type ChatUIMessage = UIMessage<ChatMetadata>;

// Extra fields the client sends next to useChat's { id, messages }.
export type ChatRequestExtras = { model?: ModelKey };
