import type { CheckResult } from '@bindings/CheckResult';
import { render } from '../../testing/render';
import type { DoneRepo } from '../lib/sdlc-done';
import { CheckResults } from './check-results';

const result = (outcome: CheckResult['outcome'], tail: string): CheckResult => ({ name: 'cargo test', argv: ['cargo', 'test'], outcome, tail });
const repo = (name: string, ...results: CheckResult[]): DoneRepo => ({
  repo: name, base: 'main', checks: [], result: { repo: name, results, none: results.length === 0 },
});
const text = (c: Element) => c.textContent!.replace(/\s+/g, ' ').trim();

describe('CheckResults', () => {
  it('shows a failed check with its exit code, the last lines and what to do', async () => {
    const { container } = await render(CheckResults, { repos: [repo('claims-core', result({ kind: 'Failed', exit: 101 }, 'line 1\nthe assertion failed'))] });
    const t = text(container);
    expect(t).toContain('claims-core · cargo test · last 50 lines');
    expect(t).toContain('cargo test · exit 101');
    expect(t).toContain('The check ran and failed. Ask for another round to fix it.');
    expect(container.querySelector('pre')!.textContent).toBe('line 1\nthe assertion failed');
    expect(container.querySelector('.k-status--error .k-status__dot')).not.toBeNull();
  });

  it('shows a check that could not run in amber and says to fix the environment', async () => {
    const { container } = await render(CheckResults, { repos: [repo('claims-core', result({ kind: 'CouldNotRun', reason: 'ran past its time limit' }, 'partial output'))] });
    const t = text(container);
    expect(t).toContain('ran past its time limit');
    expect(t).toContain('The check could not run to completion. Fix the environment, not the code.');
    expect(t).not.toContain('The check ran and failed');
    expect(container.querySelector('.k-status--warning .k-status__dot')).not.toBeNull();
    expect(container.querySelector('.k-status--error')).toBeNull();
  });

  it('shows nothing for checks that passed or were never run', async () => {
    const { container } = await render(CheckResults, {
      repos: [repo('a', result({ kind: 'Passed' }, 'ok')), { ...repo('b'), result: null }],
    });
    expect(container.querySelectorAll('pre').length).toBe(0);
  });
});
