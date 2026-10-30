import { render } from '../../testing/render';
import { progressLabels } from '../lib/progress-steps';
import type { StepsView } from '../core/lock/lock.store';
import { LockPanel } from './lock-panel';

const STEPS: StepsView = {
  kind: 'steps',
  title: 'Preparing workspace',
  steps: [
    { label: 'a', state: 'done', detail: 'ok' },
    { label: 'b', state: 'done', detail: null },
    { label: 'c', state: 'done', detail: null },
    { label: 'd', state: 'running', detail: null },
    { label: 'e', state: 'pending', detail: null },
  ],
};

const mount = (inputs: Record<string, unknown>) => render(LockPanel, { elapsed: 75, ...inputs });

describe('LockPanel', () => {
  it('names the elapsed time for screen readers', async () => {
    const { container } = await mount({ view: STEPS });
    expect(container.querySelector('.k-lock__clock .sr-only')?.textContent).toBe('Elapsed ');
  });

  it('shows done over total for steps and the elapsed clock', async () => {
    const { container } = await mount({ view: STEPS });
    expect(container.textContent).toContain('3 / 5');
    expect(container.textContent).toContain('1:15');
  });

  it('emits cancel', async () => {
    const r = await mount({ view: STEPS });
    const cancel = vi.fn();
    r.fixture.componentInstance.cancel.subscribe(cancel);
    (Array.from(r.container.querySelectorAll('button')).find((b) => b.textContent!.trim() === 'Cancel') as HTMLElement).click();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('never renders a percentage', async () => {
    const { container } = await mount({ view: STEPS });
    expect(container.textContent).not.toContain('%');
  });
});

describe('LockPanel progress line', () => {
  const entry = (label: string) => ({ line: 'Working on it…', label, long: false });
  const labels: [string, string][] = [
    ['the checks of a repository', progressLabels.runningChecks('commerce-core')],
    ['a push', progressLabels.pushing('2026-10-18-photo-limits', 'commerce-core')],
    ['a pull request', progressLabels.openingPr('customer-portal')],
  ];

  it.each(labels)('shows the plain label of %s', async (_what, label) => {
    const { container } = await mount({ view: STEPS, stepProgress: entry(label) });
    expect(container.querySelector('app-progress-line [data-testid="progress-label"]')?.textContent?.trim()).toBe(label);
  });

  it('names the repository in each plain label', () => {
    expect(progressLabels.runningChecks('commerce-core')).toBe('Running the checks in commerce-core');
    expect(progressLabels.pushing('2026-10-18-photo-limits', 'commerce-core')).toBe('Pushing change/2026-10-18-photo-limits in commerce-core');
    expect(progressLabels.openingPr('customer-portal')).toBe('Opening a pull request in customer-portal');
  });

  it('shows no progress line while nothing reports', async () => {
    const { container } = await mount({ view: STEPS });
    expect(container.querySelector('app-progress-line')).toBeNull();
  });
});
