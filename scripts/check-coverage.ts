import { readFile } from 'node:fs/promises';

type Source = string | { url?: string; href?: string; path?: string };

const toPath = (s: Source): string | undefined => {
  const u = typeof s === 'string' ? s : (s.url ?? s.href ?? s.path);
  return u && new URL(u, 'https://ai-sdk.dev').pathname.replace(/\.md$/, '').replace(/\/$/, '');
};

const manifest = JSON.parse(await readFile('data/corpus/_manifest.json', 'utf8'));
const have = new Set<string>(manifest.pages.map((p: { path: string }) => p.path));

const raw = JSON.parse(await readFile('evals/ai-sdk-evals.json', 'utf8'));
const questions: { id?: string; sources?: Source[] }[] = Array.isArray(raw) ? raw : raw.questions;

let missing = 0;
for (const q of questions) {
  for (const s of q.sources ?? []) {
    const p = toPath(s);
    if (!p || !have.has(p)) {
      missing++;
      console.log(`MISSING  ${q.id ?? '?'}  ${p ?? JSON.stringify(s)}`);
    }
  }
}
console.log(missing === 0 ? 'all eval sources present' : `${missing} missing`);
