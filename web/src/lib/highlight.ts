import type { Element, Root } from 'hast';
import { toText } from 'hast-util-to-text';
import { createLowlight } from 'lowlight';
import { visit } from 'unist-util-visit';
import bash from 'highlight.js/lib/languages/bash';
import diff from 'highlight.js/lib/languages/diff';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import shell from 'highlight.js/lib/languages/shell';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';

// Only the languages used in the docs' code blocks (ts/tsx, bash/sh, js, json, diff, html).
// rehype-highlight would bundle ~35 grammars (~500 kB) whatever languages you pass it.
const lowlight = createLowlight({ bash, diff, javascript, json, shell, typescript, xml });

// rehype plugin: highlights <pre><code class="language-x"> blocks; unknown languages stay plain.
export function rehypeHighlightCode() {
  return (tree: Root) => {
    visit(tree, 'element', (node: Element, _index, parent) => {
      if (node.tagName !== 'code' || !parent || parent.type !== 'element' || parent.tagName !== 'pre') return;
      const classes = Array.isArray(node.properties.className) ? node.properties.className.map(String) : [];
      const lang = classes.find((c) => c.startsWith('language-'))?.slice('language-'.length);
      if (!lang || !lowlight.registered(lang)) return;
      node.children = lowlight.highlight(lang, toText(node, { whitespace: 'pre' })).children as Element['children'];
      node.properties.className = [...classes, 'hljs'];
    });
  };
}
