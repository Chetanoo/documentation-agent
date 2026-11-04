import { useMemo, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { rehypeHighlightCode } from '../lib/highlight';
import type { ChatUIMessage } from '../types';
import { modelLabel } from '../types';
import { citationHref, citedNumbers, linkCitations } from '../lib/citations';
import { Sources, type Source } from './Sources';

type Props = {
  message: ChatUIMessage;
  streaming: boolean;
};

export function Answer({ message, streaming }: Props) {
  const text = message.parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('')
    .trim();

  const sources: Source[] = message.parts
    .filter((p) => p.type === 'source-url')
    .map((p) => ({ n: Number(p.sourceId), url: p.url, title: p.title ?? p.url }));

  const cited = useMemo(() => citedNumbers(text), [text]);
  const [active, setActive] = useState<number | null>(null);

  // A citation is an in-page link to its source in the margin. It's an <a> rather than a <button>:
  // buttons render as inline-blocks, which browsers wrap around even with a word joiner.
  const sourceId = (n: number) => `${message.id}-source-${n}`;
  const cite = (n: number, key?: number) => {
    const source = sources.find((s) => s.n === n);
    if (!source) return <span key={key}>[{n}]</span>; // cited a number that wasn't among the sources
    return (
      <a
        key={key}
        href={`#${sourceId(n)}`}
        className="cite"
        data-active={active === n}
        aria-label={`Source ${n}: ${source.title}`}
        onMouseEnter={() => setActive(n)}
        onMouseLeave={() => setActive(null)}
        onFocus={() => setActive(n)}
        onBlur={() => setActive(null)}
        onClick={(e) => {
          e.preventDefault();
          setActive(n);
          document.getElementById(sourceId(n))?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }}
      >
        {n}
      </a>
    );
  };

  const components: Components = {
    a: ({ href, children }) => {
      const nums = citationHref(href);
      if (nums) return <span className="cite-group">{nums.map((n) => cite(n, n))}</span>;
      return (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    },
    // Some models put all citations on a line of their own ("[1][4][7]"). As superscripts with
    // nothing around them they read like a number, so that line becomes "Sources: 1, 4, 7".
    p: ({ node, children }) => {
      const kids = node?.children ?? [];
      const nums = kids.flatMap((k) => {
        if (k.type === 'text' && !k.value.replace(/⁠/g, '').trim()) return [];
        const href = k.type === 'element' && k.tagName === 'a' ? String(k.properties.href ?? '') : '';
        return citationHref(href) ?? [NaN];
      });
      if (nums.length === 0 || nums.some(Number.isNaN)) return <p>{children}</p>;
      return (
        <p className="cite-line">
          Sources:{' '}
          {nums.map((n, i) => (
            <span key={n}>
              {i > 0 && ', '}
              {cite(n, n)}
            </span>
          ))}
        </p>
      );
    },
  };

  const meta = message.metadata;
  const finished = meta?.durationMs !== undefined;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-x-12 gap-y-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <div>
        {text ? (
          <div className="answer">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlightCode]} components={components}>
              {linkCitations(text)}
            </ReactMarkdown>
          </div>
        ) : (
          <p className="text-muted">Reading {sources.length} sources…</p>
        )}

        <p className="mt-5 text-sm text-muted">
          {streaming
            ? `Writing with ${modelLabel(meta?.model)}…`
            : finished
              ? `${modelLabel(meta?.model)}, ${((meta?.durationMs ?? 0) / 1000).toFixed(1)} s` +
                (meta?.totalTokens ? `, ${meta.totalTokens.toLocaleString('en-US')} tokens` : '')
              : 'Stopped before the answer was complete.'}
        </p>
      </div>

      <Sources sources={sources} sourceId={sourceId} cited={cited} active={active} onActive={setActive} streaming={streaming} />
    </div>
  );
}
