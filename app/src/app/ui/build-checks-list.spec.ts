import type { BaseCheck } from '@bindings/BaseCheck';
import { render } from '../../testing/render';
import { BuildChecksList, type PreparationRow } from './build-checks-list';

const text = (c: Element) => c.textContent!.replace(/\s+/g, ' ').trim();
const T0 = Date.parse('2026-11-18T10:00:00Z');
const at = (secs: number) => new Date(T0 + secs * 1000).toISOString();

const check = (name: string, state: BaseCheck['state'], startedAt: number | null = null, endedAt: number | null = null): BaseCheck => ({
  check: name,
  state,
  exitCode: state === 'failed' ? 1 : state === 'passed' ? 0 : null,
  output: '',
  lineCount: 0,
  canAccept: false,
  accepted: false,
  startedAt: startedAt === null ? null : at(startedAt),
  endedAt: endedAt === null ? null : at(endedAt),
});

/* Five checks: one passed in 12 s, one failed in 6 s, one running since 100 s, two waiting. */
const LIVE = [
  check('app-lint', 'passed', 0, 12),
  check('rust-fmt', 'failed', 12, 18),
  check('app-unit', 'running', 100),
  check('rust-clippy', 'notRun'),
  check('rust-test', 'notRun'),
];
const NOW = T0 + 195_000;

describe('BuildChecksList names the checks while the base is checked', () => {
  it('names the running check with a count r2.1', async () => {
    const { container } = await render(BuildChecksList, { checks: LIVE, base: '3c504eb', now: NOW });
    const rows = Array.from(container.querySelectorAll('[data-check-row]'));
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual(['passed', 'failed', 'running', 'waiting', 'waiting']);
    const running = container.querySelector('[data-check-row][data-state="running"]')!;
    expect(text(running)).toContain('app-unit');
    expect(text(running)).toContain('1m 35s');
    expect(text(container)).toContain('2 of 5 done');
    expect(text(container)).toContain('3c504eb');
    expect(text(rows[0])).toContain('passed');
    expect(text(rows[0])).toContain('12s');
    expect(text(rows[1])).toContain('failed');
    expect(text(rows[1])).toContain('6s');
    expect(text(rows[3])).toContain('waiting');
  });

  it('names a preparation step apart from the checks r2.2', async () => {
    const preparation: PreparationRow[] = [{ id: 'app-deps', what: 'Install the packages', state: 'passed', seconds: 1 }];
    const { container } = await render(BuildChecksList, { checks: LIVE, base: '3c504eb', now: NOW, preparation });
    const prep = container.querySelector('[data-preparation]')!;
    expect(text(prep)).toContain('Preparation');
    expect(text(prep)).toContain('app-deps');
    expect(prep.querySelectorAll('[data-check-row]').length).toBe(0);
    const checks = container.querySelector('[data-checks]')!;
    expect(text(checks)).not.toContain('app-deps');
    expect(text(container)).toContain('2 of 5 done');
  });

  it('shows a cut off check r2.4', async () => {
    const checks = [check('app-lint', 'passed', 0, 12), check('rust-fmt', 'passed', 12, 18), check('app-unit', 'cutOff', 100), check('rust-clippy', 'notRun')];
    const { container } = await render(BuildChecksList, { checks, base: '3c504eb', now: NOW });
    const cut = container.querySelector('[data-check-row][data-state="cutOff"]')!;
    expect(text(cut)).toContain('app-unit');
    expect(text(cut)).toContain('cut off');
    expect(text(cut)).toContain('started');
    expect(text(container.querySelector('[data-check-row][data-state="notRun"]')!)).toContain('did not run');
    const note = container.querySelector('[data-cutoff-note]')!;
    expect(text(note)).toContain('Nothing was kept');
    expect(text(note)).toContain('every check on the base again');
    expect(container.querySelector('[data-check-row][data-state="running"]')).toBeNull();
  });

  it('shows checks running in another session as last read r2.5', async () => {
    const { container } = await render(BuildChecksList, { checks: LIVE, base: '3c504eb', now: NOW, elsewhere: true });
    expect(text(container.querySelector('[data-elsewhere]')!)).toContain('running in another session');
    expect(text(container)).toContain('app-unit');
    expect(text(container)).toContain('2 of 5 done');
    expect(container.querySelector('button')).toBeNull();
  });

  it('announces the running check only when it changes r12.1', async () => {
    const { fixture, container } = await render(BuildChecksList, { checks: LIVE, base: '3c504eb', now: NOW });
    const live = container.querySelector('[aria-live="polite"]')!;
    const first = text(live);
    expect(first).toContain('app-unit');
    expect(first).toContain('2 of 5');
    expect(first).not.toContain('1m');
    fixture.componentRef.setInput('now', NOW + 7000);
    await fixture.whenStable();
    expect(text(container)).toContain('1m 42s');
    expect(text(live)).toBe(first);
    expect(live.contains(container.querySelector('[data-check-row][data-state="running"] [data-elapsed]'))).toBe(false);
    const next = [check('app-lint', 'passed', 0, 12), check('rust-fmt', 'failed', 12, 18), check('app-unit', 'passed', 100, 200), check('rust-clippy', 'running', 200), check('rust-test', 'notRun')];
    fixture.componentRef.setInput('checks', next);
    await fixture.whenStable();
    expect(text(live)).toContain('rust-clippy');
    expect(text(live)).toContain('3 of 5');
  });
});
