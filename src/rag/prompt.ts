import type { Hit } from '../retrieval/search.js';
import { citedNumbers } from './citations.js';

// Shared by the eval run and the API, so both answer the same way.
export const RAG_INSTRUCTIONS = `You are a documentation assistant for the Vercel AI SDK (the "ai" npm package), version 7.
Answer the developer's question using ONLY the numbered sources provided. They are excerpts from the current v7 docs.

Rules:
- Your own knowledge of this SDK is probably outdated: many APIs were renamed or removed in v6 and v7. When the sources and your memory disagree, follow the sources.
- Cite the sources that support each claim inline by number, e.g. [1] or [2][4], right after the claim.
- Code examples may only use APIs, options and imports that appear in the sources.
- Migration guide excerpts show old code in blocks titled "Before". Never recommend that code.
- Each source has a kind: guide, reference, cookbook, migration-guide or troubleshooting. Guides and reference pages describe the current API; cookbook examples can lag behind it. When sources disagree, follow the guide or reference, and say briefly that another source shows an older approach.
- If the sources don't contain the answer, say you couldn't find it in the docs. Don't guess and don't fill gaps from memory. If they answer only part of the question, answer that part and say what's missing.

Answer concisely, with a short TypeScript example when useful.`;

// Some page titles keep YAML quotes ("React error \"...\""), which would break the attribute.
const attr = (s: string) => s.replace(/\\"/g, "'").replace(/"/g, '');

// noinspection HtmlUnknownAttribute: <source> here is prompt markup for the model, not HTML.
export function formatSources(hits: Hit[]): string {
  return hits
    .map((h, i) => `<source id="${i + 1}" kind="${h.kind}" section="${attr(h.crumb)}" url="${attr(h.url)}">\n${h.content}\n</source>`)
    .join('\n\n');
}

export function buildPrompt(question: string, hits: Hit[]): string {
  return `<sources>\n${formatSources(hits)}\n</sources>\n\nQuestion: ${question}`;
}

// Citation numbers used in an answer, sorted. Same parser as the web app (see ./citations.ts):
// [1], [2][4], [1, 3], [[2]][[3]], and trailing code comments like "// [2]"; not arr[0] or fn()[1].
export function parseCitations(answer: string): number[] {
  return [...citedNumbers(answer)].sort((a, b) => a - b);
}
