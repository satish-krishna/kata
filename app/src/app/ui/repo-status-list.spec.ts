import { render } from '../../testing/render';
import { RepoStatusList, type RepoRow } from './repo-status-list';

const rows: RepoRow[] = [
  { name: 'claims-core', tone: 'success', label: 'Working · T1', clock: 'work 0:12 of 1:30:00', paused: null },
  { name: 'customer-portal', tone: 'warning', label: 'Waiting for you', clock: 'work 0:05 of 1:30:00', paused: '0:07 waiting (not counted)' },
  { name: 'review', tone: 'idle', label: 'Not started', clock: null, paused: null },
];
const mount = (inputs: Record<string, unknown> = {}) => render(RepoStatusList, { rows, selected: 'claims-core', ...inputs });
const items = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLButtonElement>('button'));

describe('RepoStatusList', () => {
  it('has a row per repository and one for the review, each with its name in mono', async () => {
    const { container } = await mount();
    expect(items(container).map((b) => b.querySelector('.k-mono')!.textContent!.trim())).toEqual(['claims-core', 'customer-portal', 'review']);
  });

  it('shows the status as a dot and a label, never colour alone', async () => {
    const { container } = await mount();
    const [first, second, third] = items(container);
    expect(first.querySelector('.k-status--success .k-status__dot')).not.toBeNull();
    expect(first.textContent).toContain('Working · T1');
    expect(second.querySelector('.k-status--warning .k-status__dot')).not.toBeNull();
    expect(second.textContent).toContain('Waiting for you');
    expect(third.querySelector('.k-status--idle .k-status__dot')).not.toBeNull();
    expect(third.textContent).toContain('Not started');
  });

  it('shows the work clock, and the waiting clock only while the run waits', async () => {
    const { container } = await mount();
    const [first, second] = items(container);
    expect(first.textContent).toContain('work 0:12 of 1:30:00');
    expect(first.textContent).not.toContain('waiting (not counted)');
    expect(second.textContent).toContain('0:07 waiting (not counted)');
  });

  it('marks the selected row and says which repository a click selects', async () => {
    const { container, fixture } = await mount();
    const picked = vi.fn();
    fixture.componentInstance.select.subscribe(picked);
    expect(items(container).map((b) => b.getAttribute('aria-current'))).toEqual(['true', null, null]);
    items(container)[1].click();
    expect(picked).toHaveBeenCalledWith('customer-portal');
  });
});
