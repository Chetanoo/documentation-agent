import { readFile } from 'node:fs/promises';

type Source = string | { url?: string; href?: string; path?: string };

const toPath = (s: Source): string | undefined => {
  const u = typeof s === 'string' ? s : (s.url ?? s.href ?? s.path);
  return u && new URL(u, 'https://ai-sdk.dev').pathname.replace(/\.md$/, '').replace(/\/$/, '');
};

const manifest = JSON.parse(await readFile('data/corpus/_manifest.json', 'utf8'));
const have = new Set<string>(manifest.pages.map((p: { path: string }) => p.path));

// Usage: npm run check-coverage [-- file1.json file2.json ...]  (default: evals/ai-sdk-evals.json)
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));

let missing = 0;
for (const file of files.length ? files : ['evals/ai-sdk-evals.json']) {
  const raw = JSON.parse(await readFile(file, 'utf8'));
  const questions: { id?: string; sources?: Source[] }[] = Array.isArray(raw) ? raw : raw.questions;
  console.log(`${file}: ${questions.length} questions`);
  for (const q of questions) {
    for (const s of q.sources ?? []) {
      const p = toPath(s);
      if (!p || !have.has(p)) {
        missing++;
        console.log(`MISSING  ${q.id ?? '?'}  ${p ?? JSON.stringify(s)}`);
      }
    }
  }
}
console.log(missing === 0 ? 'all eval sources present' : `${missing} missing`);
