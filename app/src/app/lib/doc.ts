import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

/* Helpers over a markdown document that the change page's document layout shares: the heading outline and one `##`
 * section. The heading slug lives here too, so the outline's ids and the ids on the rendered heading elements come
 * from one function and a click on an outline entry can find its heading. */

export type Heading = { level: number; text: string; id: string };

/** A heading's anchor: lower case, punctuation dropped, each space a hyphen (GitHub's rule). */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

/** One slugger per document, fed headings in document order: the second `Approach` becomes `approach-1`. */
export function headingSlugger(): (text: string) => string {
  const used = new Map<string, number>();
  return (text) => {
    const base = slug(text);
    let id = base;
    let n = used.get(base);
    if (n !== undefined) {
      do {
        n += 1;
        id = `${base}-${n}`;
      } while (used.has(id));
      used.set(base, n);
    }
    used.set(id, 0);
    return id;
  };
}

type Node = { type: string; depth?: number; value?: string; children?: Node[] };

/** The text a node shows: its text and inline code, not raw HTML (the renderer drops it). */
function textOf(node: Node): string {
  if (node.type === 'html') return '';
  if (node.type === 'text' || node.type === 'inlineCode') return node.value ?? '';
  return (node.children ?? []).map(textOf).join('');
}

function headingsIn(node: Node, out: Node[]): void {
  if (node.type === 'heading') out.push(node);
  else node.children?.forEach((c) => headingsIn(c, out));
}

const parser = unified().use(remarkParse).use(remarkGfm);

/** Every heading of a markdown document in order. A leading front-matter block is not a heading. */
export function outline(md: string): Heading[] {
  const body = md.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
  const found: Node[] = [];
  headingsIn(parser.parse(body) as unknown as Node, found);
  const next = headingSlugger();
  return found.map((h) => {
    const text = textOf(h).trim();
    return { level: h.depth ?? 1, text, id: next(text) };
  });
}

/** The `## <heading>` section: from its heading line to the line before the next `## ` line, or `null`. */
export function section(md: string, heading: string): string | null {
  const lines = md.split(/\r?\n/);
  let fence = false;
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    if (start < 0) {
      if (line.trimEnd() === `## ${heading}`) start = i;
    } else if (line.startsWith('## ')) {
      end = i;
      break;
    }
  }
  if (start < 0) return null;
  return lines.slice(start, end).join('\n').trimEnd();
}
