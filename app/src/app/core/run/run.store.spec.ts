import { TestBed } from '@angular/core/testing';
import { RunStore } from './run.store';
import { KataTransport } from '../transport/kata-transport';
import { seedSpec } from '../../lib/mock';
import type { KataEvent } from '../../lib/events';

class FakeTransport {
  listeners: ((ev: KataEvent) => void)[] = [];
  unlistened = 0;
  runSpec = vi.fn((..._a: unknown[]) => Promise.resolve('1'));
  cancelRun = vi.fn((): Promise<void> => Promise.resolve());
  submitAnswer = vi.fn((..._a: unknown[]) => Promise.resolve());
  submitDecision = vi.fn((..._a: unknown[]) => Promise.resolve());
  onRunEvent(cb: (runId: string, ev: KataEvent) => void) {
    this.listeners.push((ev) => cb('1', ev));
    return Promise.resolve(() => { this.unlistened++; });
  }
}

function setup() {
  const fake = new FakeTransport();
  TestBed.configureTestingModule({ providers: [{ provide: KataTransport, useValue: fake }] });
  return { store: TestBed.inject(RunStore), fake };
}
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}
const log = (message: string): KataEvent => ({ type: 'log', level: 'info', message });

describe('RunStore', () => {
  it('starts running and appends streamed rows', async () => {
    const { store, fake } = setup();
    await store.startRun(seedSpec());
    expect(store.state()).toBe('running');
    fake.listeners[0](log('hello'));
    expect(store.events()).toEqual([log('hello')]);
  });

  it('ignores startRun while a run is active', async () => {
    const { store, fake } = setup();
    await store.startRun(seedSpec());
    await store.startRun(seedSpec());
    expect(fake.runSpec).toHaveBeenCalledTimes(1);
  });

  it('drops an event from a cancelled run that arrives after a re-run', async () => {
    const { store, fake } = setup();
    await store.startRun(seedSpec());
    const stale = fake.listeners[0];
    await store.cancelRun();
    await store.startRun(seedSpec());
    stale(log('late from run 1'));
    expect(store.events()).toEqual([]);
    fake.listeners[1](log('run 2'));
    expect(store.events()).toEqual([log('run 2')]);
  });

  it('drops events after a terminal event and unlistens', async () => {
    const { store, fake } = setup();
    await store.startRun(seedSpec());
    fake.listeners[0]({ type: 'run.completed', exit_code: 0 } as never);
    expect(store.state()).toBe('success');
    expect(fake.unlistened).toBe(1);
    fake.listeners[0](log('after the end'));
    expect(store.events()).toEqual([]);
  });

  it('marks cancel as a warning with the cleanup log row', async () => {
    const { store } = setup();
    await store.startRun(seedSpec());
    await store.cancelRun();
    expect(store.state()).toBe('warning');
    expect(store.events().at(-1)).toEqual({ type: 'log', level: 'warn', message: 'run cancelled — engine stopped claude and cleaned up the plugin-dir' });
  });

  it('shows a failed runSpec as an error row', async () => {
    const { store, fake } = setup();
    fake.runSpec.mockRejectedValueOnce('boom');
    await store.startRun(seedSpec());
    expect(store.state()).toBe('error');
    expect(store.events().at(-1)).toEqual({ type: 'log', level: 'error', message: 'run failed: boom' });
  });

  it('forwards answers only while awaiting', async () => {
    const { store, fake } = setup();
    await store.startRun(seedSpec());
    await store.submitAnswer('a', [['x']]);
    expect(fake.submitAnswer).not.toHaveBeenCalled();
    fake.listeners[0]({ type: 'ask.requested', id: 'a', questions: [] });
    await store.submitAnswer('a', [['x']]);
    expect(fake.submitAnswer).toHaveBeenCalledWith('1', 'a', [['x']]);
  });

  it('forwards decisions only while awaiting', async () => {
    const { store, fake } = setup();
    await store.startRun(seedSpec());
    await store.submitDecision('p1', true, null);
    expect(fake.submitDecision).not.toHaveBeenCalled();
    fake.listeners[0]({ type: 'permission.requested', id: 'p1', tool: 'Bash', input_summary: 'ls' });
    await store.submitDecision('p1', false, 'no');
    expect(fake.submitDecision).toHaveBeenCalledWith('1', 'p1', false, 'no');
  });

  it('exposes asks and permissions as signals', async () => {
    const { store, fake } = setup();
    await store.startRun(seedSpec());
    fake.listeners[0]({ type: 'ask.requested', id: 'a', questions: [] });
    expect(store.asks()).toHaveLength(1);
    expect(store.state()).toBe('awaiting');
  });

  it('cancel while onRunEvent is pending never spawns the engine', async () => {
    const { store, fake } = setup();
    const listen = deferred<() => void>();
    const cancel = deferred();
    fake.onRunEvent = () => listen.promise;
    fake.cancelRun.mockReturnValueOnce(cancel.promise);
    const unlisten = vi.fn();
    const started = store.startRun(seedSpec());
    const cancelling = store.cancelRun();
    listen.resolve(unlisten);
    await started;
    expect(fake.runSpec).not.toHaveBeenCalled();
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(store.state()).toBe('warning');
    cancel.resolve();
    await cancelling;
  });

  it('cancel while runSpec is pending cancels again when it resolves and drops that run events', async () => {
    const { store, fake } = setup();
    const d = deferred<string>();
    fake.runSpec.mockReturnValueOnce(d.promise);
    const started = store.startRun(seedSpec());
    await vi.waitFor(() => expect(fake.runSpec).toHaveBeenCalled());
    await store.cancelRun();
    // No run id yet, so nothing to signal until runSpec answers.
    expect(fake.cancelRun).not.toHaveBeenCalled();
    d.resolve('1');
    await started;
    expect(fake.cancelRun).toHaveBeenCalledTimes(1);
    expect(fake.cancelRun).toHaveBeenCalledWith('1');
    const before = store.events().length;
    fake.listeners[0](log('late'));
    expect(store.events().length).toBe(before);
  });

  it('a fast-failing run (terminal event before runSpec resolves) does not issue a stray cancel', async () => {
    const { store, fake } = setup();
    const d = deferred<string>();
    fake.runSpec.mockReturnValueOnce(d.promise);
    const started = store.startRun(seedSpec());
    await vi.waitFor(() => expect(fake.runSpec).toHaveBeenCalled());
    fake.listeners[0]({ type: 'run.error', message: 'boom', exit_code: 1 } as never);
    expect(store.state()).toBe('error');
    d.resolve('1');
    await started;
    expect(fake.cancelRun).not.toHaveBeenCalled();
  });

  it('a stale cancel resolving after a re-run does not touch the new run', async () => {
    const { store, fake } = setup();
    await store.startRun(seedSpec());
    const d = deferred();
    fake.cancelRun.mockReturnValueOnce(d.promise);
    const cancelling = store.cancelRun();
    await store.startRun(seedSpec());
    expect(store.state()).toBe('running');
    d.resolve();
    await cancelling;
    expect(store.state()).toBe('running');
    expect(store.events()).toEqual([]);
  });

  it('a stale cancel rejecting after a re-run does not touch the new run', async () => {
    const { store, fake } = setup();
    await store.startRun(seedSpec());
    const d = deferred();
    fake.cancelRun.mockReturnValueOnce(d.promise);
    const cancelling = store.cancelRun();
    await store.startRun(seedSpec());
    d.reject('late failure');
    await cancelling;
    expect(store.state()).toBe('running');
    expect(store.events()).toEqual([]);
  });

  // After the optimistic cancel, a terminal event cannot land while the cancel promise is
  // pending (the generation is already bumped and the listener torn down), so the reviewer's
  // exact interleaving cannot arise. This checks the reachable neighbor instead.
  it('cancelling a re-run after a terminal event cancels only the new run', async () => {
    const { store, fake } = setup();
    await store.startRun(seedSpec());
    fake.listeners[0]({ type: 'run.completed', exit_code: 0 } as never);
    await store.startRun(seedSpec());
    await store.cancelRun();
    fake.listeners[1](log('after cancel of run 2'));
    expect(store.state()).toBe('warning');
    expect(fake.cancelRun).toHaveBeenCalledTimes(1);
  });

  it('a rejecting transport.cancelRun leaves state error with a cancel failed row', async () => {
    const { store, fake } = setup();
    await store.startRun(seedSpec());
    fake.cancelRun.mockRejectedValueOnce('nope');
    await store.cancelRun();
    expect(store.state()).toBe('error');
    expect(store.events().at(-1)).toEqual({ type: 'log', level: 'error', message: 'cancel failed: nope' });
  });
});

/** A transport that plays several runs at once: every callback hears every run's events, tagged with the run id. */
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

function setupMulti() {
  const fake = new MultiTransport();
  TestBed.configureTestingModule({ providers: [{ provide: KataTransport, useValue: fake }] });
  return { store: TestBed.inject(RunStore), fake };
}

describe('RunStore with several runs', () => {
  it('events from two runs fold into their own snapshots', async () => {
    const { store, fake } = setupMulti();
    const a = await store.startRun(seedSpec(), 'build:s/c');
    const b = await store.startRun(seedSpec(), 'build:s/c');
    expect([a, b]).toEqual(['run-a', 'run-b']);
    fake.emit('run-a', log('from a'));
    fake.emit('run-b', log('from b'));
    fake.emit('run-b', { type: 'run.completed', exit_code: 0 } as never);
    expect(store.snapshot('run-a')().events).toEqual([log('from a')]);
    expect(store.snapshot('run-a')().state).toBe('running');
    expect(store.snapshot('run-b')().events).toEqual([log('from b'), { type: 'run.completed', exit_code: 0 }]);
    expect(store.snapshot('run-b')().state).toBe('success');
    // Neither belongs to the solo run, so the Workbench view stays idle.
    expect(store.events()).toEqual([]);
  });

  it('a refused approval reaches only the run that asked (R4.2)', async () => {
    const { store, fake } = setupMulti();
    const a = (await store.startRun(seedSpec(), 'build:s/c'))!;
    const b = (await store.startRun(seedSpec(), 'build:s/c'))!;
    fake.emit(a, { type: 'permission.requested', id: 'p1', tool: 'Bash', input_summary: 'ls' });
    fake.emit(b, { type: 'permission.requested', id: 'p2', tool: 'Bash', input_summary: 'rm -rf x' });
    const before = store.snapshot(a)();
    await store.submitDecision(b, 'p2', false, 'no');
    expect(fake.submitDecision).toHaveBeenCalledTimes(1);
    expect(fake.submitDecision).toHaveBeenCalledWith(b, 'p2', false, 'no');
    expect(store.snapshot(a)()).toBe(before);
    expect(store.snapshot(a)().state).toBe('awaiting');
  });

  it('cancels only the run it names', async () => {
    const { store, fake } = setupMulti();
    const a = (await store.startRun(seedSpec(), 'build:s/c'))!;
    const b = (await store.startRun(seedSpec(), 'build:s/c'))!;
    await store.cancelRun(a);
    expect(fake.cancelRun).toHaveBeenCalledTimes(1);
    expect(fake.cancelRun).toHaveBeenCalledWith(a);
    expect(store.snapshot(a)().state).toBe('warning');
    expect(store.snapshot(b)().state).toBe('running');
    fake.emit(a, log('late'));
    expect(store.snapshot(a)().events.filter((e) => e.type === 'log' && e.message === 'late')).toEqual([]);
  });

  it('forwards an answer to the run it names', async () => {
    const { store, fake } = setupMulti();
    const a = (await store.startRun(seedSpec(), 'build:s/c'))!;
    await store.startRun(seedSpec(), 'build:s/c');
    fake.emit(a, { type: 'ask.requested', id: 'q', questions: [] });
    await store.submitAnswer(a, 'q', [['x']]);
    expect(fake.submitAnswer).toHaveBeenCalledWith(a, 'q', [['x']]);
  });

  it('the workbench screen still runs one kata beside a build', async () => {
    const { store, fake } = setupMulti();
    const b = (await store.startRun(seedSpec(), 'build:s/c'))!;
    const solo = (await store.startRun(seedSpec()))!;
    expect(await store.startRun(seedSpec())).toBeNull();
    fake.emit(b, log('build row'));
    fake.emit(solo, log('solo row'));
    expect(store.events()).toEqual([log('solo row')]);
    expect(store.lastRunId()).toBe(solo);
    await store.submitAnswer('nope', [['x']]);
    expect(fake.submitAnswer).not.toHaveBeenCalled();
    fake.emit(solo, { type: 'run.completed', exit_code: 0 } as never);
    expect(store.state()).toBe('success');
    expect(store.snapshot(b)().state).toBe('running');
  });

  it('holds events of an unclaimed run until its id is known when two starts overlap', async () => {
    const { store, fake } = setupMulti();
    const first = deferred<string>();
    const second = deferred<string>();
    fake.runSpec.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const p1 = store.startRun(seedSpec(), 'build:s/c');
    await vi.waitFor(() => expect(fake.runSpec).toHaveBeenCalledTimes(1));
    const p2 = store.startRun(seedSpec(), 'build:s/c');
    await vi.waitFor(() => expect(fake.runSpec).toHaveBeenCalledTimes(2));
    fake.emit('B', log('for b'));
    first.resolve('A');
    second.resolve('B');
    await Promise.all([p1, p2]);
    expect(store.snapshot('A')().events).toEqual([]);
    expect(store.snapshot('B')().events).toEqual([log('for b')]);
  });
});
