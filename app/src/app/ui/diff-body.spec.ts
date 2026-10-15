import { render } from '../../testing/render';
import { DiffBody } from './diff-body';

describe('DiffBody', () => {
  it('renders add, del and ctx lines with their gutter marks', async () => {
    const { container } = await render(DiffBody, { oldText: 'a\nb\nc', newText: 'a\nB\nc' });
    expect(container.querySelector('.k-toolcard__dl--del')!.textContent).toBe('-b');
    expect(container.querySelector('.k-toolcard__dl--add')!.textContent).toBe('+B');
    expect(container.querySelectorAll('.k-toolcard__dl--ctx')).toHaveLength(2);
  });

  // The Svelte original mocked `diff` to return undefined. This port does not
  // mock modules, so it drives the real timeout: two entirely different texts
  // large enough that the Myers search cannot finish within DIFF_TIMEOUT_MS,
  // which makes diffLines return undefined.
  it('falls back to before / after blocks when the diff times out', async () => {
    const big = (tag: string) => Array.from({ length: 12000 }, (_, i) => `${tag}${i}`).join('\n');
    const { container } = await render(DiffBody, { oldText: big('o'), newText: big('n') });
    const labels = [...container.querySelectorAll('.k-toolcard__label')].map((l) => l.textContent);
    expect(labels).toEqual(['before', 'after']);
    expect(container.querySelector('.k-toolcard__dl')).toBeNull();
    expect(container.querySelectorAll('.k-toolcard__out')).toHaveLength(2);
  }, 30000);
});
