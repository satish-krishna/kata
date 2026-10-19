import { TestBed } from '@angular/core/testing';
import { render } from '../../testing/render';
import type { AskRecord, PermissionRecord } from '../lib/events';
import type { LockView } from '../core/lock/lock.store';
import { LockPanel } from './lock-panel';

const STEPS: LockView = {
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
const RUN: LockView = { kind: 'run', title: 'Reading context' };
const ASK: AskRecord = {
  id: 'a1',
  at: 0,
  answers: null,
  questions: [{ kind: 'select', header: 'Scope', question: 'Which?', options: [{ label: 'One', description: '' }] } as never],
};
const PERM: PermissionRecord = { id: 'p1', tool: 'Bash', input_summary: 'ls', decided: null, at: 0 };

const base = { elapsed: 75, lastTool: null, turn: null, model: null, ask: null, permission: null, deadlineSecs: null };
const mount = (inputs: Record<string, unknown>) => render(LockPanel, { ...base, ...inputs });

describe('LockPanel', () => {
  it('is a modal dialog', async () => {
    const { container } = await mount({ view: STEPS });
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.textContent).toContain('Preparing workspace');
  });

  it('shows done over total for steps and the elapsed clock', async () => {
    const { container } = await mount({ view: STEPS });
    expect(container.textContent).toContain('3 / 5');
    expect(container.textContent).toContain('1:15');
  });

  it('shows run activity', async () => {
    const { container } = await mount({ view: RUN, turn: 4, model: 'claude-sonnet-4-6', lastTool: 'Read src/a.ts' });
    const text = container.textContent!;
    expect(text).toContain('4');
    expect(text).toContain('claude-sonnet-4-6');
    expect(text).toContain('Read src/a.ts');
  });

  it('shows the ask card and the deadline footer', async () => {
    const { container } = await mount({ view: RUN, ask: ASK, deadlineSecs: 125 });
    expect(container.querySelector('app-ask-panel')).not.toBeNull();
    expect(container.textContent).toContain('exits 123 if unanswered in 2:05');
  });

  it('shows the permission card', async () => {
    const { container } = await mount({ view: RUN, permission: PERM, deadlineSecs: 9 });
    expect(container.querySelector('app-permission-panel')).not.toBeNull();
    expect(container.textContent).toContain('exits 123 if unanswered in 0:09');
  });

  it('shows no cards and no deadline when nothing is pending', async () => {
    const { container } = await mount({ view: RUN });
    expect(container.querySelector('app-ask-panel')).toBeNull();
    expect(container.textContent).not.toContain('exits 123');
  });

  it('emits cancel', async () => {
    const r = await mount({ view: RUN });
    const cancel = vi.fn();
    r.fixture.componentInstance.cancel.subscribe(cancel);
    (Array.from(r.container.querySelectorAll('button')).find((b) => b.textContent!.trim() === 'Cancel') as HTMLElement).click();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('never renders a percentage in any state', async () => {
    const states: Record<string, unknown>[] = [
      { view: STEPS },
      { view: RUN, turn: 3, model: 'm', lastTool: 'Bash ls' },
      { view: RUN, ask: ASK, deadlineSecs: 30 },
      { view: RUN, permission: PERM, deadlineSecs: 30 },
    ];
    for (const s of states) {
      TestBed.resetTestingModule();
      const { container } = await mount(s);
      expect(container.textContent).not.toContain('%');
    }
  });
});
