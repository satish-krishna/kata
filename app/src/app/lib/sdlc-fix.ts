import { parseFrontMatter } from './sdlc';

const unquote = (v: string): string => (v.length >= 2 && /^(["']).*\1$/.test(v) ? v.slice(1, -1) : v);

/** The description a new full-pipeline change starts from when a drafted fix is taken over: the fix's title, then the first paragraph under Problem. */
export function fullPipelineIdea(md: string): string {
  const { fields, body } = parseFrontMatter(md.replace(/\r\n/g, '\n'));
  const title = unquote(fields.find(([k]) => k === 'title')?.[1] ?? '');
  const lines = body.split('\n');
  const at = lines.findIndex((l) => /^##[ \t]+Problem[ \t]*$/.test(l));
  if (at < 0) return title;
  const paragraph: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (/^#{1,6}[ \t]/.test(line)) break;
    if (line.trim() === '') {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(line.trimEnd());
  }
  return paragraph.length === 0 ? title : `${title}\n\n${paragraph.join('\n')}`;
}
