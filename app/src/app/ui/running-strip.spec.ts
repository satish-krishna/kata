import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import type { ChangeKey } from '@bindings/ChangeKey';
import type { RunningEntry } from '@bindings/RunningEntry';
import type { RunningStrip as Strip } from '@bindings/RunningStrip';
import { render } from '../../testing/render';
import { KataTransport } from '../core/transport/kata-transport';
import { RunningStrip } from './running-strip';

const key = (change: string, system = 'kata'): ChangeKey => ({ workspace: { key: '/w', name: 'w' }, system, change });
const A = key('2026-11-01-plugin-owns-workflow');
const B = key('2026-10-30-findings-rounds', 'bob');
const ref = (run: number, repo: string | null = 'kata') => ({ run, kind: 'build' as const, repo });

const asking = (change: ChangeKey, text: string, waiting = [ref(7)]): RunningEntry => ({ change, since: 1, waiting, state: 'needsAnswer', text, run: waiting[0].run });
const working = (change: ChangeKey, run: number): RunningEntry => ({ change, since: 2, waiting: [], state: 'working', stage: 'build', repo: 'kata', run });
const strip = (...entries: RunningEntry[]): Strip => ({ shown: entries.slice(0, 3), all: entries });

/** A transport that reports a strip, and reports the next one when the test says the backend did. */
class FakeTransport {
  current: Strip = strip();
  private listeners = new Set<(s: Strip) => void>();
  sdlcRunning = async () => this.current;
  onRunning = async (cb: (s: Strip) => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };
  emit(next: Strip) {
    this.current = next;
    for (const l of [...this.listeners]) l(next);
  }
}

const settle = async () => {
  for (let i = 0; i < 4; i++) {
    TestBed.tick();
    await new Promise((r) => setTimeout(r, 0));
  }
};
const text = (c: ParentNode) => c.textContent!.replace(/\s+/g, ' ').trim();

async function mount(initial: Strip) {
  const transport = new FakeTransport();
  transport.current = initial;
  const out = await render(RunningStrip, {}, [provideRouter([]), { provide: KataTransport, useValue: transport }]);
  const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  await settle();
  out.fixture.detectChanges();
  return { ...out, transport, navigate };
}
const entryButton = (c: HTMLElement, change: string) =>
  c.querySelector<HTMLButtonElement>(`[data-testid="running-entry"][data-change="${change}"]`)!;
const overlay = () => document.body.querySelector<HTMLElement>('.cdk-overlay-container') ?? document.body;
const choices = () => Array.from(overlay().querySelectorAll<HTMLButtonElement>('[data-testid="run-choice"]'));

afterEach(() => {
  TestBed.resetTestingModule();
  document.body.querySelectorAll('.cdk-overlay-container').forEach((o) => (o.innerHTML = ''));
});

describe('RunningStrip', () => {
  describe('picking an entry reaches its session (R13.2)', () => {
    it('exactly one session waiting on the engineer: that session opens, with its question ready', async () => {
      const { container, navigate } = await mount(strip(asking(A, 'Which branch should the change use?')));
      entryButton(container, A.change).click();
      await settle();
      expect(navigate).toHaveBeenCalledTimes(1);
      expect(navigate).toHaveBeenCalledWith(['/sdlc', 'kata', A.change], { queryParams: { run: 7 } });
      expect(choices()).toHaveLength(0);
    });

    it("two sessions waiting on the engineer: a list of the change's sessions opens, each opening in one more step", async () => {
      const { container, fixture, navigate } = await mount(strip(asking(A, 'Which branch?', [ref(7, 'kata'), ref(9, 'ai-sdlc')])));
      entryButton(container, A.change).click();
      await settle();
      fixture.detectChanges();
      expect(navigate).not.toHaveBeenCalled();
      expect(choices().map((c) => text(c))).toEqual(['kata Answer', 'ai-sdlc Answer']);
      choices()[1].click();
      await settle();
      expect(navigate).toHaveBeenCalledWith(['/sdlc', 'kata', A.change], { queryParams: { run: 9 } });
    });

    it("no session waiting, one working: a list of the change's sessions opens, each opening in one more step", async () => {
      const { container, fixture, navigate } = await mount(strip(working(A, 4)));
      entryButton(container, A.change).click();
      await settle();
      fixture.detectChanges();
      expect(navigate).not.toHaveBeenCalled();
      expect(choices().map((c) => text(c))).toEqual(['kata Watch']);
      choices()[0].click();
      await settle();
      expect(navigate).toHaveBeenCalledWith(['/sdlc', 'kata', A.change], { queryParams: { run: 4 } });
    });
  });

  it('a question shows its text and offers no answer (R14.1)', async () => {
    const question = 'Which branch should the change use for the master repository, and should it be rebased first?';
    const { container, navigate } = await mount(strip(asking(A, question), working(B, 3)));
    const entry = entryButton(container, A.change);
    expect(text(entry)).toContain('needs an answer');
    expect(text(entry)).toContain(question.slice(0, 20));
    expect(entry.querySelector('[data-testid="running-text"]')!.getAttribute('title')).toBe(question);
    expect(container.querySelector('input, textarea, select')).toBeNull();
    const labels = Array.from(container.querySelectorAll('button')).map((b) => text(b));
    expect(labels.some((l) => /^(Answer|Allow|Deny|Send)$/.test(l))).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('answering in the session clears the entry (R14.2)', async () => {
    const { container, fixture, transport } = await mount(strip(asking(A, 'Which branch should the change use?')));
    expect(text(container)).toContain('needs an answer');
    transport.emit(strip(working(A, 7)));
    await settle();
    fixture.detectChanges();
    expect(text(container)).not.toContain('needs an answer');
    expect(text(container)).not.toContain('Which branch should the change use?');
    expect(text(entryButton(container, A.change))).toContain('working');
  });

  it('All running lists every entry', async () => {
    const entries = [asking(A, 'Which branch?'), working(B, 3), working(key('c-three'), 4), working(key('c-four'), 5), working(key('c-five', 'bob'), 6)];
    const { container, fixture } = await mount(strip(...entries));
    expect(container.querySelectorAll('[data-testid="running-entry"]')).toHaveLength(3);
    const all = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => text(b).includes('All running (5)'))!;
    all.click();
    await settle();
    fixture.detectChanges();
    const rows = Array.from(overlay().querySelectorAll('[data-testid="running-all-entry"]'));
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => text(r))).toEqual(expect.arrayContaining([expect.stringContaining('findings-rounds'), expect.stringContaining('c-five')]));
  });
});
