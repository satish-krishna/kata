import { render } from '../../testing/render';
import { DocView } from './doc-view';

describe('DocView', () => {
  it('shows the document name, the front matter as one mono line, and the rendered body', async () => {
    const { container } = await render(DocView, { name: 'spec.md', frontMatter: 'status: draft', body: '# Spec\n\n- one\n' });
    expect(container.querySelector('.k-doc__name')!.textContent!.trim()).toBe('spec.md');
    const fm = container.querySelector('.k-doc__front')!;
    expect(fm.textContent!.trim()).toBe('status: draft');
    expect(container.querySelector('h1')!.textContent).toBe('Spec');
    expect(container.querySelectorAll('li').length).toBe(1);
  });

  it('omits the front matter line when there is none', async () => {
    const { container } = await render(DocView, { name: 'intent.md', frontMatter: null, body: 'text' });
    expect(container.querySelector('.k-doc__front')).toBeNull();
  });
});
