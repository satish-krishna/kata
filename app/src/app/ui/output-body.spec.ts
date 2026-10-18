import { render } from '../../testing/render';
import { JsonBody } from './json-body';
import { OutputBody } from './output-body';

describe('OutputBody', () => {
  it('renders the text in a code block content pre', async () => {
    const { container } = await render(OutputBody, { text: 'line 1\nline 2' });
    const pre = container.querySelector('hlm-code-block pre[hlmCodeBlockContent]')!;
    expect(pre.textContent).toBe('line 1\nline 2');
  });

  it('says (no output) for empty text', async () => {
    const { container } = await render(OutputBody, { text: '' });
    expect(container.querySelector('pre[hlmCodeBlockContent]')!.textContent).toBe('(no output)');
  });

  it('puts the truncation note in the code block footer, only when truncated', async () => {
    const { container, fixture } = await render(OutputBody, { text: 'x', truncated: true });
    expect(container.querySelector('[data-slot=code-block-footer]')!.textContent).toBe('… truncated at 256 KB');
    fixture.componentRef.setInput('truncated', false);
    await fixture.whenStable();
    expect(container.querySelector('[data-slot=code-block-footer]')).toBeNull();
  });

  it('has no copy button', async () => {
    const { container } = await render(OutputBody, { text: 'x' });
    expect(container.querySelector('button')).toBeNull();
  });
});

describe('JsonBody', () => {
  it('renders pretty JSON in a code block content pre', async () => {
    const { container } = await render(JsonBody, { value: { a: 1 } });
    expect(container.querySelector('hlm-code-block pre[hlmCodeBlockContent]')!.textContent).toBe('{\n  "a": 1\n}');
  });
});
