import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const BASE = 'https://ai-sdk.dev';
const OUT = 'data/corpus';

// Unprefixed paths are v7. Providers pages are skipped for now.
const INCLUDE = [/^\/docs(\/|$)/, /^\/cookbook(\/|$)/];
const EXCLUDE = [
  // Keep only the 6.0 and 7.0 migration guides; older ones are full of stale code.
  /^\/docs\/migration-guides\/(?!migration-guide-(6|7)-0$)./,
];

type PageMeta = { path: string; url: string; title: string | null; bytes: number; sha256: string };

// llms.txt is the full docs concatenated; every page starts with a frontmatter block.
// Split on "---\ntitle:" (not bare "---", which also appears as a horizontal rule).
function splitPages(llms: string): { path: string; md: string }[] {
  const text = llms.replace(/\r\n/g, '\n');
  const starts = [...text.matchAll(/^---\ntitle:/gm)].map((m) => m.index);
  return starts.map((start, i) => {
    const md = text.slice(start, starts[i + 1] ?? text.length).trimEnd() + '\n';
    const url = md.match(/^url:\s*"?([^"\n]+)"?$/m)?.[1];
    if (!url) throw new Error(`page at offset ${start} has no url`);
    return { path: new URL(url).pathname.replace(/\/$/, ''), md };
  });
}

async function main() {
  const src = process.argv[2]; // optional: local llms.txt instead of fetching
  let llms: string;
  if (src) llms = await readFile(src, 'utf8');
  else {
    const res = await fetch(`${BASE}/llms.txt`);
    if (!res.ok) throw new Error(`GET ${BASE}/llms.txt: HTTP ${res.status}`);
    llms = await res.text();
  }

  // Parse before deleting anything: an error page or a format change must not wipe the committed corpus.
  const all = splitPages(llms);
  const keep = all.filter(
    (p) => INCLUDE.some((r) => r.test(p.path)) && !EXCLUDE.some((r) => r.test(p.path)),
  );
  if (keep.length === 0) throw new Error(`no docs pages found in llms.txt (${all.length} pages in total)`);

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await writeFile(path.join(OUT, '_llms.txt'), llms);

  const pages: PageMeta[] = [];
  for (const { path: p, md } of keep) {
    // Section index pages (/docs/ai-sdk-core) would clash with their folder, so store them as _index.md.
    const isParent = keep.some((o) => o.path.startsWith(p + '/'));
    const file = path.join(OUT, isParent ? `${p}/_index.md` : `${p}.md`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, md);
    pages.push({
      path: p,
      url: `${BASE}${p}`,
      title: md.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? null,
      bytes: Buffer.byteLength(md),
      sha256: createHash('sha256').update(md).digest('hex'),
    });
  }

  pages.sort((a, b) => a.path.localeCompare(b.path));
  await writeFile(
    path.join(OUT, '_manifest.json'),
    JSON.stringify(
      { source: `${BASE}/llms.txt`, fetched_at: new Date().toISOString(), total_in_llms: all.length, pages },
      null,
      2,
    ),
  );
  console.log(`${all.length} pages in llms.txt, kept ${pages.length}`);
}

main();
