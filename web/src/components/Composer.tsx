import { useEffect, useRef, useState } from 'react';

type Props = {
  busy: boolean;
  onAsk: (question: string) => void;
  onStop: () => void;
};

const MAX_CHARS = 2000; // same limit as the API

export function Composer({ busy, onAsk, onStop }: Props) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow with the text, up to about six lines.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
    el.style.overflowY = el.scrollHeight > 168 ? 'auto' : 'hidden';
  }, [value]);

  const submit = () => {
    const q = value.trim();
    if (!q || busy) return;
    onAsk(q);
    setValue('');
  };

  return (
    <form
      className="flex items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label htmlFor="question" className="sr-only">
        Your question about the AI SDK
      </label>
      <textarea
        id="question"
        ref={ref}
        rows={1}
        maxLength={MAX_CHARS}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="Ask a question about the AI SDK"
        className="min-h-11 flex-1 resize-none border-b-2 border-ink/80 bg-transparent px-1 py-2.5 text-base leading-6 outline-none placeholder:text-muted focus:border-pen focus-visible:outline-none"
      />
      {busy ? (
        <button
          type="button"
          onClick={onStop}
          className="h-11 shrink-0 rounded-md border border-ink/30 px-4 text-sm font-medium hover:border-ink"
        >
          Stop
        </button>
      ) : (
        <button
          type="submit"
          disabled={!value.trim()}
          className="h-11 shrink-0 rounded-md bg-ink px-5 text-sm font-medium text-paper disabled:opacity-35"
        >
          Ask
        </button>
      )}
    </form>
  );
}
