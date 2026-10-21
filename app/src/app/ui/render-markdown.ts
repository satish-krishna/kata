import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeSanitize from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import rehypeHighlight from 'rehype-highlight';
import gherkin from 'highlight.js/lib/languages/gherkin';
import type { HLJSApi, Language } from 'highlight.js';
import type { Element, Nodes, Root } from 'hast';
import { headingSlugger } from '../lib/doc';

/** The same remark + GFM parse the original markdown renderer used, sanitized and serialized
 *  to HTML. Raw HTML in the source is dropped (remark-rehype ignores it unless
 *  allowDangerousHtml is set), and rehype-sanitize applies GitHub's schema to
 *  whatever remains. */
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype).use(rehypeSanitize).use(rehypeStringify);

export function renderMarkdown(md: string): string {
  return String(processor.processSync(md));
}

/** Rewrites each GFM task-list `<input type="checkbox">` into a span. Angular's
 *  innerHTML sanitizer strips every `<input>`, so the real checkbox would vanish
 *  from the DOM; the span keeps the box and its state, drawn by `.k-md__task`. */
function taskCheckboxesToSpans() {
  const walk = (node: Nodes): void => {
    if (!('children' in node)) return;
    node.children = node.children.map((child) => {
      if (child.type === 'element' && child.tagName === 'input' && child.properties['type'] === 'checkbox') {
        const done = child.properties['checked'] === true;
        const span: Element = {
          type: 'element',
          tagName: 'span',
          properties: {
            className: done ? ['k-md__task', 'k-md__task--done'] : ['k-md__task'],
            role: 'checkbox',
            'aria-checked': done ? 'true' : 'false',
            'aria-disabled': 'true',
          },
          children: [],
        };
        return span;
      }
      walk(child);
      return child;
    });
  };
  return (tree: Root): void => walk(tree);
}

/** The text a hast node shows. */
function textOf(node: Nodes): string {
  if (node.type === 'text') return node.value;
  return 'children' in node ? node.children.map(textOf).join('') : '';
}

/** Gives each heading element the id `outline` computes for it, so an outline entry can scroll to it. Runs after
 *  sanitizing, which would prefix a hand-written id. */
function headingIds() {
  return (tree: Root): void => {
    const next = headingSlugger();
    const walk = (node: Nodes): void => {
      if (!('children' in node)) return;
      for (const child of node.children) {
        if (child.type !== 'element') continue;
        if (/^h[1-6]$/.test(child.tagName)) child.properties['id'] = next(textOf(child).trim());
        walk(child);
      }
    };
    walk(tree);
  };
}

/** highlight.js's Gherkin grammar predates Gherkin 6, so it misses `Rule` and `Example`, which ai-sdlc specs use. */
function gherkin6(hljs: HLJSApi): Language {
  const g = gherkin(hljs);
  return { ...g, keywords: `${String(g.keywords)} Rule Example` };
}

/* Highlighting runs after sanitizing: the GitHub schema would strip the hljs-* classes, and the
 * spans it adds are generated from the already-sanitized text. Only Gherkin is registered, so any
 * other fenced language, Mermaid included, stays plain for MarkdownBody to pick up. */
const domProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeSanitize)
  .use(rehypeHighlight, { languages: { gherkin: gherkin6 }, detect: false })
  .use(headingIds)
  .use(taskCheckboxesToSpans)
  .use(rehypeStringify);

/** Same pipeline as `renderMarkdown`, shaped for binding through Angular's
 *  `[innerHTML]` (task checkboxes become spans, since `<input>` would be stripped). */
export function renderMarkdownForDom(md: string): string {
  return String(domProcessor.processSync(md));
}
