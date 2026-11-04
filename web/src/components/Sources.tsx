import { useState } from 'react';

export type Source = { n: number; url: string; title: string };

type Props = {
  sources: Source[];
  sourceId: (n: number) => string; // element id, the target of the citation links
  cited: Set<number>;
  active: number | null;
  onActive: (n: number | null) => void;
  streaming: boolean;
};

// "Loop Control > Stop Conditions > Run Up to…" → page "Loop Control", section "Stop Conditions › Run Up to…"
// Chunk titles carry chunker details users don't need: code backticks and part labels like "(1/2)".
function splitTitle(title: string) {
  const clean = title.replace(/`/g, '').replace(/\s*\(\d+\/\d+\)/g, '');
  const [page, ...rest] = clean.split(' > ');
  return { page: page ?? clean, section: rest.join(' › ') };
}

export function Sources({ sources, sourceId, cited, active, onActive, streaming }: Props) {
  const [showAll, setShowAll] = useState(false);
  if (sources.length === 0) return null;

  const citedCount = sources.filter((s) => cited.has(s.n)).length;
  // On small screens only cited sources are shown until expanded; on large screens the margin shows all.
  const hiddenOnSmall = (s: Source) => !showAll && citedCount > 0 && !cited.has(s.n);

  return (
    <aside aria-label="Sources" className="border-t border-rule pt-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6">
      <p className="mb-3 text-sm text-muted">
        {streaming && citedCount === 0
          ? `${sources.length} sources found`
          : citedCount > 0
            ? `Cited ${citedCount} of ${sources.length} sources`
            : `${sources.length} sources, none cited`}
      </p>

      <ol className="space-y-3">
        {sources.map((s) => {
          const { page, section } = splitTitle(s.title);
          const isCited = cited.has(s.n);
          return (
            <li
              key={s.n}
              id={sourceId(s.n)}
              className={`scroll-mt-4 ${hiddenOnSmall(s) ? 'hidden lg:block' : ''} ${isCited || streaming ? '' : 'opacity-55'}`}
              onMouseEnter={() => onActive(s.n)}
              onMouseLeave={() => onActive(null)}
            >
              <a
                href={s.url}
                target="_blank"
                rel="noreferrer"
                className="group grid grid-cols-[1.5rem_minmax(0,1fr)] text-sm leading-snug"
                onFocus={() => onActive(s.n)}
                onBlur={() => onActive(null)}
              >
                <span className={`pt-px font-semibold tabular-nums ${isCited ? 'text-pen' : 'text-muted'}`}>{s.n}</span>
                <span className="marked -mx-1 rounded-sm px-1 py-0.5" data-active={active === s.n}>
                  <span className="block text-muted">{page}</span>
                  {section && <span className="block text-ink group-hover:underline">{section}</span>}
                  {!section && <span className="block text-ink group-hover:underline">Overview</span>}
                </span>
              </a>
            </li>
          );
        })}
      </ol>

      {citedCount > 0 && citedCount < sources.length && (
        <button
          type="button"
          className="mt-3 text-sm text-pen underline-offset-4 hover:underline lg:hidden"
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? 'Show cited sources only' : `Show all ${sources.length} sources`}
        </button>
      )}
    </aside>
  );
}
