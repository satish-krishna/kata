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

  it('renders a finding as markdown', async () => {
    const { container } = await mount({ findings: [{ severity: 'medium', text: 'Retry skips `limit()`, **twice**.\n\n- in `store.rs`\n- in `api.rs`' }] });
    const body = container.querySelector('.k-findings__text')!;
    expect(Array.from(body.querySelectorAll('code')).map((c) => c.textContent)).toEqual(['limit()', 'store.rs', 'api.rs']);
    expect(body.querySelector('strong')!.textContent).toBe('twice');
    expect(body.textContent).not.toContain('`');
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

  describe('picking a finding', () => {
    const located: Finding[] = [
      { severity: 'high', text: 'The limit is not enforced on retry', file: 'src/a.ts', line: 4 },
      { severity: null, text: 'The refusal message has no test' },
    ];

    it('a finding that names a file is a button that picks it', async () => {
      const picks: Finding[] = [];
      const { fixture, container } = await mount({ findings: located });
      fixture.componentInstance.pick.subscribe((f) => picks.push(f));
      const items = Array.from(container.querySelectorAll('li'));
      const button = items[0].querySelector('button')!;
      expect(button.textContent!.trim()).toBe('src/a.ts:4');
      button.click();
      expect(picks).toEqual([located[0]]);
    });

    it('a finding that names no file says so under it and picks nothing', async () => {
      const picks: Finding[] = [];
      const { fixture, container } = await mount({ findings: located });
      fixture.componentInstance.pick.subscribe((f) => picks.push(f));
      const second = container.querySelectorAll('li')[1];
      expect(second.querySelector('button')).toBeNull();
      expect(second.textContent).toContain('This finding names no file.');
      expect(picks).toEqual([]);
    });

    it('marks the picked finding as pressed', async () => {
      const { container } = await mount({ findings: located, picked: { file: 'src/a.ts', line: 4, text: located[0].text, n: 1 } });
      expect(container.querySelector('li button')!.getAttribute('aria-pressed')).toBe('true');
    });
  });
});
