import { TestBed } from '@angular/core/testing';
import type { RunSpec } from '@bindings/RunSpec';
import type { KataEvent } from '../../lib/events';
import { seedSpec } from '../../lib/mock';
import { KataTransport } from '../transport/kata-transport';
import { ToastStore } from '../toast/toast.store';
import { RunStore } from '../run/run.store';
import { LockStore, type LockView } from './lock.store';

class FakeTransport {
  listeners: ((ev: KataEvent) => void)[] = [];
  runSpec = vi.fn((..._a: unknown[]) => Promise.resolve('1'));
  cancelRun = vi.fn((): Promise<void> => Promise.resolve());
  submitAnswer = vi.fn((..._a: unknown[]) => Promise.resolve());
  submitDecision = vi.fn((..._a: unknown[]) => Promise.resolve());
  onRunEvent(cb: (runId: string, ev: KataEvent) => void) {
    this.listeners.push((ev) => cb('1', ev));
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
  it('locks as a run and holds the finished run until the operator closes it', async () => {
    const { store, fake } = setup();
    const p = store.runAgent('Reading context', seedSpec());
    await flush();
    expect(store.active()).toEqual({ kind: 'run', title: 'Reading context', finished: null });
    fake.listeners[0](completed(0));
    await flush();
    expect(await p).toBe('success');
    expect(store.active()).toEqual({ kind: 'run', title: 'Reading context', finished: 'success' });
    let dismissed = false;
    const d = store.dismissed().then(() => (dismissed = true));
    await flush();
    expect(dismissed).toBe(false);
    store.close();
    await d;
    expect(store.active()).toBeNull();
  });

  it('ignores close while the run is still going', async () => {
    const { store, fake } = setup();
    const p = store.runAgent('Reading context', seedSpec());
    await flush();
    store.close();
    expect(store.active()).toEqual({ kind: 'run', title: 'Reading context', finished: null });
    fake.listeners[0](completed(0));
    await flush();
    await p;
  });

  it('resolves dismissed at once when no finished run is held', async () => {
    const { store } = setup();
    await expect(store.dismissed()).resolves.toBeUndefined();
  });

  it('stops the clock when the run ends', async () => {
    vi.useFakeTimers();
    try {
      const { store, fake } = setup();
      const p = store.runAgent('Reading context', seedSpec());
      await vi.advanceTimersByTimeAsync(3000);
      fake.listeners[0](completed(0));
      await vi.advanceTimersByTimeAsync(10);
      await p;
      const at = store.elapsedSecs();
      await vi.advanceTimersByTimeAsync(5000);
      expect(store.elapsedSecs()).toBe(at);
    } finally {
      vi.useRealTimers();
    }
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

  it('exposes the spec of the run it holds', async () => {
    const { store, fake } = setup();
    const spec = seedSpec();
    const p = store.runAgent('Reading context', spec);
    await flush();
    expect(store.spec()).toEqual(spec);
    fake.listeners[0](completed(0));
    await flush();
    await p;
    store.close();
    expect(store.spec()).toBeNull();
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

class MultiTransport {
  callbacks: ((runId: string, ev: KataEvent) => void)[] = [];
  private next = 0;
  runSpec = vi.fn((..._a: unknown[]) => Promise.resolve(`run-${String.fromCharCode(97 + this.next++)}`));
  cancelRun = vi.fn((_id: string): Promise<void> => Promise.resolve());
  submitAnswer = vi.fn((..._a: unknown[]) => Promise.resolve());
  submitDecision = vi.fn((..._a: unknown[]) => Promise.resolve());
  onRunEvent(cb: (runId: string, ev: KataEvent) => void) {
    this.callbacks.push(cb);
    return Promise.resolve(() => undefined);
  }
  emit(runId: string, ev: KataEvent) {
    for (const cb of [...this.callbacks]) cb(runId, ev);
  }
}

function setupBuild() {
  const fake = new MultiTransport();
  const toasts = { error: vi.fn(), success: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      { provide: KataTransport, useValue: fake },
      { provide: ToastStore, useValue: toasts },
    ],
  });
  return { store: TestBed.inject(LockStore), runs: TestBed.inject(RunStore), fake, toasts };
}
const ask = (id: string): KataEvent => ({ type: 'ask.requested', id, questions: [] }) as unknown as KataEvent;

describe('LockStore build view', () => {
  it('a build holds the lock across its runs', async () => {
    const { store, runs, toasts } = setupBuild();
    expect(store.beginBuild('Building')).toBe(true);
    expect(store.active()).toEqual({ kind: 'build', title: 'Building', runs: [], finished: false });
    const a = (await runs.startRun(seedSpec(), 'build:s/c'))!;
    store.addRun(a);
    const b = (await runs.startRun(seedSpec(), 'build:s/c'))!;
    store.addRun(b);
    expect(store.active()).toEqual({ kind: 'build', title: 'Building', runs: [a, b], finished: false });
    expect(store.beginBuild('Again')).toBe(false);
    expect(toasts.error).toHaveBeenCalledWith('Another task is already running.');
    expect(await store.runSteps('Steps', [])).toBe('failed');
    store.close();
    expect(store.active()).not.toBeNull();
    store.endBuild();
    expect(store.active()).toEqual({ kind: 'build', title: 'Building', runs: [a, b], finished: true });
    let dismissed = false;
    const d = store.dismissed().then(() => (dismissed = true));
    await flush();
    expect(dismissed).toBe(false);
    store.close();
    await d;
    expect(store.active()).toBeNull();
  });

  it('resumeBuild reopens a finished build and starts the clock again from where it stopped', async () => {
    vi.useFakeTimers();
    try {
      const { store } = setupBuild();
      store.beginBuild('Building');
      await vi.advanceTimersByTimeAsync(3000);
      store.endBuild();
      const at = store.elapsedSecs();
      await vi.advanceTimersByTimeAsync(4000);
      expect(store.elapsedSecs()).toBe(at);
      store.resumeBuild();
      expect(store.active()).toEqual({ kind: 'build', title: 'Building', runs: [], finished: false });
      await vi.advanceTimersByTimeAsync(2000);
      expect(store.elapsedSecs()).toBe(at + 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resumeBuild does nothing unless a finished build is held', () => {
    const { store } = setupBuild();
    store.resumeBuild();
    expect(store.active()).toBeNull();
    store.beginBuild('Building');
    store.resumeBuild();
    expect(store.active()).toEqual({ kind: 'build', title: 'Building', runs: [], finished: false });
  });

  it('refuses a build while the solo run is busy', async () => {
    const { store, runs, toasts } = setupBuild();
    await runs.startRun(seedSpec());
    expect(store.beginBuild('Building')).toBe(false);
    expect(toasts.error).toHaveBeenCalledWith('Another task is already running.');
  });

  it('waiting lists every run with an open pause and clears on answer or end', async () => {
    const { store, runs, fake } = setupBuild();
    store.beginBuild('Building');
    const a = (await runs.startRun(seedSpec(), 'build:s/c'))!;
    store.addRun(a);
    const b = (await runs.startRun(seedSpec(), 'build:s/c'))!;
    store.addRun(b);
    expect(store.waiting()).toEqual([]);
    fake.emit(b, ask('q1'));
    fake.emit(a, { type: 'permission.requested', id: 'p1', tool: 'Bash', input_summary: 'ls' });
    expect(store.waiting()).toHaveLength(2);
    expect(store.waiting()).toEqual(expect.arrayContaining([{ runId: b, kind: 'answer' }, { runId: a, kind: 'approval' }]));
    expect(store.ask(b)?.id).toBe('q1');
    expect(store.ask(a)).toBeNull();
    expect(store.permission(a)?.id).toBe('p1');
    fake.emit(b, { type: 'ask.answered', id: 'q1', answers: [['x']] } as unknown as KataEvent);
    expect(store.waiting()).toEqual([{ runId: a, kind: 'approval' }]);
    fake.emit(a, { type: 'run.error', message: 'boom', exit_code: 1 } as never);
    expect(store.waiting()).toEqual([]);
  });

  it('deadlineSecs counts per run', async () => {
    vi.useFakeTimers();
    try {
      const { store, runs, fake } = setupBuild();
      const spec: RunSpec = { ...seedSpec(), interactive: { enabled: false, answer_timeout_secs: 60 } };
      store.beginBuild('Building');
      const a = (await runs.startRun(spec, 'build:s/c'))!;
      store.addRun(a, spec);
      const b = (await runs.startRun(spec, 'build:s/c'))!;
      store.addRun(b, spec);
      await vi.advanceTimersByTimeAsync(5000);
      expect(store.deadlineSecs(a)).toBeNull();
      fake.emit(a, ask('qa'));
      await vi.advanceTimersByTimeAsync(10000);
      fake.emit(b, ask('qb'));
      await vi.advanceTimersByTimeAsync(10000);
      expect(store.deadlineSecs(a)).toBe(40);
      expect(store.deadlineSecs(b)).toBe(50);
      fake.emit(a, { type: 'run.completed', exit_code: 0 } as never);
      await vi.advanceTimersByTimeAsync(10);
      expect(store.deadlineSecs(a)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('waitedSecs counts from when each run was first seen waiting', async () => {
    vi.useFakeTimers();
    try {
      const { store, runs, fake } = setupBuild();
      store.beginBuild('Building');
      const a = (await runs.startRun(seedSpec(), 'build:s/c'))!;
      store.addRun(a);
      await vi.advanceTimersByTimeAsync(5000);
      expect(store.waitedSecs(a)).toBeNull();
      fake.emit(a, ask('qa'));
      await vi.advanceTimersByTimeAsync(83000);
      expect(store.waitedSecs(a)).toBe(83);
      await vi.advanceTimersByTimeAsync(2000);
      expect(store.waitedSecs(a)).toBe(85);
      fake.emit(a, { type: 'ask.answered', id: 'qa', answers: [['x']] } as unknown as KataEvent);
      await vi.advanceTimersByTimeAsync(10);
      expect(store.waitedSecs(a)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the solo run API still drives a Part 1 stage after a build is closed', async () => {
    const { store, runs, fake } = setupBuild();
    store.beginBuild('Building');
    const a = (await runs.startRun(seedSpec(), 'build:s/c'))!;
    store.addRun(a);
    fake.emit(a, { type: 'run.completed', exit_code: 0 } as never);
    store.endBuild();
    store.close();
    const p = store.runAgent('Reading context', seedSpec());
    await flush();
    const solo = runs.lastRunId()!;
    fake.emit(solo, ask('s1'));
    await flush();
    expect(store.ask()?.id).toBe('s1');
    store.answer('s1', [['y']]);
    expect(fake.submitAnswer).toHaveBeenCalledWith(solo, 's1', [['y']]);
    fake.emit(solo, { type: 'run.completed', exit_code: 0 } as never);
    await flush();
    expect(await p).toBe('success');
  });
});
