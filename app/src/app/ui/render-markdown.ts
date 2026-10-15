import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeSanitize from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
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

const domProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeSanitize)
  .use(taskCheckboxesToSpans)
  .use(rehypeStringify);

/** Same pipeline as `renderMarkdown`, shaped for binding through Angular's
 *  `[innerHTML]` (task checkboxes become spans, since `<input>` would be stripped). */
export function renderMarkdownForDom(md: string): string {
  return String(domProcessor.processSync(md));
}
