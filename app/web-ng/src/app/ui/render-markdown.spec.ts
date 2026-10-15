import { renderMarkdown, renderMarkdownForDom } from './render-markdown';

describe('renderMarkdown', () => {
  it('renders GFM: strong, tables, task lists, strikethrough', () => {
    const html = renderMarkdown('**a** ~~b~~\n\n| x |\n|---|\n| 1 |\n\n- [x] done');
    expect(html).toContain('<strong>a</strong>');
    expect(html).toContain('<del>b</del>');
    expect(html).toContain('<table>');
    expect(html).toContain('type="checkbox"');
  });

  it('never renders raw HTML from the model', () => {
    const html = renderMarkdown('hi <img src=x onerror=alert(1)> <script>alert(2)</script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
  });

  it('drops javascript: link targets', () => {
    expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('javascript:');
  });

  it('drops javascript: targets written as reference or autolink-style links', () => {
    expect(renderMarkdown('[x][r]\n\n[r]: javascript:alert(1)')).not.toContain('javascript:');
    expect(renderMarkdown('<javascript:alert(1)>')).not.toContain('href="javascript:');
  });

  it('drops raw HTML blocks, not just inline tags', () => {
    const html = renderMarkdown('<div onclick="alert(1)">x</div>\n\n<iframe src="https://evil"></iframe>');
    expect(html).not.toContain('<div');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('onclick');
  });

  it('turns task-list checkboxes into spans for the DOM pipeline', () => {
    const html = renderMarkdownForDom('- [x] done\n- [ ] todo');
    expect(html).not.toContain('<input');
    expect(html).toContain('k-md__task k-md__task--done');
    expect(html).toContain('aria-checked="false"');
  });
});
