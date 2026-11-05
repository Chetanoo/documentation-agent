import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const CORPUS = 'data/corpus';
const OUT = 'data/chunks.jsonl';

// Sizes in estimated tokens (chars / 4). Tune after looking at the stats.
const MAX_TOKENS = 800;
const MIN_TOKENS = 120; // sections smaller than this merge into the next one

type Kind = 'guide' | 'reference' | 'cookbook' | 'migration-guide' | 'troubleshooting';

export type Chunk = {
  id: string; // `${path}#${n}`, stable as long as the page doesn't change
  path: string; // /docs/ai-sdk-core/generating-text
  url: string; // canonical URL with #anchor of the first heading in the chunk
  title: string;
  section: string[]; // heading path below the title, e.g. ['API Signature', 'Parameters']
  kind: Kind;
  content: string; // raw markdown of the chunk (what the LLM sees)
  embed_text: string; // title + section path + content (what gets embedded / full-text indexed)
  tokens: number;
};

const estTokens = (s: string) => Math.ceil(s.length / 4);

// Approximation of GitHub-style heading anchors. Spot-check a few against the live site.
const slug = (h: string) =>
  h
    .toLowerCase()
    .replace(/[`*_~[\]()<>!?.,:;'"/\\{}|=+&^%$#@]/g, '')
    .trim()
    .replace(/\s+/g, '-');

function kindOf(p: string): Kind {
  if (p.startsWith('/cookbook')) return 'cookbook';
  if (p.startsWith('/docs/reference')) return 'reference';
  if (p.startsWith('/docs/migration-guides')) return 'migration-guide';
  if (p.startsWith('/docs/troubleshooting')) return 'troubleshooting';
  return 'guide';
}

function stripBoilerplate(md: string): string {
  return md
    .replace(/^---\n[\s\S]*?\n---\n/, '') // frontmatter
    .replace(/^> For an index of all documentation.*$/m, '')
    .replace(/\n---\n\s*For a semantic overview[\s\S]*$/, '') // footer links
    // collapse column padding in markdown tables (it's ~half the chars in big tables)
    .replace(/^\|.*\|\s*$/gm, (row) => row.replace(/ {2,}/g, ' ').replace(/-{4,}/g, '---'))
    .trim();
}

type Section = { headings: string[]; body: string };

// Split on ## / ### headings, ignoring anything inside ``` fences.
// #### and deeper stay inside their parent section.
function splitSections(md: string): Section[] {
  const sections: Section[] = [];
  let stack: string[] = [];
  let buf: string[] = [];
  let inFence = false;

  const flush = () => {
    const body = buf.join('\n').trim();
    if (body) sections.push({ headings: [...stack], body });
    buf = [];
  };

  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence && line.match(/^(#{2,3})\s+(.+?)\s*#*$/);
    if (m && m[1] && m[2]) {
      flush();
      const level = m[1].length - 2; // ## → 0, ### → 1
      stack = [...stack.slice(0, level), m[2]];
      continue;
    }
    buf.push(line);
  }
  flush();
  return sections;
}

// Break text into blocks that are never split internally: code fences stay whole,
// and long lists break only at top-level items ("- " at column 0).
function blocks(text: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let inFence = false;
  const push = () => {
    if (cur.join('').trim()) out.push(cur.join('\n'));
    cur = [];
  };
  for (const line of text.split('\n')) {
    const fence = /^\s*(```|~~~)/.test(line);
    if (!inFence && (line.trim() === '' || /^- /.test(line)) && cur.length) {
      // a blank line or a new top-level list item starts a new block
      if (line.trim() === '') {
        push();
        continue;
      }
      push();
    }
    if (fence && !inFence) push();
    cur.push(line);
    if (fence) inFence = !inFence;
    if (fence && !inFence) push();
  }
  push();
  return out;
}

// Split one oversized block:
// - a table → row groups, each repeating the header
// - a list item with a big nested list → split at child items, each prefixed with the parent line
// - anything else (a huge code sample) stays whole
function splitBlock(b: string): string[] {
  if (estTokens(b) <= MAX_TOKENS) return [b];
  const lines = b.split('\n');

  if (lines.every((l) => l.startsWith('|'))) {
    const header = lines.slice(0, 2);
    return groupLines(lines.slice(2), header);
  }

  const indents = lines
    .slice(1)
    .map((l) => l.match(/^( +)- /)?.[1]?.length)
    .filter((n): n is number => n !== undefined);
  if (lines[0] && indents.length) {
    const child = Math.min(...indents);
    const items: string[] = [];
    let cur: string[] = [];
    for (const l of lines.slice(1)) {
      if (l.startsWith(' '.repeat(child) + '- ') && !l.startsWith(' '.repeat(child + 1)) && cur.length) {
        items.push(cur.join('\n'));
        cur = [];
      }
      cur.push(l);
    }
    if (cur.length) items.push(cur.join('\n'));
    // recurse into children that are still too big, then pack them under the parent line
    return groupLines(items.flatMap((i) => splitBlock(i)), [lines[0]]);
  }
  return [b];
}

// Greedily group lines/items under a repeated prefix so each group stays <= MAX_TOKENS.
function groupLines(items: string[], prefix: string[]): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  for (const it of items) {
    if (cur.length && estTokens([...prefix, ...cur, it].join('\n')) > MAX_TOKENS) {
      out.push([...prefix, ...cur].join('\n'));
      cur = [];
    }
    cur.push(it);
  }
  if (cur.length) out.push([...prefix, ...cur].join('\n'));
  return out;
}

// Pack blocks into pieces <= MAX_TOKENS.
function pack(text: string): string[] {
  if (estTokens(text) <= MAX_TOKENS) return [text];
  const pieces: string[] = [];
  let cur = '';
  for (const b of blocks(text).flatMap(splitBlock)) {
    const sep = /^- /.test(b) && /(^|\n)- /.test(cur) ? '\n' : '\n\n';
    const next = cur ? cur + sep + b : b;
    if (cur && estTokens(next) > MAX_TOKENS) {
      pieces.push(cur);
      cur = b;
    } else cur = next;
  }
  if (cur) pieces.push(cur);
  return pieces;
}

const heading = (s: Section) => s.headings.at(-1);

// A section's body with its own heading line in front, at its original level (### for ['A', 'B']).
const withHeading = (s: Section) => {
  const h = heading(s);
  return h ? `${'#'.repeat(s.headings.length + 1)} ${h}\n\n${s.body}` : s.body;
};

function chunkPage(p: { path: string; url: string; title: string }, md: string): Chunk[] {
  const sections = splitSections(stripBoilerplate(md));

  // Tiny sections (e.g. a "## Import" with a one-line code block) are grouped with the sections after
  // them until the group reaches MIN_TOKENS. A group is labeled by its FIRST section, where the chunk
  // starts (crumb, embed_text and URL anchor); every later section keeps its heading inline. A tiny
  // section at the end of a page joins the previous group, also with its heading inline.
  // (Before: a group took the LAST section's label, and that section's heading was missing from the
  // content, so "Parallel Requests" + "Retries" was labeled "Retries" with no "Retries" heading.)
  const groups: Section[][] = [];
  let open: Section[] = [];
  for (const s of sections) {
    open.push(s);
    if (estTokens(open.map((x) => x.body).join('\n\n')) >= MIN_TOKENS) {
      groups.push(open);
      open = [];
    }
  }
  if (open.length) {
    const last = groups.at(-1);
    if (last) last.push(...open);
    else groups.push(open);
  }

  const merged: Section[] = groups.map(([first, ...rest]) => ({
    headings: first!.headings,
    body: [first!.body, ...rest.map(withHeading)].join('\n\n'),
  }));

  const chunks: Chunk[] = [];
  for (const s of merged) {
    const pieces = pack(s.body);
    pieces.forEach((content, i) => {
      const section = pieces.length > 1 ? [...s.headings.slice(0, -1), `${heading(s) ?? p.title} (${i + 1}/${pieces.length})`] : s.headings;
      const crumb = [p.title, ...s.headings].join(' > ');
      const h = heading(s);
      chunks.push({
        id: `${p.path}#${chunks.length}`,
        path: p.path,
        url: h ? `${p.url}#${slug(h)}` : p.url,
        title: p.title,
        section,
        kind: kindOf(p.path),
        content,
        embed_text: `${crumb}\n\n${content}`,
        tokens: estTokens(content),
      });
    });
  }
  return chunks;
}

function fileFor(pagePath: string, all: string[]): string {
  const isParent = all.some((o) => o.startsWith(pagePath + '/'));
  return path.join(CORPUS, isParent ? `${pagePath}/_index.md` : `${pagePath}.md`);
}

async function main() {
  const manifest = JSON.parse(await readFile(path.join(CORPUS, '_manifest.json'), 'utf8')) as {
    pages: { path: string; url: string; title: string | null }[];
  };
  const allPaths = manifest.pages.map((p) => p.path);

  const chunks: Chunk[] = [];
  for (const p of manifest.pages) {
    const md = await readFile(fileFor(p.path, allPaths), 'utf8');
    chunks.push(...chunkPage({ path: p.path, url: p.url, title: p.title ?? p.path }, md));
  }

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, chunks.map((c) => JSON.stringify(c)).join('\n') + '\n');

  // Stats
  const sizes = chunks.map((c) => c.tokens).sort((a, b) => a - b);
  const pct = (q: number) => sizes[Math.min(sizes.length - 1, Math.floor(q * sizes.length))];
  const total = sizes.reduce((a, b) => a + b, 0);
  const byKind = Object.entries(
    chunks.reduce<Record<string, number>>((acc, c) => ((acc[c.kind] = (acc[c.kind] ?? 0) + 1), acc), {}),
  );

  console.log(`${manifest.pages.length} pages → ${chunks.length} chunks, ~${Math.round(total / 1000)}k tokens`);
  console.log(`tokens p10=${pct(0.1)} p50=${pct(0.5)} p90=${pct(0.9)} max=${sizes.at(-1)}`);
  console.log(`over ${MAX_TOKENS}: ${sizes.filter((s) => s > MAX_TOKENS).length}, under ${MIN_TOKENS}: ${sizes.filter((s) => s < MIN_TOKENS).length}`);
  console.log('by kind:', Object.fromEntries(byKind));
  console.log('largest:');
  for (const c of [...chunks].sort((a, b) => b.tokens - a.tokens).slice(0, 5))
    console.log(`  ${c.tokens}  ${c.path}  [${c.section.join(' > ')}]`);
}

main();
