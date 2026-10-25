import { render } from '../../testing/render';
import type { Finding } from '../lib/sdlc';
import type { FindingGroup } from '../lib/sdlc-findings';
import { FindingsList } from './findings-list';

const findings: Finding[] = [
  { severity: 'high', text: 'The limit is not enforced on retry' },
  { severity: null, text: 'The refusal message has no test' },
];
const one = (list: Finding[]): FindingGroup[] => [{ repo: null, findings: list }];
const mount = (inputs: Record<string, unknown> = {}) => render(FindingsList, { groups: one(findings), ...inputs });

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
    const { container } = await mount({ groups: one([{ severity: 'medium', text: 'Retry skips `limit()`, **twice**.\n\n- in `store.rs`\n- in `api.rs`' }]) });
    const body = container.querySelector('.k-findings__text')!;
    expect(Array.from(body.querySelectorAll('code')).map((c) => c.textContent)).toEqual(['limit()', 'store.rs', 'api.rs']);
    expect(body.querySelector('strong')!.textContent).toBe('twice');
    expect(body.textContent).not.toContain('`');
  });

  it('says so when the review found nothing', async () => {
    const { container } = await mount({ groups: one([]) });
    expect(container.querySelectorAll('li').length).toBe(0);
    expect(container.textContent).toContain('The review found nothing.');
  });

  it('keeps a replaced review collapsed under the time of the review that replaced it', async () => {
    const { container } = await mount({ replaced: [{ at: '09:30:00', groups: one([{ severity: null, text: 'Old finding' }]) }] });
    const details = container.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')!.textContent!.trim()).toBe('Replaced by the review at 09:30:00');
    expect(details.textContent).toContain('Old finding');
    expect(container.querySelectorAll('li').length).toBe(3);
  });

  describe('groups by repository (R8.1)', () => {
    const a: Finding = { severity: 'high', text: 'In api', repo: 'api' };
    const b: Finding = { severity: 'low', text: 'In web', repo: 'web' };
    const c: Finding = { severity: 'medium', text: 'Names none' };
    const headings = (container: HTMLElement) => Array.from(container.querySelectorAll('h3')).map((h) => Array.from(h.children, (c) => c.textContent).join(' '));

    it('shows a heading per named group with the repository and its count', async () => {
      const { container } = await mount({
        groups: [
          { repo: 'api', findings: [a] },
          { repo: 'web', findings: [b, { ...b, text: 'Another' }] },
        ],
      });
      expect(headings(container)).toEqual(['api 1', 'web 2']);
      expect(container.querySelector('h3 .k-mono')!.textContent).toBe('api');
      expect(container.querySelectorAll('li').length).toBe(3);
    });

    it('heads the group with no repository "Repository not recorded" only after named groups', async () => {
      const { container } = await mount({
        groups: [
          { repo: 'api', findings: [a] },
          { repo: null, findings: [c] },
        ],
      });
      expect(headings(container)).toEqual(['api 1', 'Repository not recorded 1']);
    });

    it('gives a lone group with no repository no heading', async () => {
      const { container } = await mount({ groups: one([c]) });
      expect(container.querySelectorAll('h3').length).toBe(0);
      expect(container.textContent).not.toContain('Repository not recorded');
    });

    it('groups a replaced review the same way', async () => {
      const { container } = await mount({ replaced: [{ at: '09:30:00', groups: [{ repo: 'web', findings: [b] }] }] });
      expect(headings(container)).toContain('web 1');
    });
  });

  describe('what a finding concerns (R8.2)', () => {
    const labelOf = async (f: Finding) => {
      const { container } = await mount({ groups: one([f]) });
      return container.querySelector('.k-findings__concern')?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
    };

    it('says spec for a spec finding', async () => {
      expect(await labelOf({ severity: 'high', concern: 'spec', text: 't' })).toBe('spec');
    });

    it('says bug for a bug finding', async () => {
      expect(await labelOf({ severity: 'high', concern: 'bug', text: 't' })).toBe('bug');
    });

    it('says convention and the rule it cites', async () => {
      expect(await labelOf({ severity: 'high', concern: 'convention', rule: 'CONTRIBUTING.md:18', text: 't' })).toBe('convention rule: CONTRIBUTING.md:18');
    });

    it('shows nothing extra for a finding with no concern', async () => {
      const { container } = await mount({ groups: one([{ severity: 'high', text: 't' }]) });
      expect(container.querySelector('.k-findings__concern')).toBeNull();
      expect(container.querySelector('li')!.textContent).not.toContain('rule:');
    });
  });

  describe('picking a finding', () => {
    const located: Finding[] = [
      { severity: 'high', text: 'The limit is not enforced on retry', file: 'src/a.ts', line: 4 },
      { severity: null, text: 'The refusal message has no test' },
    ];

    it('a finding that names a file is a button that picks it', async () => {
      const picks: Finding[] = [];
      const { fixture, container } = await mount({ groups: one(located) });
      fixture.componentInstance.pick.subscribe((f) => picks.push(f));
      const items = Array.from(container.querySelectorAll('li'));
      const button = items[0].querySelector('button')!;
      expect(button.textContent!.trim()).toBe('src/a.ts:4');
      button.click();
      expect(picks).toEqual([located[0]]);
    });

    it('a finding that names no file says so under it and picks nothing', async () => {
      const picks: Finding[] = [];
      const { fixture, container } = await mount({ groups: one(located) });
      fixture.componentInstance.pick.subscribe((f) => picks.push(f));
      const second = container.querySelectorAll('li')[1];
      expect(second.querySelector('button')).toBeNull();
      expect(second.textContent).toContain('This finding names no file.');
      expect(picks).toEqual([]);
    });

    it('marks the picked finding as pressed', async () => {
      const { container } = await mount({ groups: one(located), picked: { file: 'src/a.ts', line: 4, text: located[0].text, n: 1 } });
      expect(container.querySelector('li button')!.getAttribute('aria-pressed')).toBe('true');
    });
  });
});
