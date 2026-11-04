import { useEffect, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { MODEL_OPTIONS, type ChatUIMessage, type ModelKey } from './types';
import { Answer } from './components/Answer';
import { Composer } from './components/Composer';
import { EmptyState, ProjectNote } from './components/EmptyState';

const transport = new DefaultChatTransport<ChatUIMessage>({ api: '/api/chat' });

type Turn = { question: ChatUIMessage; answer: ChatUIMessage | undefined };

// Pairs each question with the answer that follows it.
function toTurns(messages: ChatUIMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    if (m.role === 'user') turns.push({ question: m, answer: undefined });
    else if (m.role === 'assistant' && turns.length > 0) turns[turns.length - 1]!.answer = m;
  }
  return turns;
}

export function App() {
  const [model, setModel] = useState<ModelKey>('mistral');
  const { messages, sendMessage, status, stop, error, regenerate } = useChat<ChatUIMessage>({ transport });
  const busy = status === 'submitted' || status === 'streaming';
  const lastTurnRef = useRef<HTMLElement>(null);

  const ask = (text: string) => void sendMessage({ text }, { body: { model } });

  const turns = toTurns(messages);
  const hint = MODEL_OPTIONS.find((m) => m.key === model)?.hint;

  // Bring each new question to the top of the view; don't chase the text while it streams.
  useEffect(() => {
    if (turns.length > 0) lastTurnRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [turns.length]);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-rule">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-8">
          <p className="shrink-0 font-semibold tracking-[-0.01em]">Ask the AI SDK docs</p>
          <label className="flex items-center gap-2 text-sm text-muted">
            <span className="hidden sm:inline">{hint}</span>
            <span className="sr-only">Model</span>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value as ModelKey)}
              className="rounded-md border border-rule bg-surface px-2 py-1.5 text-ink"
            >
              {MODEL_OPTIONS.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 sm:px-8">
        {turns.length === 0 ? (
          <EmptyState onAsk={ask} />
        ) : (
          <div className="py-8 sm:py-10">
            {turns.map((t, i) => {
              const isLast = i === turns.length - 1;
              return (
                <article
                  key={t.question.id}
                  ref={isLast ? lastTurnRef : undefined}
                  className="scroll-mt-4 border-rule not-first:mt-12 not-first:border-t not-first:pt-10"
                >
                  <h2 className="max-w-[66ch] text-[1.3125rem] leading-snug font-semibold tracking-[-0.01em]">
                    {t.question.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')}
                  </h2>

                  <div className="mt-6">
                    {t.answer ? (
                      <Answer message={t.answer} streaming={isLast && status === 'streaming'} />
                    ) : isLast && status === 'submitted' ? (
                      <p className="text-muted">Searching the docs…</p>
                    ) : null}

                    {isLast && error && (
                      <div role="alert" className="mt-6 max-w-[66ch] border-l-3 border-pen pl-4">
                        <p>The answer couldn't be completed: {error.message}</p>
                        <button
                          type="button"
                          onClick={() => void regenerate({ body: { model } })}
                          className="mt-2 text-sm text-pen underline underline-offset-4"
                        >
                          Try again
                        </button>
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </main>

      <footer className="sticky bottom-0 border-t border-rule bg-paper/95 backdrop-blur-sm">
        <div className="mx-auto max-w-6xl px-4 pt-3 pb-4 sm:px-8">
          <Composer busy={busy} onAsk={ask} onStop={() => void stop()} />
          <ProjectNote className="mt-3 hidden sm:block" />
        </div>
      </footer>
    </div>
  );
}
