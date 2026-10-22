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
  .use(taskCheckboxesToSpans)
  .use(rehypeStringify);

/** Same pipeline as `renderMarkdown`, shaped for binding through Angular's
 *  `[innerHTML]` (task checkboxes become spans, since `<input>` would be stripped). */
export function renderMarkdownForDom(md: string): string {
  return String(domProcessor.processSync(md));
}

/** Unwraps a lone top-level paragraph and turns each link into its text, so a one-line name can sit inside a
 *  heading or a button: a block there is invalid, and a link inside a button is a control inside a control. */
function inlineOnly() {
  const flatten = (nodes: Nodes[]): Nodes[] =>
    nodes.flatMap((node) => {
      if (node.type === 'element' && node.tagName === 'a') return flatten(node.children);
      if ('children' in node) node.children = flatten(node.children) as typeof node.children;
      return [node];
    });
  return (tree: Root): void => {
    const blocks = tree.children.filter((c) => c.type !== 'text' || c.value.trim() !== '');
    const only = blocks.length === 1 && blocks[0].type === 'element' && blocks[0].tagName === 'p' ? blocks[0] : null;
    tree.children = flatten(only ? only.children : tree.children) as Root['children'];
  };
}

const inlineProcessor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype).use(rehypeSanitize).use(inlineOnly).use(rehypeStringify);

/** One line of markdown for a name: code, emphasis and the like, with no paragraph around it and no links. */
export function renderInlineMarkdownForDom(md: string): string {
  return String(inlineProcessor.processSync(md));
}
