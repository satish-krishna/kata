import type { CheckView } from '@bindings/CheckView';
import type { RepoCheckView } from '@bindings/RepoCheckView';
import { render } from '../../testing/render';
import { CheckResults } from './check-results';

const view = (repo: string, v: CheckView, summary: string): RepoCheckView => ({ repo, view: v, summary });
const text = (c: Element) => c.textContent!.replace(/\s+/g, ' ').trim();
const OUTPUT = 'line 1\nthe assertion failed';
const FIX = "unit failed. The agent is sent back to fix it, up to the team's retry limit.";

describe('CheckResults shows what the plugin recorded, in its words (R5.1)', () => {
  it.each([
    ['no checks', view('kata', { kind: 'noChecks' }, 'This repository has no checks.'), 'idle'],
    ['not run yet', view('kata', { kind: 'notRunYet' }, 'The checks have not run yet.'), 'idle'],
    ['stale', view('kata', { kind: 'stale', head: 'abc1234' }, 'Checks last ran at abc1234.'), 'idle'],
    ['passed', view('kata', { kind: 'passed', hooks: [{ id: 'unit', outcome: 'passed' }] }, 'The checks passed.'), 'success'],
    ['failed, to be fixed', view('kata', { kind: 'failedFix', id: 'unit', output: OUTPUT }, FIX), 'error'],
    ['failed, to stop', view('kata', { kind: 'failedStop', id: 'unit', output: OUTPUT }, 'unit failed. The build stopped here.'), 'error'],
    ['could not run', view('kata', { kind: 'couldNotRun', id: 'unit', output: OUTPUT }, 'unit could not run on this machine. That is a fault of the machine, not of the code.'), 'warning'],
  ] as const)('%s: the sentence and its color', async (_name, v, tone) => {
    const { container } = await render(CheckResults, { views: [v] });
    expect(text(container)).toContain(v.summary);
    expect(text(container)).toContain('kata');
    const status = container.querySelector(`.k-status--${tone}`);
    expect(status).not.toBeNull();
    expect(status!.querySelector('.k-status__dot')).not.toBeNull();
    expect(text(status!)).toBe(v.summary);
  });

  it.each([
    ['failed, to be fixed', { kind: 'failedFix', id: 'unit', output: OUTPUT }],
    ['failed, to stop', { kind: 'failedStop', id: 'unit', output: OUTPUT }],
    ['could not run', { kind: 'couldNotRun', id: 'unit', output: OUTPUT }],
  ] as const)('%s: the check and its output as the plugin gave it', async (_name, v) => {
    const { container } = await render(CheckResults, { views: [view('kata', v, 'says')] });
    expect(container.querySelector('pre')!.textContent).toBe(OUTPUT);
    expect(text(container)).toContain('unit');
  });

  it('a passed run lists the checks that passed', async () => {
    const { container } = await render(CheckResults, {
      views: [view('kata', { kind: 'passed', hooks: [{ id: 'unit', outcome: 'passed' }, { id: 'lint', outcome: 'passed' }] }, 'The checks passed.')],
    });
    expect(Array.from(container.querySelectorAll('li')).map(text)).toEqual(['unit', 'lint']);
    expect(container.querySelector('pre')).toBeNull();
  });

  it('shows one block for each repository, in the order given', async () => {
    const { container } = await render(CheckResults, {
      views: [view('app', { kind: 'noChecks' }, 'This repository has no checks.'), view('api', { kind: 'notRunYet' }, 'The checks have not run yet.')],
    });
    expect(Array.from(container.querySelectorAll('[data-check]')).map((c) => c.getAttribute('aria-label'))).toEqual(['app · checks', 'api · checks']);
  });
});
