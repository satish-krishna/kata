import { TestBed } from '@angular/core/testing';
import { RunStore } from './run.store';
import { KataTransport } from '../transport/kata-transport';
import { seedSpec } from '../../lib/mock';
import type { KataEvent } from '../../lib/events';

class FakeTransport {
  listeners: ((ev: KataEvent) => void)[] = [];
  unlistened = 0;
  runSpec = vi.fn((..._a: unknown[]) => Promise.resolve());
  cancelRun = vi.fn(() => Promise.resolve());
  submitAnswer = vi.fn((..._a: unknown[]) => Promise.resolve());
  submitDecision = vi.fn((..._a: unknown[]) => Promise.resolve());
  onRunEvent(cb: (ev: KataEvent) => void) {
    this.listeners.push(cb);
    return Promise.resolve(() => { this.unlistened++; });
  }
}

function setup() {
  const fake = new FakeTransport();
  TestBed.configureTestingModule({ providers: [{ provide: KataTransport, useValue: fake }] });
  return { store: TestBed.inject(RunStore), fake };
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
    expect(fake.submitAnswer).toHaveBeenCalledWith('a', [['x']]);
  });

  it('forwards decisions only while awaiting', async () => {
    const { store, fake } = setup();
    await store.startRun(seedSpec());
    await store.submitDecision('p1', true, null);
    expect(fake.submitDecision).not.toHaveBeenCalled();
    fake.listeners[0]({ type: 'permission.requested', id: 'p1', tool: 'Bash', input_summary: 'ls' });
    await store.submitDecision('p1', false, 'no');
    expect(fake.submitDecision).toHaveBeenCalledWith('p1', false, 'no');
  });

  it('exposes asks and permissions as signals', async () => {
    const { store, fake } = setup();
    await store.startRun(seedSpec());
    fake.listeners[0]({ type: 'ask.requested', id: 'a', questions: [] });
    expect(store.asks()).toHaveLength(1);
    expect(store.state()).toBe('awaiting');
  });
});
