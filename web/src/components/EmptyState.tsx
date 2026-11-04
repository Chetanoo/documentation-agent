// Real questions from the eval set, each answered correctly by both models in the v3 runs.
const EXAMPLES = [
  'How do I stop a tool loop after 5 steps?',
  'How do I save the full conversation once streaming finishes?',
  'How do I make a deleteFile tool require user approval before it runs?',
  'How do I request smaller embedding vectors, for example 512 dimensions?',
];

export function ProjectNote({ className = '' }: { className?: string }) {
  return (
    <p className={`text-xs leading-relaxed text-muted ${className}`}>
      Unofficial project. Answers come from a snapshot of ai-sdk.dev taken on November 1, 2026. Each question is answered
      on its own.{' '}
      <a
        href="https://github.com/Chetanoo/documentation-agent"
        target="_blank"
        rel="noreferrer"
        className="underline underline-offset-2"
      >
        Source code
      </a>
    </p>
  );
}

export function EmptyState({ onAsk }: { onAsk: (q: string) => void }) {
  return (
    <section className="max-w-[40rem] py-10 sm:py-16">
      <h1 className="font-serif text-[1.875rem] leading-[1.15] font-medium tracking-[-0.01em] text-balance sm:text-[2.25rem]">
        Questions about AI&nbsp;SDK&nbsp;7, answered from the current docs.
      </h1>
      <p className="mt-5 max-w-[34rem] text-base leading-relaxed text-muted">
        Every answer cites the docs sections it's based on. If the docs don't cover something, it says so instead of
        guessing.
      </p>

      <h2 className="mt-10 text-sm font-medium text-muted">Try one of these</h2>
      <ul className="mt-3 divide-y divide-rule border-y border-rule">
        {EXAMPLES.map((q) => (
          <li key={q}>
            <button
              type="button"
              onClick={() => onAsk(q)}
              className="w-full py-3 text-left font-serif text-[1.0625rem] hover:text-pen"
            >
              {q}
            </button>
          </li>
        ))}
      </ul>

      <ProjectNote className="mt-10 sm:hidden" />
    </section>
  );
}
