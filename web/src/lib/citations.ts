// Citations are written by the model as [1], [2][4] or [1, 3]. Code blocks and inline code are
// left alone (arr[0] is not a citation), and so are index brackets like fn()[1].

// A run of citation brackets, e.g. "[4][7]" or "[1, 3]". Leading spaces/tabs are captured so the
// markers attach to the word before them, like footnotes.
const CITATION_RUN = /[ \t]*(?<![\w)])((?:\[\d+(?:\s*,\s*\d+)*])+)(?!\()/g;

// U+2060 WORD JOINER: no visible width, but the browser won't break the line before the markers.
const JOINER = '⁠';

// Splits markdown into prose and code segments. An unclosed fence (while streaming) counts as code.
function splitCode(md: string): { text: string; code: boolean }[] {
  const out: { text: string; code: boolean }[] = [];
  for (const [i, block] of md.split(/(```[\s\S]*?(?:```|$))/).entries()) {
    if (i % 2 === 1) {
      out.push({ text: block, code: true });
      continue;
    }
    for (const [j, piece] of block.split(/(`[^`\n]*`)/).entries()) out.push({ text: piece, code: j % 2 === 1 });
  }
  return out;
}

const numbersIn = (run: string) => (run.match(/\d+/g) ?? []).map(Number);

// Turns each run of citations into one markdown link, "[4,7](#cite-4,7)", which the renderer shows
// as a group of markers that never wraps apart.
export function linkCitations(md: string): string {
  return splitCode(md)
    .map(({ text, code }) =>
      code
        ? text
        : text.replace(CITATION_RUN, (_m, run: string) => {
            const nums = numbersIn(run).join(',');
            return `${JOINER}[${nums}](#cite-${nums})`;
          }),
    )
    .join('');
}

// "#cite-4,7" → [4, 7]; anything else → null.
export function citationHref(href: string | undefined): number[] | null {
  const m = href?.match(/^#cite-(\d+(?:,\d+)*)$/);
  return m ? numbersIn(m[1] ?? '') : null;
}

export function citedNumbers(md: string): Set<number> {
  const nums = new Set<number>();
  for (const { text, code } of splitCode(md)) {
    if (code) continue;
    for (const m of text.matchAll(CITATION_RUN)) for (const n of numbersIn(m[1] ?? '')) nums.add(n);
  }
  return nums;
}
