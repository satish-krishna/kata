import { renderInlineMarkdownForDom, renderMarkdown, renderMarkdownForDom } from './render-markdown';

describe('renderInlineMarkdownForDom', () => {
  it('renders one line without the paragraph around it', () => {
    expect(renderInlineMarkdownForDom('Add the `picker` **now**')).toBe('Add the <code>picker</code> <strong>now</strong>');
  });

  it('keeps a link as its text, so a name inside a button holds nothing clickable', () => {
    expect(renderInlineMarkdownForDom('See [the docs](https://example.com)')).toBe('See the docs');
  });

  it('never renders raw HTML', () => {
    expect(renderInlineMarkdownForDom('a <img src=x onerror=alert(1)>')).not.toContain('<img');
  });
});

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

  it('highlights gherkin blocks, including the Rule keyword', () => {
    const html = renderMarkdownForDom('```gherkin\nFeature: Upload\n  Rule: R1\n    Scenario: <one>\n      Given a claim # note\n```');
    expect(html).toContain('<span class="hljs-keyword">Feature</span>');
    expect(html).toContain('<span class="hljs-keyword">Rule</span>');
    expect(html).toContain('<span class="hljs-keyword">Given</span>');
    expect(html).toContain('<span class="hljs-variable">&#x3C;one></span>');
    expect(html).toContain('<span class="hljs-comment"># note</span>');
  });

  it('leaves other fenced languages, mermaid included, as plain code for the DOM', () => {
    const html = renderMarkdownForDom('```mermaid\nflowchart LR\n  A --> B\n```\n\n```rust\nfn main() {}\n```');
    expect(html).toMatch(/<code class="[^"]*language-mermaid[^"]*">flowchart LR\n {2}A --> B/);
    expect(html).toMatch(/<code class="[^"]*language-rust[^"]*">fn main\(\) \{\}/);
    expect(html).not.toContain('hljs-');
  });

  it('cannot smuggle markup through a highlighted block', () => {
    const html = renderMarkdownForDom('```gherkin\nGiven "<img src=x onerror=alert(1)>"\n```');
    expect(html).not.toContain('<img');
  });
});
