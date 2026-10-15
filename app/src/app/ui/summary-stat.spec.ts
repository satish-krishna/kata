import { render } from '../../testing/render';
import { SummaryStat } from './summary-stat';

describe('SummaryStat', () => {
  it('renders label and value with the tone class', async () => {
    const { container } = await render(SummaryStat, { label: 'Turns', value: 12, tone: 'success' });
    expect(container.querySelector('.k-stat__label')!.textContent).toBe('Turns');
    const v = container.querySelector('.k-stat__value')!;
    expect(v.textContent).toBe('12');
    expect(v.classList.contains('k-stat__value--success')).toBe(true);
  });
});
