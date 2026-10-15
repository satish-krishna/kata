import { render } from '../../testing/render';
import { MarkdownBody } from './markdown-body';

describe('MarkdownBody', () => {
  it('wraps output in a .k-md element', async () => {
    const { container } = await render(MarkdownBody, { md: 'text' });
    expect(container.querySelector('.k-md')).not.toBeNull();
  });

  it('renders **bold** as <strong>', async () => {
    const { container } = await render(MarkdownBody, { md: '**bold**' });
    const strong = container.querySelector('strong');
    expect(strong).not.toBeNull();
    expect(strong!.textContent).toBe('bold');
  });

  it('renders _italic_ as <em>', async () => {
    const { container } = await render(MarkdownBody, { md: '_italic_' });
    expect(container.querySelector('em')).not.toBeNull();
  });

  it('renders # Heading as a heading element', async () => {
    const { container } = await render(MarkdownBody, { md: '# Title' });
    expect(container.querySelector('h1, h2, h3, h4, h5, h6')).not.toBeNull();
    expect(container.querySelector('h1, h2, h3, h4, h5, h6')!.textContent).toBe('Title');
  });

  it('renders `inline code` as <code>', async () => {
    const { container } = await render(MarkdownBody, { md: 'use `fn()` here' });
    const code = container.querySelector('code');
    expect(code).not.toBeNull();
    expect(code!.textContent).toBe('fn()');
  });

  it('renders fenced code blocks as <pre><code>', async () => {
    const { container } = await render(MarkdownBody, { md: "```\nconsole.log('hi')\n```" });
    const preCode = container.querySelector('pre code');
    expect(preCode).not.toBeNull();
    expect(preCode!.textContent).toContain('console.log');
  });

  it('renders GFM pipe tables as <table> with <th> and <td>', async () => {
    const { container } = await render(MarkdownBody, { md: '| A | B |\n|---|---|\n| 1 | 2 |' });
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelector('th')).not.toBeNull();
    expect(container.querySelector('td')).not.toBeNull();
  });

  it('renders [text](url) links with the correct href', async () => {
    const { container } = await render(MarkdownBody, { md: '[kata](https://example.com)' });
    const a = container.querySelector('a');
    expect(a).not.toBeNull();
    expect(a!.getAttribute('href')).toBe('https://example.com');
  });

  it('does not execute <script> tags found in markdown content', async () => {
    (window as unknown as Record<string, unknown>)['__xss'] = undefined;
    const { container } = await render(MarkdownBody, { md: '<script>window.__xss = true</script>' });
    expect((window as unknown as Record<string, unknown>)['__xss']).toBeUndefined();
    expect(container.querySelector('script')).toBeNull();
  });

  it('renders raw HTML inert: no img, no handler attributes', async () => {
    const { container } = await render(MarkdownBody, {
      md: 'hi <img src=x onerror=alert(1)> <b onmouseover=alert(2)>b</b>',
    });
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).not.toContain('onerror');
    expect(container.innerHTML).not.toContain('onmouseover');
  });

  it('drops a javascript: link target', async () => {
    const { container } = await render(MarkdownBody, { md: '[x](javascript:alert(1))' });
    expect(container.innerHTML).not.toContain('javascript:');
  });

  // Angular's innerHTML sanitizer strips <input>, so task boxes render as spans.
  it('keeps the task-list boxes visible with their checked state', async () => {
    const { container } = await render(MarkdownBody, { md: '- [x] done\n- [ ] todo' });
    const boxes = container.querySelectorAll('.k-md__task');
    expect(boxes).toHaveLength(2);
    expect(boxes[0].classList.contains('k-md__task--done')).toBe(true);
    expect(boxes[0].getAttribute('aria-checked')).toBe('true');
    expect(boxes[1].classList.contains('k-md__task--done')).toBe(false);
    expect(boxes[1].getAttribute('aria-checked')).toBe('false');
  });

  it('renders an empty string without throwing', async () => {
    const { container } = await render(MarkdownBody, { md: '' });
    expect(container.querySelector('.k-md')).not.toBeNull();
  });

  describe('click delegation', () => {
    it('opens external links via window.open and prevents default', async () => {
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
      const { container } = await render(MarkdownBody, { md: '[link](https://example.com)' });
      const link = container.querySelector('a') as HTMLAnchorElement;
      const clickEvent = new MouseEvent('click', { bubbles: true });
      const preventDefaultSpy = vi.spyOn(clickEvent, 'preventDefault');
      link.dispatchEvent(clickEvent);
      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(openSpy).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
      openSpy.mockRestore();
    });

    it('does not open or prevent default for hash anchor links', async () => {
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
      const { container } = await render(MarkdownBody, { md: '[anchor](#section)' });
      const link = container.querySelector('a') as HTMLAnchorElement;
      const clickEvent = new MouseEvent('click', { bubbles: true });
      const preventDefaultSpy = vi.spyOn(clickEvent, 'preventDefault');
      link.dispatchEvent(clickEvent);
      expect(preventDefaultSpy).not.toHaveBeenCalled();
      expect(openSpy).not.toHaveBeenCalled();
      openSpy.mockRestore();
    });

    it('does not open links with unsafe protocols (javascript:)', async () => {
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
      const { container } = await render(MarkdownBody, { md: 'text' });
      // The pipeline drops javascript: hrefs, so inject a raw anchor to
      // exercise the handler's protocol guard directly.
      const kmdDiv = container.querySelector('.k-md') as HTMLElement;
      const a = document.createElement('a');
      a.setAttribute('href', 'javascript:window.__xss=true');
      a.textContent = 'evil';
      kmdDiv.appendChild(a);
      const clickEvent = new MouseEvent('click', { bubbles: true });
      const preventDefaultSpy = vi.spyOn(clickEvent, 'preventDefault');
      a.dispatchEvent(clickEvent);
      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(openSpy).not.toHaveBeenCalled();
      openSpy.mockRestore();
    });

    it('does not process clicks outside links', async () => {
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
      const { container } = await render(MarkdownBody, { md: 'text without links' });
      const kmdDiv = container.querySelector('.k-md') as HTMLElement;
      const clickEvent = new MouseEvent('click', { bubbles: true });
      const preventDefaultSpy = vi.spyOn(clickEvent, 'preventDefault');
      kmdDiv.dispatchEvent(clickEvent);
      expect(preventDefaultSpy).not.toHaveBeenCalled();
      expect(openSpy).not.toHaveBeenCalled();
      openSpy.mockRestore();
    });
  });
});
