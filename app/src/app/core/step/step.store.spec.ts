import { TestBed } from '@angular/core/testing';
import type { ChangeKey } from '@bindings/ChangeKey';
import type { RunningStep } from '@bindings/RunningStep';
import type { StepEvent } from '@bindings/StepEvent';
import type { StepKind } from '@bindings/StepKind';
import { KataTransport } from '../transport/kata-transport';
import { MockTransport } from '../transport/mock-transport';
import { StepStore } from './step.store';

const keyOf = (change: string, system = 'commerce'): ChangeKey => ({ workspace: { key: 'c:/ws', name: 'ws' }, system, change });
const running = (change: string, kind: StepKind, label: string): RunningStep => ({
  change: keyOf(change),
  kind,
  doing: 'doing',
  progress: { kind: 'repository', label, repo: null, check: null },
});

function setup() {
  const transport = new MockTransport();
  const listeners = new Set<(e: StepEvent) => void>();
  const endings = new Set<(c: ChangeKey) => void>();
  vi.spyOn(transport, 'onStep').mockImplementation(async (cb) => {
    listeners.add(cb);
    return () => void listeners.delete(cb);
  });
  vi.spyOn(transport, 'onStepEnd').mockImplementation(async (cb) => {
    endings.add(cb);
    return () => void endings.delete(cb);
  });
  TestBed.configureTestingModule({ providers: [{ provide: KataTransport, useValue: transport }] });
  const push = (change: string, kind: StepKind, label: string) => listeners.forEach((cb) => cb({ change: keyOf(change), kind, progress: { kind: 'repository', label, repo: null, check: null } }));
  const end = (change: string) => endings.forEach((cb) => cb(keyOf(change)));
  return { transport, store: TestBed.inject(StepStore), push, end, listening: () => listeners.size };
}

describe('StepStore', () => {
  it('seeds from the steps the backend lists, with the latest label of each', async () => {
    const { store, transport } = setup();
    vi.spyOn(transport, 'steps').mockResolvedValue([running('a', 'preparingBuild', 'Preparing kata'), running('b', 'starting', 'Making the copy')]);
    await store.follow();
    expect(store.running().map((s) => [s.change.change, s.kind, s.label])).toEqual([
      ['a', 'preparingBuild', 'Preparing kata'],
      ['b', 'starting', 'Making the copy'],
    ]);
  });

  it('falls back to what the step is doing when the backend has no line yet', async () => {
    const { store, transport } = setup();
    vi.spyOn(transport, 'steps').mockResolvedValue([{ change: keyOf('a'), kind: 'starting', doing: 'starting', progress: null }]);
    await store.follow();
    expect(store.running()[0].label).toBe('starting');
  });

  it('follows the reports: a first report adds the step, a later one changes its label, an end removes it', async () => {
    const { store, transport, push, end } = setup();
    vi.spyOn(transport, 'steps').mockResolvedValue([]);
    await store.follow();
    push('a', { accepting: 'spec' }, 'Accepting the spec');
    expect(store.running().map((s) => s.label)).toEqual(['Accepting the spec']);
    push('a', { accepting: 'spec' }, 'Accepting the spec: running docs-lint');
    expect(store.running().map((s) => s.label)).toEqual(['Accepting the spec: running docs-lint']);
    end('a');
    expect(store.running()).toEqual([]);
  });

  it('a step that ended while the seed was being read is not brought back by the seed', async () => {
    const { store, transport, end } = setup();
    let answer!: (steps: RunningStep[]) => void;
    vi.spyOn(transport, 'steps').mockReturnValue(new Promise<RunningStep[]>((resolve) => (answer = resolve)));
    const following = store.follow();
    await vi.waitFor(() => expect(transport.steps).toHaveBeenCalled());
    end('a');
    answer([running('a', 'starting', 'Making the copy'), running('b', 'renaming', 'Renaming the change')]);
    await following;
    expect(store.running().map((s) => s.change.change)).toEqual(['b']);
  });

  it('ended() drops the change\'s step when the page\'s own call answered', async () => {
    const { store, transport } = setup();
    vi.spyOn(transport, 'steps').mockResolvedValue([running('a', 'starting', 'x'), running('b', 'renaming', 'y')]);
    await store.follow();
    store.ended({ system: 'commerce', change: 'a' });
    expect(store.running().map((s) => s.change.change)).toEqual(['b']);
  });

  it('following again does not listen twice', async () => {
    const { store, transport, listening } = setup();
    vi.spyOn(transport, 'steps').mockResolvedValue([]);
    await store.follow();
    await store.follow();
    expect(listening()).toBe(1);
  });
});
