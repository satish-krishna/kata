import { TestBed } from '@angular/core/testing';
import type { RunSpec } from '@bindings/RunSpec';
import type { KataEvent } from '../../lib/events';
import { seedSpec } from '../../lib/mock';
import { KataTransport } from '../transport/kata-transport';
import { ToastStore } from '../toast/toast.store';
import { LockStore, type LockView } from './lock.store';

class FakeTransport {
  listeners: ((ev: KataEvent) => void)[] = [];
  runSpec = vi.fn((..._a: unknown[]) => Promise.resolve());
  cancelRun = vi.fn((): Promise<void> => Promise.resolve());
  submitAnswer = vi.fn((..._a: unknown[]) => Promise.resolve());
  submitDecision = vi.fn((..._a: unknown[]) => Promise.resolve());
  onRunEvent(cb: (ev: KataEvent) => void) {
    this.listeners.push(cb);
    return Promise.resolve(() => undefined);
  }
}

function setup() {
  const fake = new FakeTransport();
  const toasts = { error: vi.fn(), success: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      { provide: KataTransport, useValue: fake },
      { provide: ToastStore, useValue: toasts },
    ],
  });
  return { store: TestBed.inject(LockStore), fake, toasts };
}

const stepsOf = (v: LockView | null) => (v?.kind === 'steps' ? v.steps : []);
const completed = (exit_code: number): KataEvent => ({ type: 'run.completed', exit_code }) as unknown as KataEvent;
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  TestBed.tick();
};

describe('LockStore.runSteps', () => {
  it('marks steps running then done and keeps each detail', async () => {
    const { store } = setup();
    const seen: string[][] = [];
    const result = await store.runSteps('Working', [
      { label: 'one', run: async () => { seen.push(stepsOf(store.active()).map((s) => s.state)); return 'first detail'; } },
      { label: 'two', run: async () => { seen.push(stepsOf(store.active()).map((s) => `${s.state}:${s.detail}`)); return null; } },
    ]);
    expect(result).toBe('done');
    expect(seen[0]).toEqual(['running', 'pending']);
    expect(seen[1]).toEqual(['done:first detail', 'running:null']);
    expect(store.active()).toBeNull();
  });

  it('stops before the next step after cancel and leaves the rest pending', async () => {
    const { store } = setup();
    let snapshot: string[] = [];
    const second = vi.fn(async () => null);
    const result = await store.runSteps('Working', [
      { label: 'one', run: async () => { store.cancel(); snapshot = stepsOf(store.active()).map((s) => s.state); return null; } },
      { label: 'two', run: second },
      { label: 'three', run: second },
    ]);
    expect(result).toBe('cancelled');
    expect(snapshot).toEqual(['running', 'pending', 'pending']);
    expect(second).not.toHaveBeenCalled();
    expect(store.active()).toBeNull();
  });

  it('marks a throwing step failed, stops, and raises a toast', async () => {
    const { store, toasts } = setup();
    const later = vi.fn(async () => null);
    const result = await store.runSteps('Working', [
      { label: 'boom', run: async () => { throw new Error('disk full'); } },
      { label: 'later', run: later },
    ]);
    expect(result).toBe('failed');
    expect(later).not.toHaveBeenCalled();
    expect(toasts.error).toHaveBeenCalledWith(expect.stringContaining('disk full'));
    expect(store.active()).toBeNull();
  });

  it('counts elapsed seconds while locked', async () => {
    vi.useFakeTimers();
    try {
      const { store } = setup();
      let release!: () => void;
      const p = store.runSteps('Working', [{ label: 'slow', run: () => new Promise<null>((r) => { release = () => r(null); }) }]);
      await vi.advanceTimersByTimeAsync(3000);
      expect(store.elapsedSecs()).toBe(3);
      release();
      await p;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('LockStore.runAgent', () => {
  it('locks as a run and resolves success when the run completes', async () => {
    const { store, fake } = setup();
    const p = store.runAgent('Reading context', seedSpec());
    await flush();
    expect(store.active()).toEqual({ kind: 'run', title: 'Reading context' });
    fake.listeners[0](completed(0));
    await flush();
    expect(await p).toBe('success');
    expect(store.active()).toBeNull();
  });

  it('resolves error on a non-zero exit', async () => {
    const { store, fake } = setup();
    const p = store.runAgent('Reading context', seedSpec());
    await flush();
    fake.listeners[0](completed(1));
    await flush();
    expect(await p).toBe('error');
  });

  it('cancel in a run lock cancels the run and resolves warning', async () => {
    const { store, fake } = setup();
    const p = store.runAgent('Reading context', seedSpec());
    await flush();
    store.cancel();
    await flush();
    expect(fake.cancelRun).toHaveBeenCalled();
    expect(await p).toBe('warning');
  });

  it('derives model, turn and last tool from the run', async () => {
    const { store, fake } = setup();
    const p = store.runAgent('Reading context', seedSpec());
    await flush();
    expect(store.model()).toBe('claude-sonnet-4-6');
    expect(store.turn()).toBeNull();
    fake.listeners[0]({ type: 'turn', n: 2 });
    fake.listeners[0]({ type: 'tool.use', id: 't1', name: 'Read', input_summary: 'src/a.ts' } as unknown as KataEvent);
    expect(store.turn()).toBe(2);
    expect(store.lastTool()).toBe('Read src/a.ts');
    fake.listeners[0](completed(0));
    await flush();
    await p;
  });

  it('reports no model when the spec leaves the model id empty', async () => {
    const { store, fake } = setup();
    const spec = seedSpec();
    const p = store.runAgent('Reading context', { ...spec, model: { ...spec.model, id: '' } });
    await flush();
    expect(store.model()).toBeNull();
    fake.listeners[0](completed(0));
    await flush();
    await p;
  });

  it('counts down to the answer deadline from the moment an ask arrives', async () => {
    vi.useFakeTimers();
    try {
      const { store, fake } = setup();
      const spec: RunSpec = { ...seedSpec(), interactive: { enabled: false, answer_timeout_secs: 60 } };
      const p = store.runAgent('Reading context', spec);
      await vi.advanceTimersByTimeAsync(5000);
      expect(store.deadlineSecs()).toBeNull();
      fake.listeners[0]({ type: 'ask.requested', id: 'a1', questions: [] } as unknown as KataEvent);
      await vi.advanceTimersByTimeAsync(10000);
      expect(store.ask()?.id).toBe('a1');
      expect(store.deadlineSecs()).toBe(50);
      fake.listeners[0](completed(0));
      await vi.advanceTimersByTimeAsync(10);
      await p;
    } finally {
      vi.useRealTimers();
    }
  });
});
