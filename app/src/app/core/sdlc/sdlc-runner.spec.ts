import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import type { RunSpec } from '@bindings/RunSpec';
import type { Leftovers } from '@bindings/Leftovers';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import type { KataEvent, RunState } from '../../lib/events';
import { seedCatalog, seedSpec } from '../../lib/mock';
import { LockStore } from '../lock/lock.store';
import { RunStore } from '../run/run.store';
import { ToastStore } from '../toast/toast.store';
import { KataTransport } from '../transport/kata-transport';
import { SdlcRunner, type RunTarget } from './sdlc-runner';

const SNAPSHOT = { head: 'abc', dirty: {} };
const EMPTY: Leftovers = { new_commits: [], discardable: [], touched_dirty: [], product_repos_changed: [] };
const WORKSPACE: WorkspaceEntry = { id: 'acme', name: 'acme', folder: '/ws', base_branch: 'main', last_opened: 1 };
const TARGET: RunTarget = {
  workspaceId: 'acme',
  master: '/ws/claims-intent',
  productRepos: ['claims-core'],
  link: { system: 'claims', change: '2026-10-12-fnol', stage: 'spec' },
};
const transcript = (path: string): KataEvent => ({ type: 'log', level: 'info', message: `transcript: ${path}` }) as KataEvent;

class FakeTransport {
  calls: string[] = [];
  leftovers: Leftovers = EMPTY;
  finishResults: (() => Promise<unknown>)[] = [];
  sdlcSnapshot = vi.fn(async () => { this.calls.push('snapshot'); return SNAPSHOT; });
  sdlcLeftovers = vi.fn(async () => { this.calls.push('leftovers'); return this.leftovers; });
  sdlcDiscard = vi.fn(async (..._a: unknown[]) => { this.calls.push('discard'); });
  sdlcLinkRun = vi.fn(async (..._a: unknown[]) => { this.calls.push('link'); });
  sdlcStartChange = vi.fn(async (..._a: unknown[]) => { this.calls.push('start'); return 'change/pending-1'; });
  sdlcFinishChange = vi.fn(async (..._a: unknown[]) => { this.calls.push('finish'); return this.finishResults.shift()!(); });
  sdlcSettings = vi.fn(async () => ({ mode: null, remember: false, permission_mode: 'bypass' as const }));
  catalog = vi.fn(async (..._a: unknown[]) => seedCatalog);
}

function setup(agent: (spec: RunSpec) => Promise<RunState> | RunState = () => 'success') {
  const fake = new FakeTransport();
  const events = signal<KataEvent[]>([]);
  const summary = signal<{ result?: string | null } | null>(null);
  const active = signal<unknown>(null);
  const lock = {
    active,
    runAgent: vi.fn(async (_title: string, spec: RunSpec) => {
      fake.calls.push('agent');
      return agent(spec);
    }),
  };
  const toasts = { error: vi.fn(), success: vi.fn(), info: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      { provide: KataTransport, useValue: fake },
      { provide: LockStore, useValue: lock },
      { provide: RunStore, useValue: { events, summary, state: signal('idle') } },
      { provide: ToastStore, useValue: toasts },
    ],
  });
  const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  return { runner: TestBed.inject(SdlcRunner), fake, lock, toasts, events, summary, active, navigate };
}

describe('SdlcRunner.run', () => {
  it('snapshots before the agent run and toasts the result on success', async () => {
    const ctx = setup(() => { ctx.summary.set({ result: 'Wrote intent.md' }); return 'success'; });
    const out = await ctx.runner.run('Running setup', seedSpec(), { ...TARGET, label: 'Setup' });
    expect(ctx.fake.calls).toEqual(['snapshot', 'agent']);
    expect(out.state).toBe('success');
    expect(ctx.toasts.success).toHaveBeenCalledWith('Setup finished · Wrote intent.md');
    expect(ctx.runner.leftovers()).toBeNull();
  });

  it('falls back to "done" when the run has no result text', async () => {
    const { runner, toasts } = setup();
    await runner.run('Running context', seedSpec(), TARGET);
    expect(toasts.success).toHaveBeenCalledWith('Running context finished · done');
  });

  it('truncates a long result', async () => {
    const ctx = setup(() => { ctx.summary.set({ result: 'x'.repeat(300) }); return 'success'; });
    await ctx.runner.run('Running context', seedSpec(), TARGET);
    const text = ctx.toasts.success.mock.calls[0][0] as string;
    expect(text.length).toBeLessThan(200);
    expect(text.endsWith('…')).toBe(true);
  });

  it('refuses a second lock with a clear toast and starts nothing', async () => {
    const { runner, fake, lock, toasts, active } = setup();
    active.set({ kind: 'run', title: 'busy' });
    const out = await runner.run('Running setup', seedSpec(), TARGET);
    expect(out.state).toBe('error');
    expect(toasts.error).toHaveBeenCalledWith('Another task is already running.');
    expect(fake.sdlcSnapshot).not.toHaveBeenCalled();
    expect(lock.runAgent).not.toHaveBeenCalled();
  });

  it('links the run once the transcript id appears, and only once', async () => {
    const ctx = setup(async () => {
      ctx.events.set([transcript('/home/u/.kata/runs/sdlc-claims-context-20261018T000000Z.jsonl')]);
      TestBed.tick();
      ctx.events.update((e) => [...e, { type: 'turn', n: 1 } as KataEvent]);
      TestBed.tick();
      return 'success' as const;
    });
    await ctx.runner.run('Running context', seedSpec(), TARGET);
    expect(ctx.fake.sdlcLinkRun).toHaveBeenCalledTimes(1);
    expect(ctx.fake.sdlcLinkRun).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: 'acme', system: 'claims', change: '2026-10-12-fnol', stage: 'spec',
        run_id: 'sdlc-claims-context-20261018T000000Z',
      }),
    );
  });

  it('does not read leftovers after a success', async () => {
    const { runner, fake } = setup();
    await runner.run('Running context', seedSpec(), TARGET);
    expect(fake.sdlcLeftovers).not.toHaveBeenCalled();
  });

  it('reads leftovers after a cancel, opens the dialog and names the counts in an error toast', async () => {
    const { runner, fake, toasts } = setup(() => 'warning');
    fake.leftovers = { ...EMPTY, new_commits: ['docs: a'], discardable: ['intent.md', 'x.txt'] };
    await runner.run('Running setup', seedSpec(), TARGET);
    expect(fake.sdlcLeftovers).toHaveBeenCalledWith('/ws/claims-intent', SNAPSHOT, ['claims-core']);
    expect(runner.leftovers()?.discardable).toEqual(['intent.md', 'x.txt']);
    expect(toasts.error).toHaveBeenCalledWith('Running setup stopped · 1 commit landed, 2 files left uncommitted');
  });

  it('toasts a failure without a dialog when nothing was left behind', async () => {
    const { runner, toasts } = setup(() => 'error');
    await runner.run('Running setup', seedSpec(), TARGET);
    expect(runner.leftovers()).toBeNull();
    expect(toasts.error).toHaveBeenCalledWith('Running setup failed · 0 commits landed, 0 files left uncommitted');
  });

  it('skips the snapshot and the leftover report when no master repo exists yet', async () => {
    const { runner, fake, toasts } = setup(() => 'error');
    await runner.run('Running setup', seedSpec(), { ...TARGET, master: null, link: null });
    expect(fake.sdlcSnapshot).not.toHaveBeenCalled();
    expect(fake.sdlcLeftovers).not.toHaveBeenCalled();
    expect(runner.leftovers()).toBeNull();
    expect(toasts.error).toHaveBeenCalledWith('Running setup failed · there was no master repo to compare against');
  });

  it('discard sends the chosen paths with the snapshot and clears the dialog', async () => {
    const { runner, fake } = setup(() => 'error');
    fake.leftovers = { ...EMPTY, discardable: ['a.md', 'b.md'] };
    await runner.run('Running setup', seedSpec(), TARGET);
    await runner.discard(['b.md']);
    expect(fake.sdlcDiscard).toHaveBeenCalledWith('/ws/claims-intent', SNAPSHOT, ['b.md']);
    expect(runner.leftovers()).toBeNull();
  });

  it('close clears the dialog without discarding', async () => {
    const { runner, fake } = setup(() => 'error');
    fake.leftovers = { ...EMPTY, new_commits: ['c'] };
    await runner.run('Running setup', seedSpec(), TARGET);
    runner.closeLeftovers();
    expect(runner.leftovers()).toBeNull();
    expect(fake.sdlcDiscard).not.toHaveBeenCalled();
  });
});

describe('SdlcRunner.newChange', () => {
  const target = { workspace: WORKSPACE, master: '/ws/claims-intent', productRepos: [] as string[] };

  it('starts the pending branch, runs intent with the idea, finishes, and opens the renamed change', async () => {
    const { runner, fake, lock, navigate } = setup();
    fake.finishResults.push(async () => ({ renamed: { branch: 'change/2026-10-18-x', change: '2026-10-18-x' } }));
    await runner.newChange(target, 'claims', 'flag fraud');
    expect(fake.calls.filter((c) => c !== 'link')).toEqual(['start', 'snapshot', 'agent', 'finish']);
    expect(fake.sdlcStartChange).toHaveBeenCalledWith('/ws/claims-intent', 'main');
    expect(fake.sdlcFinishChange).toHaveBeenCalledWith('/ws/claims-intent', 'change/pending-1', 'main');
    const spec = lock.runAgent.mock.calls[0][1];
    expect(spec.name).toBe('sdlc-claims-new-intent');
    expect(spec.task).toContain('flag fraud');
    expect(navigate).toHaveBeenCalledWith(['/sdlc', 'claims', '2026-10-18-x']);
  });

  it('links the new change to the run after the rename', async () => {
    const ctx = setup(async () => {
      ctx.events.set([transcript('/k/runs/sdlc-claims-new-intent-1.jsonl')]);
      TestBed.tick();
      return 'success' as const;
    });
    ctx.fake.finishResults.push(async () => ({ renamed: { branch: 'change/2026-10-18-x', change: '2026-10-18-x' } }));
    await ctx.runner.newChange(target, 'claims', 'idea');
    expect(ctx.fake.sdlcLinkRun).toHaveBeenCalledWith(
      expect.objectContaining({ workspace_id: 'acme', system: 'claims', change: '2026-10-18-x', stage: 'intent', run_id: 'sdlc-claims-new-intent-1' }),
    );
  });

  it('returns home with a note when no change folder was created', async () => {
    const { runner, fake, toasts, navigate } = setup();
    fake.finishResults.push(async () => 'deleted');
    await runner.newChange(target, 'claims', 'idea');
    expect(toasts.info).toHaveBeenCalledWith('No change was created.');
    expect(navigate).toHaveBeenCalledWith(['/sdlc']);
  });

  it('still finishes the branch when the run is cancelled', async () => {
    const { runner, fake } = setup(() => 'warning');
    fake.finishResults.push(async () => 'deleted');
    await runner.newChange(target, 'claims', 'idea');
    expect(fake.sdlcFinishChange).toHaveBeenCalledTimes(1);
  });

  it('shows the leftover dialog on a dirty finish and calls finish again after it closes', async () => {
    const { runner, fake, toasts } = setup();
    fake.leftovers = { ...EMPTY, discardable: ['scratch.txt'] };
    fake.finishResults.push(
      () => Promise.reject('the master repo has uncommitted changes: scratch.txt'),
      async () => 'deleted',
    );
    const done = runner.newChange(target, 'claims', 'idea');
    await vi.waitFor(() => expect(runner.leftovers()).not.toBeNull());
    expect(fake.sdlcFinishChange).toHaveBeenCalledTimes(1);
    await runner.discard(['scratch.txt']);
    await done;
    expect(fake.sdlcFinishChange).toHaveBeenCalledTimes(2);
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it('names the kept pending branch when finish still fails', async () => {
    const { runner, fake, toasts, navigate } = setup();
    fake.leftovers = { ...EMPTY, discardable: ['scratch.txt'] };
    fake.finishResults.push(
      () => Promise.reject('the master repo has uncommitted changes: scratch.txt'),
      () => Promise.reject('the master repo has uncommitted changes: scratch.txt'),
    );
    const done = runner.newChange(target, 'claims', 'idea');
    await vi.waitFor(() => expect(runner.leftovers()).not.toBeNull());
    runner.closeLeftovers();
    await done;
    expect(toasts.error).toHaveBeenCalledWith(expect.stringContaining('change/pending-1'));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('stops before the run when the pending branch cannot be created', async () => {
    const { runner, fake, toasts, lock } = setup();
    fake.sdlcStartChange.mockRejectedValueOnce('the master repo has uncommitted changes: a.txt');
    await runner.newChange(target, 'claims', 'idea');
    expect(lock.runAgent).not.toHaveBeenCalled();
    expect(toasts.error).toHaveBeenCalledWith(expect.stringContaining('uncommitted changes'));
  });
});
