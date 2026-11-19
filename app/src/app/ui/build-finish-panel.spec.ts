import { TestBed } from '@angular/core/testing';
import type { FinishFailure } from '@bindings/FinishFailure';
import type { StartChecks } from '@bindings/StartChecks';
import { render } from '../../testing/render';
import { BuildFinishPanel } from './build-finish-panel';

const text = (c: Element) => c.textContent!.replace(/\s+/g, ' ').trim();
const button = (root: ParentNode, label: string) => Array.from(root.querySelectorAll('button')).find((b) => text(b).startsWith(label))!;

const finish = (over: Partial<FinishFailure> = {}): FinishFailure => ({
  check: 'app-speed',
  base: 'passed',
  output: 'running 1 test\nspeed_targets: took 1.2s (limit 1 s)',
  passed: 11,
  next: 'sentBackNotFixed',
  canAccept: false,
  ...over,
});
const start = (f: FinishFailure): StartChecks => ({ repo: 'kata', shown: { kind: 'startable' }, base: '3c504eb', checks: [], passed: 0, setupHint: false, startHeld: null, finish: f, elsewhere: false, listed: null, outside: null });

describe('BuildFinishPanel shows a failure at finish, once', () => {
  const rowsOfR71: { check: string; base: FinishFailure['base']; next: FinishFailure['next']; title: string; why: string }[] = [
    { check: 'app-speed', base: 'passed', next: 'sentBackNotFixed', title: 'app-speed failed at finish, and it passed on the base', why: 'The agent was sent back to fix it and did not get it to pass.' },
    { check: 'rust-test', base: 'passed', next: 'stopped', title: 'rust-test failed at finish, and it passed on the base', why: 'The build stopped here.' },
    { check: 'app-lint', base: 'addedFailures', next: 'sentBackNotFixed', title: 'app-lint failed at finish, and this build added failures to it', why: 'The agent was sent back to fix it and did not get it to pass.' },
  ];

  it('shows a finish failure once with what happens next r7.1', async () => {
    for (const row of rowsOfR71) {
      TestBed.resetTestingModule();
      const { fixture, container } = await render(BuildFinishPanel, { start: start(finish({ check: row.check, base: row.base, next: row.next })) });
      expect(container.querySelectorAll('[data-finish-row]').length).toBe(1);
      expect(text(container.querySelector('[data-finish-title]')!)).toBe(row.title);
      expect(text(container.querySelector('[data-finish-row]')!)).toContain(row.check);
      expect(text(container.querySelector('[data-finish-next]')!)).toBe(row.why);
      expect(text(container.querySelector('[data-finish-why]')!)).toContain('blocks the change');
      expect(container.querySelector('[data-output]')).toBeNull();
      button(container, 'Show output').click();
      await fixture.whenStable();
      expect(container.querySelector('[data-output]')!.textContent).toBe('running 1 test\nspeed_targets: took 1.2s (limit 1 s)');
      expect(text(button(container, 'Run checks again'))).toBe('Run checks again in kata');
      expect(container.querySelector('[data-accept]')).toBeNull();
      expect(Array.from(container.querySelectorAll('button')).some((b) => /accept/i.test(text(b)))).toBe(false);
    }
  });

  it('folds the checks that passed at finish r7.3', async () => {
    const { container } = await render(BuildFinishPanel, { start: start(finish({ passed: 11 })) });
    expect(text(container.querySelector('[data-passed-fold]')!)).toContain('11 other checks passed at finish');
  });

  it('asks to run the checks again, naming the repository to a screen reader r7.2', async () => {
    const { fixture, container } = await render(BuildFinishPanel, { start: start(finish()) });
    let asked = 0;
    fixture.componentInstance.rerun.subscribe(() => asked++);
    const again = container.querySelector<HTMLButtonElement>('[data-rerun]')!;
    expect(text(again)).toBe('Run checks again in kata');
    again.click();
    expect(asked).toBe(1);
  });
});
