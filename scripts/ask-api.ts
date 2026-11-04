/**
 * Ask the running API a question from the terminal and print the streamed answer + sources.
 *
 *   npm run ask -- "How do I stop a tool loop after 5 steps?"
 *   npm run ask -- "How do I stop a tool loop after 5 steps?" --model qwen
 *
 * Needs the API running (withsecrets npm run dev:api). This script itself needs no secrets.
 */
const API = process.env.API_URL ?? 'http://127.0.0.1:3000';

const args = process.argv.slice(2);
const modelIdx = args.indexOf('--model');
const model = modelIdx === -1 ? undefined : args[modelIdx + 1];
const question = args
  .filter((_, i) => modelIdx === -1 || (i !== modelIdx && i !== modelIdx + 1))
  .join(' ')
  .trim();
if (!question) {
  console.error('Usage: npm run ask -- "your question" [--model qwen|mistral]');
  process.exit(1);
}

const res = await fetch(`${API}/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    id: 'cli',
    messages: [{ id: 'q', role: 'user', parts: [{ type: 'text', text: question }] }],
    ...(model ? { model } : {}),
  }),
});
if (!res.ok || !res.body) {
  console.error(`HTTP ${res.status}: ${await res.text()}`);
  process.exit(1);
}

type Chunk =
  | { type: 'start'; messageMetadata?: { model?: string; sources?: number; retrievalMs?: number } }
  | { type: 'source-url'; sourceId: string; url: string; title?: string }
  | { type: 'text-delta'; delta: string }
  | { type: 'finish'; messageMetadata?: { totalTokens?: number; durationMs?: number } }
  | { type: 'error'; errorText: string }
  | { type: string };

const sources: { id: string; title: string | undefined; url: string }[] = [];
const decoder = new TextDecoder();
let buffer = '';

for await (const bytes of res.body) {
  buffer += decoder.decode(bytes, { stream: true });
  const events = buffer.split('\n\n');
  buffer = events.pop() ?? '';
  for (const event of events) {
    const data = event.replace(/^data: /, '');
    if (!data || data === '[DONE]') continue;
    const c = JSON.parse(data) as Chunk;
    if (c.type === 'start' && 'messageMetadata' in c && c.messageMetadata) {
      const m = c.messageMetadata;
      console.log(`[${m.model}, ${m.sources} sources, retrieval ${m.retrievalMs} ms]\n`);
    } else if (c.type === 'source-url' && 'url' in c) sources.push({ id: c.sourceId, title: c.title, url: c.url });
    else if (c.type === 'text-delta' && 'delta' in c) process.stdout.write(c.delta);
    else if (c.type === 'error' && 'errorText' in c) console.error(`\nERROR: ${c.errorText}`);
    else if (c.type === 'finish' && 'messageMetadata' in c && c.messageMetadata) {
      const m = c.messageMetadata;
      console.log(`\n\n[${m.totalTokens} tokens, ${((m.durationMs ?? 0) / 1000).toFixed(1)} s]`);
    }
  }
}

console.log('\nSources:');
for (const s of sources) console.log(`  [${s.id}] ${s.title}\n      ${s.url}`);
