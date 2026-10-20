import { render } from '../../testing/render';
import type { Finding } from '../lib/sdlc';
import { FindingsList } from './findings-list';

const findings: Finding[] = [
  { severity: 'high', text: 'The limit is not enforced on retry' },
  { severity: null, text: 'The refusal message has no test' },
];
const mount = (inputs: Record<string, unknown> = {}) => render(FindingsList, { findings, ...inputs });

describe('FindingsList', () => {
  it('lists the findings in the order given, each with a severity label beside its dot', async () => {
    const { container } = await mount();
    const items = Array.from(container.querySelectorAll('li'));
    expect(items.map((li) => li.querySelector('.k-findings__text')!.textContent!.trim())).toEqual([
      'The limit is not enforced on retry',
      'The refusal message has no test',
    ]);
    expect(items[0].querySelector('.k-status--error .k-status__dot')).not.toBeNull();
    expect(items[0].textContent).toContain('High');
    expect(items[1].textContent).toContain('Finding');
  });

  it('says so when the review found nothing', async () => {
    const { container } = await mount({ findings: [] });
    expect(container.querySelectorAll('li').length).toBe(0);
    expect(container.textContent).toContain('The review found nothing.');
  });

  it('keeps a replaced review collapsed under the time of the review that replaced it', async () => {
    const { container } = await mount({ replaced: [{ at: '09:30:00', findings: [{ severity: null, text: 'Old finding' }] }] });
    const details = container.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')!.textContent!.trim()).toBe('Replaced by the review at 09:30:00');
    expect(details.textContent).toContain('Old finding');
    expect(container.querySelectorAll('li').length).toBe(3);
  });
});
