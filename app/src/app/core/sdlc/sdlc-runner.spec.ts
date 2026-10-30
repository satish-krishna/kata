import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import type { RunSpec } from '@bindings/RunSpec';
import type { Leftovers } from '@bindings/Leftovers';
import type { Participant } from '@bindings/Participant';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import type { BuildStart } from '@bindings/BuildStart';
import type { PrepareOutcome } from '@bindings/PrepareOutcome';
import type { Readiness } from '@bindings/Readiness';
import type { RepoStart } from '@bindings/RepoStart';
import type { KataEvent, RunState } from '../../lib/events';
import { seedCatalog, seedSpec } from '../../lib/mock';
import { LockStore } from '../lock/lock.store';
import { RunStore } from '../run/run.store';
import { ToastStore } from '../toast/toast.store';
import { KataTransport } from '../transport/kata-transport';
import { SdlcRunner, type BuildLink, type BuildRequest, type RunTarget } from './sdlc-runner';

const SNAPSHOT = { head: 'abc', dirty: {} };
const EMPTY: Leftovers = { new_commits: [], discardable: [], touched_dirty: [], created: [], product_repos_changed: [], product_repos_unchecked: [] };
const WORKSPACE: WorkspaceEntry = { id: 'acme', name: 'acme', folder: '/ws', base_branch: 'main', last_opened: 1 };
const TARGET: RunTarget = {
  workspaceId: 'acme',
  master: '/ws/commerce-docs',
  productRepos: ['commerce-core'],
  link: { system: 'commerce', change: '2026-10-12-photos', stage: 'spec' },
};
const transcript = (path: string): KataEvent => ({ type: 'log', level: 'info', message: `transcript: ${path}` }) as KataEvent;
const repoStart = (repo: string): RepoStart => ({ repo, path: `/ws/${repo}`, base: 'main', branch: 'change/2026-10-12-photos', created: true });
const BUILD_START: BuildStart = { master: repoStart('commerce-docs'), repos: [repoStart('commerce-core')] };
const REQUEST: BuildRequest = {
  folder: '/ws',
  masterRepo: 'commerce-docs',
  system: 'commerce',
  change: '2026-10-12-photos',
  action: 'start',
  continueWithLeftovers: false,
};
const UPDATE_PLUGIN = 'Update the ai-sdlc plugin to 0.9.0 or later, then start the build again.';
const INSTALL_PLUGIN = 'Install the ai-sdlc plugin, then start the build again.';

type FakeSnapshot = { state: RunState; events: KataEvent[]; summary: null; asks: []; permissions: []; exit?: number | null };

class FakeTransport {
  calls: string[] = [];
  leftovers: Leftovers = EMPTY;
  finishResults: (() => Promise<unknown>)[] = [];
  exited = true;
  scan: unknown = null;
  sdlcSnapshot = vi.fn(async (..._a: unknown[]) => { this.calls.push('snapshot'); return SNAPSHOT; });
  sdlcWaitRunExit = vi.fn(async (..._a: unknown[]) => { this.calls.push('wait'); return this.exited; });
  sdlcScan = vi.fn(async (..._a: unknown[]) => { this.calls.push('scan'); return this.scan; });
  sdlcLeftovers = vi.fn(async () => { this.calls.push('leftovers'); return this.leftovers; });
  sdlcDiscard = vi.fn(async (..._a: unknown[]) => { this.calls.push('discard'); });
  sdlcLinkRun = vi.fn(async (..._a: unknown[]) => { this.calls.push('link'); });
  sdlcStartChange = vi.fn(async (..._a: unknown[]) => { this.calls.push('start'); return 'change/pending-1'; });
  sdlcFinishChange = vi.fn(async (..._a: unknown[]) => { this.calls.push('finish'); return this.finishResults.shift()!(); });
  sdlcReadChange = vi.fn(async (..._a: unknown[]) => ({ track: 'full' }));
  sdlcSuggestBranch = vi.fn(async (_f: string, _m: string, _s: string, _c: string, type: string) => `${type}/PROJ-1-password-reset`);
  sdlcConfirmBranch = vi.fn(async (...a: unknown[]) => ({ renamed: { branch: a[5] as string, change: a[3] as string } }));
  sdlcChecksDir = vi.fn(async () => '/kata/workbench/checks');
  sdlcSettings = vi.fn(async () => ({ mode: null, remember: false, permission_mode: 'bypass' as const }));
  catalog = vi.fn(async (..._a: unknown[]) => seedCatalog);
  readiness: Readiness = { kind: 'ready', dir: '/plugins/ai-sdlc', version: '0.9.0', layouts: [1, 2], lightTrack: false, naming: false };
  prepared: PrepareOutcome | (() => Promise<PrepareOutcome>) = { kind: 'ready', start: BUILD_START };
  sdlcPluginReadiness = vi.fn(async (..._a: unknown[]) => { this.calls.push('readiness'); return this.readiness; });
  sdlcBuildPrepare = vi.fn(async (..._a: unknown[]) => {
    this.calls.push('prepare');
    return typeof this.prepared === 'function' ? this.prepared() : this.prepared;
  });
  participants: Participant[] = [];
  sdlcBuildParticipants = vi.fn(async (..._a: unknown[]) => this.participants);
  sdlcBuildSettle = vi.fn(async (..._a: unknown[]) => { this.calls.push('settle'); return [] as string[]; });
  sdlcBuildHeads = vi.fn(async (..._a: unknown[]) => ({ 'commerce-core': 'c0ffee' }));
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
    dismissed: vi.fn(async () => {
      fake.calls.push('dismissed');
    }),
    addRun: vi.fn((..._a: unknown[]) => { fake.calls.push('addRun'); }),
  };
  const snaps = new Map<string, WritableSignal<FakeSnapshot>>();
  const snap = (id: string): WritableSignal<FakeSnapshot> => {
    let s = snaps.get(id);
    if (!s) snaps.set(id, (s = signal<FakeSnapshot>({ state: 'running', events: [], summary: null, asks: [], permissions: [] })));
    return s;
  };
  let started = 0;
  const startRun = vi.fn(async (..._a: unknown[]) => { fake.calls.push('startRun'); return `r${++started}`; });
  const state = signal('idle');
  const toasts = { error: vi.fn(), success: vi.fn(), info: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      { provide: KataTransport, useValue: fake },
      { provide: LockStore, useValue: lock },
      { provide: RunStore, useValue: { events, summary, state, lastRunId: () => '1', startRun, snapshot: snap } },
      { provide: ToastStore, useValue: toasts },
    ],
  });
  const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  return { runner: TestBed.inject(SdlcRunner), fake, lock, toasts, events, summary, active, navigate, state, startRun, snap };
}

describe('SdlcRunner.run', () => {
  it('snapshots before the agent run and toasts the result on success', async () => {
    const ctx = setup(() => { ctx.summary.set({ result: 'Wrote intent.md' }); return 'success'; });
    const out = await ctx.runner.run('Running setup', seedSpec(), { ...TARGET, label: 'Setup' });
    expect(ctx.fake.calls).toEqual(['snapshot', 'agent', 'wait', 'dismissed']);
    expect(ctx.fake.sdlcWaitRunExit).toHaveBeenCalledWith('1', 15000);
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
      ctx.events.set([transcript('/home/u/.kata/runs/sdlc-commerce-context-20261018T000000Z.jsonl')]);
      TestBed.tick();
      ctx.events.update((e) => [...e, { type: 'turn', n: 1 } as KataEvent]);
      TestBed.tick();
      return 'success' as const;
    });
    await ctx.runner.run('Running context', seedSpec(), TARGET);
    expect(ctx.fake.sdlcLinkRun).toHaveBeenCalledTimes(1);
    expect(ctx.fake.sdlcLinkRun).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: 'acme', system: 'commerce', change: '2026-10-12-photos', stage: 'spec',
        run_id: 'sdlc-commerce-context-20261018T000000Z',
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
    expect(fake.calls).toEqual(['snapshot', 'agent', 'wait', 'leftovers', 'dismissed']);
    expect(fake.sdlcLeftovers).toHaveBeenCalledWith('/ws/commerce-docs', SNAPSHOT, ['/ws/commerce-core']);
    expect(runner.leftovers()?.[0].data.discardable).toEqual(['intent.md', 'x.txt']);
    expect(toasts.error).toHaveBeenCalledWith('Running setup stopped · 1 commit landed, 2 files left uncommitted');
  });

  it('touches nothing while the engine is still stopping after a cancel', async () => {
    const { runner, fake, toasts } = setup(() => 'warning');
    fake.exited = false;
    fake.leftovers = { ...EMPTY, discardable: ['x.txt'] };
    await runner.run('Running setup', seedSpec(), TARGET);
    expect(fake.sdlcLeftovers).not.toHaveBeenCalled();
    expect(runner.leftovers()).toBeNull();
    expect(toasts.error).toHaveBeenCalledWith('The engine is still stopping. Nothing was cleaned up.');
    expect(toasts.error).toHaveBeenCalledTimes(1);
  });

  it('treats a failed wait as an engine that is still stopping', async () => {
    const { runner, fake, toasts } = setup(() => 'error');
    fake.sdlcWaitRunExit.mockRejectedValueOnce(new Error('no backend'));
    await runner.run('Running setup', seedSpec(), TARGET);
    expect(fake.sdlcLeftovers).not.toHaveBeenCalled();
    expect(toasts.error).toHaveBeenCalledWith('The engine is still stopping. Nothing was cleaned up.');
  });

  it('opens the dialog when only a product repo could not be checked', async () => {
    const { runner, fake } = setup(() => 'error');
    fake.leftovers = { ...EMPTY, product_repos_unchecked: ['commerce-core'] };
    await runner.run('Running setup', seedSpec(), TARGET);
    expect(runner.leftovers()?.[0].data.product_repos_unchecked).toEqual(['commerce-core']);
  });

  it('toasts a failure without a dialog when nothing was left behind', async () => {
    const { runner, toasts } = setup(() => 'error');
    await runner.run('Running setup', seedSpec(), TARGET);
    expect(runner.leftovers()).toBeNull();
    expect(toasts.error).toHaveBeenCalledWith('Running setup failed · 0 commits landed, 0 files left uncommitted');
  });

  it('returns only once the operator has closed the session view, after the toast', async () => {
    const ctx = setup(() => 'success');
    let close!: () => void;
    ctx.lock.dismissed.mockImplementationOnce(() => new Promise<void>((r) => (close = r)));
    let done = false;
    const p = ctx.runner.run('Reading context', seedSpec(), TARGET).then(() => (done = true));
    await vi.waitFor(() => expect(ctx.lock.dismissed).toHaveBeenCalled());
    expect(ctx.toasts.success).toHaveBeenCalled();
    expect(done).toBe(false);
    close();
    await p;
    expect(done).toBe(true);
  });

  it('is settling from the end of the run until its after-run work is done', async () => {
    const ctx = setup(() => 'warning');
    let exit!: (v: boolean) => void;
    ctx.fake.sdlcWaitRunExit.mockImplementationOnce(() => new Promise<boolean>((r) => (exit = r)));
    let close!: () => void;
    ctx.lock.dismissed.mockImplementationOnce(() => new Promise<void>((r) => (close = r)));
    expect(ctx.runner.settling()).toBe(false);
    const p = ctx.runner.run('Reading context', seedSpec(), TARGET);
    await vi.waitFor(() => expect(ctx.fake.sdlcWaitRunExit).toHaveBeenCalled());
    expect(ctx.runner.settling()).toBe(true);
    exit(true);
    await vi.waitFor(() => expect(ctx.lock.dismissed).toHaveBeenCalled());
    expect(ctx.runner.settling()).toBe(false);
    close();
    await p;
  });

  it('waits for the close even when the engine is still stopping', async () => {
    const { runner, fake, lock } = setup(() => 'warning');
    fake.sdlcWaitRunExit.mockResolvedValueOnce(false);
    await runner.run('Reading context', seedSpec(), TARGET);
    expect(lock.dismissed).toHaveBeenCalled();
  });

  it("names the run's own result in the failure toast", async () => {
    const ctx = setup(() => { ctx.summary.set({ result: 'Not logged in · Please run /login' }); return 'error'; });
    await ctx.runner.run('Running setup', seedSpec(), TARGET);
    expect(ctx.toasts.error).toHaveBeenCalledWith(
      'Running setup failed · Not logged in · Please run /login · 0 commits landed, 0 files left uncommitted',
    );
  });

  it('names the engine error when the run ended without a result', async () => {
    const ctx = setup(() => {
      ctx.events.set([{ type: 'log', level: 'error', message: 'claude not found on PATH' }]);
      return 'error';
    });
    await ctx.runner.run('Running setup', seedSpec(), { ...TARGET, master: null, link: null });
    expect(ctx.toasts.error).toHaveBeenCalledWith(
      'Running setup failed · claude not found on PATH · there was no master repo to compare against',
    );
  });

  it('skips the snapshot and the leftover report when no master repo exists yet', async () => {
    const { runner, fake, toasts } = setup(() => 'error');
    await runner.run('Running setup', seedSpec(), { ...TARGET, master: null, link: null });
    expect(fake.sdlcSnapshot).not.toHaveBeenCalled();
    expect(fake.sdlcLeftovers).not.toHaveBeenCalled();
    expect(runner.leftovers()).toBeNull();
    expect(toasts.error).toHaveBeenCalledWith('Running setup failed · there was no master repo to compare against');
  });

  it('first setup snapshots every repo and reports leftovers against the master it created', async () => {
    const { runner, fake, toasts } = setup(() => 'warning');
    const before = { a: { head: 'a1', dirty: {} }, b: { head: 'b1', dirty: {} } };
    fake.sdlcSnapshot.mockImplementation(async (...a: unknown[]) => {
      fake.calls.push('snapshot');
      return a[0] === '/ws/a-intent' ? before.a : before.b;
    });
    fake.scan = { folder: '/ws', repos: ['a-intent', 'a-core'], master: { kind: 'one', repo: 'a-intent', committed: false }, marker: null, marker_error: null };
    fake.leftovers = { ...EMPTY, discardable: ['.ai-sdlc.json'] };
    await runner.run('Running setup', seedSpec(), {
      ...TARGET, master: null, link: null, productRepos: [], firstSetup: { folder: '/ws', repos: ['a-intent', 'a-core'] },
    });
    expect(fake.sdlcSnapshot.mock.calls.map((c) => c[0])).toEqual(['/ws/a-intent', '/ws/a-core']);
    expect(fake.calls).toEqual(['snapshot', 'snapshot', 'agent', 'wait', 'scan', 'leftovers', 'dismissed']);
    expect(fake.sdlcScan).toHaveBeenCalledWith('/ws');
    expect(fake.sdlcLeftovers).toHaveBeenCalledWith('/ws/a-intent', before.a, ['/ws/a-core']);
    expect(runner.leftovers()?.[0].data.discardable).toEqual(['.ai-sdlc.json']);
    expect(toasts.error).toHaveBeenCalledWith('Running setup stopped · 0 commits landed, 1 file left uncommitted');
  });

  it('first setup that created no master keeps the plain toast', async () => {
    const { runner, fake, toasts } = setup(() => 'error');
    fake.scan = { folder: '/ws', repos: ['a-intent', 'a-core'], master: { kind: 'none' }, marker: null, marker_error: null };
    await runner.run('Running setup', seedSpec(), {
      ...TARGET, master: null, link: null, productRepos: [], firstSetup: { folder: '/ws', repos: ['a-intent', 'a-core'] },
    });
    expect(fake.sdlcLeftovers).not.toHaveBeenCalled();
    expect(toasts.error).toHaveBeenCalledWith('Running setup failed · there was no master repo to compare against');
  });

  it('a first setup that succeeds does not rescan', async () => {
    const { runner, fake } = setup();
    await runner.run('Running setup', seedSpec(), {
      ...TARGET, master: null, link: null, productRepos: [], firstSetup: { folder: '/ws', repos: ['a-intent'] },
    });
    expect(fake.sdlcScan).not.toHaveBeenCalled();
  });

  it('discard sends the chosen paths with the snapshot and clears the dialog', async () => {
    const { runner, fake } = setup(() => 'error');
    fake.leftovers = { ...EMPTY, discardable: ['a.md', 'b.md'] };
    await runner.run('Running setup', seedSpec(), TARGET);
    await runner.discard('commerce-docs', ['b.md']);
    expect(fake.sdlcDiscard).toHaveBeenCalledWith('/ws/commerce-docs', SNAPSHOT, ['b.md']);
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
  const target = { workspace: WORKSPACE, master: '/ws/commerce-docs', productRepos: [] as string[] };

  it('starts the pending branch, runs intent with the idea, finishes, and opens the renamed change', async () => {
    const { runner, fake, lock, navigate } = setup();
    fake.finishResults.push(async () => ({ renamed: { branch: 'change/2026-10-18-x', change: '2026-10-18-x' } }));
    await runner.newChange(target, 'commerce', 'flag prices', 'full');
    expect(fake.calls.filter((c) => c !== 'link')).toEqual(['start', 'snapshot', 'agent', 'wait', 'dismissed', 'finish']);
    expect(fake.sdlcStartChange).toHaveBeenCalledWith('/ws/commerce-docs', 'main');
    expect(fake.sdlcFinishChange).toHaveBeenCalledWith('/ws/commerce-docs', 'change/pending-1', 'main');
    const spec = lock.runAgent.mock.calls[0][1];
    expect(spec.name).toBe('sdlc-commerce-new-intent');
    expect(spec.task).toContain('flag prices');
    expect(navigate).toHaveBeenCalledWith(['/sdlc', 'commerce', '2026-10-18-x']);
  });

  it('passes the picked scope to the intent task (R4.2)', async () => {
    const { runner, fake, lock } = setup();
    fake.finishResults.push(async () => ({ renamed: { branch: 'change/2026-10-18-x', change: '2026-10-18-x' } }));
    await runner.newChange(target, 'commerce', 'flag prices', 'full', undefined, { workType: 'feat', scope: 'PROJ-123' });
    expect(lock.runAgent.mock.calls[0][1].task).toBe('Use the ai-sdlc intent skill for system commerce. The idea: flag prices scope:PROJ-123');
    expect(runner.pickedWorkType()).toBe('feat');
  });

  it('passes the picked scope to the triage task (R4.2)', async () => {
    const { runner, fake, lock } = setup();
    fake.scan = { folder: '/ws', repos: [], master: { kind: 'one', repo: 'commerce-docs', committed: true }, marker: null, marker_error: null };
    fake.finishResults.push(async () => 'deleted');
    await runner.newChange(target, 'commerce', 'flag prices', 'decide', undefined, { workType: 'fix', scope: 'PROJ-123' });
    expect(lock.runAgent.mock.calls[0][1].task).toContain('The change: flag prices scope:PROJ-123. The person');
  });

  it('adds no scope to the task without a naming setting (R2.1)', async () => {
    const { runner, fake, lock } = setup();
    fake.finishResults.push(async () => ({ renamed: { branch: 'change/2026-10-18-x', change: '2026-10-18-x' } }));
    await runner.newChange(target, 'commerce', 'flag prices', 'full');
    expect(lock.runAgent.mock.calls[0][1].task).not.toContain('scope:');
  });

  it('links the new change to the run after the rename', async () => {
    const ctx = setup(async () => {
      ctx.events.set([transcript('/k/runs/sdlc-commerce-new-intent-1.jsonl')]);
      TestBed.tick();
      return 'success' as const;
    });
    ctx.fake.finishResults.push(async () => ({ renamed: { branch: 'change/2026-10-18-x', change: '2026-10-18-x' } }));
    await ctx.runner.newChange(target, 'commerce', 'idea', 'full');
    expect(ctx.fake.sdlcLinkRun).toHaveBeenCalledWith(
      expect.objectContaining({ workspace_id: 'acme', system: 'commerce', change: '2026-10-18-x', stage: 'intent', run_id: 'sdlc-commerce-new-intent-1' }),
    );
  });

  it('returns home with a note when no change folder was created', async () => {
    const { runner, fake, toasts, navigate } = setup();
    fake.finishResults.push(async () => 'deleted');
    await runner.newChange(target, 'commerce', 'idea', 'full');
    expect(toasts.info).toHaveBeenCalledWith('No change was created.');
    expect(navigate).toHaveBeenCalledWith(['/sdlc']);
  });

  it('still finishes the branch when the run is cancelled', async () => {
    const { runner, fake } = setup(() => 'warning');
    fake.finishResults.push(async () => 'deleted');
    await runner.newChange(target, 'commerce', 'idea', 'full');
    expect(fake.sdlcFinishChange).toHaveBeenCalledTimes(1);
  });

  it('keeps the pending branch and finishes nothing while the engine is still stopping', async () => {
    const { runner, fake, toasts, navigate } = setup(() => 'warning');
    fake.exited = false;
    await runner.newChange(target, 'commerce', 'idea', 'full');
    expect(fake.sdlcFinishChange).not.toHaveBeenCalled();
    expect(fake.sdlcLeftovers).not.toHaveBeenCalled();
    expect(toasts.error).toHaveBeenCalledWith(
      'The engine is still stopping. Nothing was cleaned up; the pending branch change/pending-1 was kept.',
    );
    expect(toasts.error).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('shows the leftover dialog on a dirty finish and calls finish again after it closes', async () => {
    const { runner, fake, toasts } = setup();
    fake.leftovers = { ...EMPTY, discardable: ['scratch.txt'] };
    fake.finishResults.push(
      () => Promise.reject('the master repo has uncommitted changes: scratch.txt'),
      async () => 'deleted',
    );
    const done = runner.newChange(target, 'commerce', 'idea', 'full');
    await vi.waitFor(() => expect(runner.leftovers()).not.toBeNull());
    expect(fake.sdlcFinishChange).toHaveBeenCalledTimes(1);
    await runner.discard('commerce-docs', ['scratch.txt']);
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
    const done = runner.newChange(target, 'commerce', 'idea', 'full');
    await vi.waitFor(() => expect(runner.leftovers()).not.toBeNull());
    runner.closeLeftovers();
    await done;
    expect(toasts.error).toHaveBeenCalledWith(expect.stringContaining('change/pending-1'));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('creates no pending branch while a run is active', async () => {
    const { runner, fake, toasts, state, lock } = setup();
    state.set('running');
    await runner.newChange(target, 'commerce', 'idea', 'full');
    expect(fake.sdlcStartChange).not.toHaveBeenCalled();
    expect(lock.runAgent).not.toHaveBeenCalled();
    expect(toasts.error).toHaveBeenCalledWith('Another task is already running.');
  });

  it('creates no branch when the preview is cancelled', async () => {
    const { runner, fake, lock, navigate } = setup();
    const confirm = vi.fn(async (_spec: RunSpec) => null);
    await runner.newChange(target, 'commerce', 'idea', 'full', confirm);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0].task).toContain('idea');
    expect(fake.sdlcStartChange).not.toHaveBeenCalled();
    expect(lock.runAgent).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('runs the confirmed spec, after the preview and before the branch', async () => {
    const { runner, fake, lock } = setup();
    fake.finishResults.push(async () => 'deleted');
    const confirm = vi.fn(async (spec: RunSpec) => {
      fake.calls.push('preview');
      return { ...spec, name: 'confirmed' };
    });
    await runner.newChange(target, 'commerce', 'idea', 'full', confirm);
    expect(fake.calls.slice(0, 2)).toEqual(['preview', 'start']);
    expect((lock.runAgent.mock.calls[0][1] as RunSpec).name).toBe('confirmed');
  });

  it('stops before the run when the pending branch cannot be created', async () => {
    const { runner, fake, toasts, lock } = setup();
    fake.sdlcStartChange.mockRejectedValueOnce('the master repo has uncommitted changes: a.txt');
    await runner.newChange(target, 'commerce', 'idea', 'full');
    expect(lock.runAgent).not.toHaveBeenCalled();
    expect(toasts.error).toHaveBeenCalledWith(expect.stringContaining('uncommitted changes'));
  });
});

describe('SdlcRunner.newChange track', () => {
  const target = { workspace: WORKSPACE, master: '/ws/commerce-docs', productRepos: ['commerce-core'] };
  const SCAN = {
    folder: '/ws',
    repos: ['commerce-docs', 'commerce-core'],
    master: { kind: 'one', repo: 'commerce-docs', committed: true },
    marker: { version: 1, systems: { commerce: { repos: ['commerce-core'] } } },
    marker_error: null,
  };
  const renamed = (change: string) => async () => ({ renamed: { branch: `change/${change}`, change } });
  const withTranscript = () => {
    const ctx = setup(async () => {
      ctx.events.set([transcript('/k/runs/sdlc-commerce-triage-1.jsonl')]);
      TestBed.tick();
      return 'success' as const;
    });
    ctx.fake.scan = SCAN;
    return ctx;
  };

  it('full runs the intent skill, under the sdlc permission posture, and opens the change', async () => {
    const { runner, fake, lock, navigate } = setup();
    fake.finishResults.push(renamed('2026-10-18-x'));
    const outcome = await runner.newChange(target, 'commerce', 'flag prices', 'full');
    const spec = lock.runAgent.mock.calls[0][1] as RunSpec;
    expect(spec.task.startsWith('Use the ai-sdlc intent skill')).toBe(true);
    expect(outcome).toEqual({ kind: 'opened', change: '2026-10-18-x', branch: 'change/2026-10-18-x' });
    expect(navigate).toHaveBeenCalledWith(['/sdlc', 'commerce', '2026-10-18-x']);
  });

  it('decide runs the start skill in auto mode, held to the change documents', async () => {
    const { runner, fake, lock, toasts } = setup();
    fake.scan = SCAN;
    fake.finishResults.push(renamed('2026-10-18-x'));
    await runner.newChange(target, 'commerce', 'flag prices', 'decide');
    const spec = lock.runAgent.mock.calls[0][1] as RunSpec;
    expect(spec.task.startsWith('Use the ai-sdlc start skill')).toBe(true);
    expect(spec.task).toContain('flag prices');
    expect(spec.permissions.mode).toBe('auto');
    expect(spec.permissions.deny?.length).toBeGreaterThan(0);
    expect(spec.interactive.enabled).toBe(true);
    expect(fake.sdlcChecksDir).toHaveBeenCalled();
    expect(toasts.success).toHaveBeenCalledWith(expect.stringMatching(/^Triage finished/));
  });

  it('decide previews the restricted spec and runs the one the engineer confirmed', async () => {
    const { runner, fake, lock } = setup();
    fake.scan = SCAN;
    fake.finishResults.push(renamed('2026-10-18-x'));
    const confirm = vi.fn(async (spec: RunSpec) => ({ ...spec, name: 'confirmed' }));
    await runner.newChange(target, 'commerce', 'flag prices', 'decide', confirm);
    expect(confirm.mock.calls[0][0].permissions.mode).toBe('auto');
    expect((lock.runAgent.mock.calls[0][1] as RunSpec).name).toBe('confirmed');
  });

  it.each([
    ['a fix folder', '2026-10-18-fix-login'],
    ['an intent folder', '2026-10-18-price-flag'],
  ])('decide that ended with %s links the triage run, opens the change and returns opened', async (_label, change) => {
    const ctx = withTranscript();
    ctx.fake.finishResults.push(renamed(change));
    const outcome = await ctx.runner.newChange(target, 'commerce', 'idea', 'decide');
    expect(outcome).toEqual({ kind: 'opened', change, branch: `change/${change}` });
    expect(ctx.fake.sdlcLinkRun).toHaveBeenCalledWith(
      expect.objectContaining({ workspace_id: 'acme', system: 'commerce', change, stage: 'start', run_id: 'sdlc-commerce-triage-1' }),
    );
    expect(ctx.navigate).toHaveBeenCalledWith(['/sdlc', 'commerce', change]);
  });

  it('decide that created no change finishes the branch, says nothing and goes nowhere', async () => {
    const ctx = withTranscript();
    ctx.fake.finishResults.push(async () => 'deleted');
    const outcome = await ctx.runner.newChange(target, 'commerce', 'flag prices', 'decide');
    expect(outcome).toEqual({ kind: 'none', idea: 'flag prices', runId: 'sdlc-commerce-triage-1' });
    expect(ctx.fake.sdlcFinishChange).toHaveBeenCalledTimes(1);
    expect(ctx.fake.sdlcFinishChange).toHaveBeenCalledWith('/ws/commerce-docs', 'change/pending-1', 'main');
    expect(ctx.fake.sdlcLinkRun).not.toHaveBeenCalled();
    expect(ctx.navigate).not.toHaveBeenCalled();
    expect(ctx.toasts.info).not.toHaveBeenCalled();
  });

  it('decide while a task is running is refused, with the toast, and starts nothing', async () => {
    const { runner, fake, toasts, state, lock } = setup();
    fake.scan = SCAN;
    state.set('running');
    const outcome = await runner.newChange(target, 'commerce', 'idea', 'decide');
    expect(outcome).toEqual({ kind: 'refused' });
    expect(toasts.error).toHaveBeenCalledWith('Another task is already running.');
    expect(fake.sdlcStartChange).not.toHaveBeenCalled();
    expect(lock.runAgent).not.toHaveBeenCalled();
  });

  it('full while a task is running is refused too', async () => {
    const { runner, state } = setup();
    state.set('running');
    expect(await runner.newChange(target, 'commerce', 'idea', 'full')).toEqual({ kind: 'refused' });
  });

  it('full that created no change keeps its toast and the return to the list, and returns none', async () => {
    const { runner, fake, toasts, navigate } = setup();
    fake.finishResults.push(async () => 'deleted');
    const outcome = await runner.newChange(target, 'commerce', 'idea', 'full');
    expect(outcome).toMatchObject({ kind: 'none', idea: 'idea' });
    expect(toasts.info).toHaveBeenCalledWith('No change was created.');
    expect(navigate).toHaveBeenCalledWith(['/sdlc']);
  });
});

describe('SdlcRunner.newChange confirming the branch name', () => {
  const target = { workspace: WORKSPACE, master: '/ws/commerce-docs', productRepos: [] as string[] };
  const CHANGE = '2026-11-02-password-reset';
  const needsName = async () => ({ 'needs-name': { pending: 'change/pending-1', system: 'commerce', change: CHANGE } });
  const withTrack = (track: 'full' | 'fix') => {
    const ctx = setup();
    ctx.fake.finishResults.push(needsName);
    ctx.fake.scan = { folder: '/ws', repos: [], master: { kind: 'one', repo: 'commerce-docs', committed: true }, marker: null, marker_error: null };
    ctx.fake.sdlcReadChange.mockResolvedValue({ track });
    return ctx;
  };

  it('a light-track triage preselects fix in the confirmation (R6.7)', async () => {
    const { runner, navigate } = withTrack('fix');
    const done = runner.newChange(target, 'commerce', 'idea', 'decide');
    await vi.waitFor(() => expect(runner.nameRequest()).not.toBeNull());
    expect(runner.nameRequest()!.workType).toBe('fix');
    expect(runner.nameRequest()!.suggestion).toBe('fix/PROJ-1-password-reset');
    expect(navigate).toHaveBeenCalledWith(['/sdlc', 'commerce', CHANGE]);
    await runner.confirmName('fix/PROJ-1-password-reset');
    expect(await done).toEqual({ kind: 'opened', change: CHANGE, branch: 'fix/PROJ-1-password-reset' });
  });

  it('a full start that picked refactor preselects refactor', async () => {
    const { runner } = withTrack('full');
    const done = runner.newChange(target, 'commerce', 'idea', 'full', undefined, { workType: 'refactor', scope: 'PROJ-1' });
    await vi.waitFor(() => expect(runner.nameRequest()).not.toBeNull());
    expect(runner.nameRequest()!.workType).toBe('refactor');
    runner.closeName();
    await done;
  });

  it('a triage that picked another type keeps the pick', async () => {
    const { runner } = withTrack('fix');
    const done = runner.newChange(target, 'commerce', 'idea', 'decide', undefined, { workType: 'perf', scope: 'PROJ-1' });
    await vi.waitFor(() => expect(runner.nameRequest()).not.toBeNull());
    expect(runner.nameRequest()!.workType).toBe('perf');
    runner.closeName();
    await done;
  });

  it('a full pipeline change without a pick preselects feat', async () => {
    const { runner } = withTrack('full');
    const done = runner.newChange(target, 'commerce', 'idea', 'full');
    await vi.waitFor(() => expect(runner.nameRequest()).not.toBeNull());
    expect(runner.nameRequest()!.workType).toBe('feat');
    runner.closeName();
    await done;
  });

  it('closing the confirmation leaves the change waiting for a name (R6.6)', async () => {
    const { runner, fake } = withTrack('full');
    const done = runner.newChange(target, 'commerce', 'idea', 'full');
    await vi.waitFor(() => expect(runner.nameRequest()).not.toBeNull());
    runner.closeName();
    expect(await done).toEqual({ kind: 'stopped' });
    expect(runner.nameRequest()).toBeNull();
    expect(fake.sdlcConfirmBranch).not.toHaveBeenCalled();
  });

  it('a refusal is kept on the request and the confirmation stays open (R6.3)', async () => {
    const { runner, fake } = withTrack('full');
    fake.sdlcConfirmBranch.mockRejectedValueOnce(new Error('clashes with feat/x in kata'));
    const done = runner.newChange(target, 'commerce', 'idea', 'full');
    await vi.waitFor(() => expect(runner.nameRequest()).not.toBeNull());
    await runner.confirmName('feat/x');
    expect(runner.nameRequest()!.error).toBe('clashes with feat/x in kata');
    runner.closeName();
    await done;
  });
});

describe('SdlcRunner build', () => {
  const LINK: BuildLink = { workspaceId: 'acme', system: 'commerce', change: '2026-10-12-photos', folder: '/ws', master: '/ws/commerce-docs', repos: ['commerce-core'] };
  const CORE = { repo: 'commerce-core', path: '/ws/commerce-core', kind: 'repo' } as const;
  const REVIEW = { repo: 'commerce-docs', path: '/ws/commerce-docs', kind: 'review' } as const;
  const GROUP = 'build:commerce/2026-10-12-photos';
  /** A build's leftovers and discards are scoped to its own change: only that change's build log rows are build log data. */
  const BUILD = { system: 'commerce', change: '2026-10-12-photos' };
  const LEFT = (paths: string[]): Leftovers => ({ ...EMPTY, new_commits: ['feat: a task'], discardable: paths });

  /** Ticks the root effects until the promise settles: the run end is observed by an effect. */
  async function drive<T>(p: Promise<T>): Promise<T> {
    let done = false;
    void p.then(() => (done = true), () => (done = true));
    for (let i = 0; i < 200 && !done; i++) {
      TestBed.tick();
      await new Promise((r) => setTimeout(r, 0));
    }
    return p;
  }

  const end = (ctx: ReturnType<typeof setup>, id: string, state: RunState, exit: number | null, extra: KataEvent[] = []) =>
    ctx.snap(id).set({
      state,
      events: [transcript(`/home/u/.kata/runs/sdlc-commerce-${id}.jsonl`), ...extra],
      summary: null,
      asks: [],
      permissions: [],
      exit,
    });

  describe('prepareBuild', () => {
    it('start refuses a plugin the backend finds too old before preparing (R2.5, R10.1)', async () => {
      const ctx = setup();
      ctx.fake.readiness = { kind: 'tooOld', have: '0.7.9', need: '0.9.0' };
      const out = await ctx.runner.prepareBuild(REQUEST);
      expect(out).toEqual({ kind: 'refused', reason: UPDATE_PLUGIN });
      expect(ctx.fake.sdlcPluginReadiness).toHaveBeenCalledWith(REQUEST.folder);
      expect(ctx.fake.sdlcBuildPrepare).not.toHaveBeenCalled();
      expect(ctx.startRun).not.toHaveBeenCalled();
      expect(ctx.fake.calls).toEqual(['readiness']);
    });

    it('refuses when the backend finds the plugin missing', async () => {
      const ctx = setup();
      ctx.fake.readiness = { kind: 'missing' };
      const out = await ctx.runner.prepareBuild(REQUEST);
      expect(out).toEqual({ kind: 'refused', reason: INSTALL_PLUGIN });
      expect(ctx.fake.sdlcBuildPrepare).not.toHaveBeenCalled();
    });

    it('answers ready with the start the backend made', async () => {
      const ctx = setup();
      const out = await ctx.runner.prepareBuild({ ...REQUEST, continueWithLeftovers: true });
      expect(out).toEqual({ kind: 'ready', start: BUILD_START });
      expect(ctx.fake.sdlcBuildPrepare).toHaveBeenCalledWith('/ws', 'commerce-docs', 'commerce', '2026-10-12-photos', true, null, 'start');
    });

    it('answers needs-confirm with the files each repository holds', async () => {
      const ctx = setup();
      ctx.fake.prepared = { kind: 'needsConfirm', leftovers: [{ repo: 'commerce-core', files: ['a.txt'] }] };
      const out = await ctx.runner.prepareBuild(REQUEST);
      expect(out).toEqual({ kind: 'needs-confirm', leftovers: [{ repo: 'commerce-core', files: ['a.txt'] }] });
    });

    it.each(['start', 'continue', 'round'] as const)('refuses with the gate message and the problems it lists: %s (R8.1)', async (action) => {
      const problem = { file: 'build/app.md', line: 14, message: 'entry T1 is recorded twice, first on line 7' };
      const ctx = setup();
      ctx.fake.prepared = { kind: 'refused', message: 'A build log does not pass the check', problems: [problem] };
      const out = await ctx.runner.prepareBuild({ ...REQUEST, action });
      expect(out).toEqual({ kind: 'refused', reason: 'A build log does not pass the check', problems: [problem] });
      expect(ctx.fake.sdlcBuildPrepare).toHaveBeenCalledWith('/ws', 'commerce-docs', 'commerce', '2026-10-12-photos', false, null, action);
    });

    it('refuses with the backend text when preparing fails (R3.1)', async () => {
      const ctx = setup();
      ctx.fake.prepared = () => Promise.reject('commerce-core has uncommitted files: a.txt');
      const out = await ctx.runner.prepareBuild(REQUEST);
      expect(out).toEqual({ kind: 'refused', reason: 'commerce-core has uncommitted files: a.txt' });
    });
  });

  describe('runInRepo', () => {
    it('runInRepo snapshots before the run and links build:<repo>', async () => {
      const ctx = setup();
      const done = ctx.runner.runInRepo(CORE, seedSpec(), LINK);
      await vi.waitFor(() => expect(ctx.startRun).toHaveBeenCalled());
      end(ctx, 'r1', 'success', 0);
      const out = await drive(done);
      expect(out).toEqual({ exit: 0, error: null });
      expect(ctx.fake.sdlcSnapshot).toHaveBeenCalledWith('/ws/commerce-core');
      expect(ctx.startRun).toHaveBeenCalledWith(expect.anything(), GROUP);
      expect(ctx.lock.addRun).toHaveBeenCalledWith('r1', expect.anything());
      expect(ctx.fake.sdlcSnapshot).toHaveBeenCalledWith('/ws/commerce-docs');
      expect(ctx.fake.calls.slice(0, 4)).toEqual(['snapshot', 'snapshot', 'startRun', 'addRun']);
      expect(ctx.fake.sdlcLinkRun).toHaveBeenCalledTimes(1);
      const link = ctx.fake.sdlcLinkRun.mock.calls[0][0] as Record<string, unknown>;
      expect(link).toMatchObject({ workspace_id: 'acme', system: 'commerce', change: '2026-10-12-photos', stage: 'build:commerce-core', run_id: 'sdlc-commerce-r1' });
      expect(link['heads']).toBeUndefined();
      expect(ctx.fake.sdlcBuildHeads).not.toHaveBeenCalled();
      expect(ctx.fake.sdlcWaitRunExit).toHaveBeenCalledWith('r1', 15000);
    });

    it("a review run's link records the heads", async () => {
      const ctx = setup();
      const done = ctx.runner.runInRepo(REVIEW, seedSpec(), LINK);
      await vi.waitFor(() => expect(ctx.startRun).toHaveBeenCalled());
      end(ctx, 'r1', 'success', 0);
      await drive(done);
      expect(ctx.fake.sdlcBuildHeads).toHaveBeenCalledWith('/ws', 'commerce-docs', 'commerce', ['commerce-docs', 'commerce-core'], '2026-10-12-photos');
      expect(ctx.fake.sdlcLinkRun).toHaveBeenCalledWith(expect.objectContaining({ stage: 'review', heads: { 'commerce-core': 'c0ffee' } }));
      expect(ctx.fake.sdlcBuildHeads.mock.invocationCallOrder[0]).toBeLessThan(ctx.startRun.mock.invocationCallOrder[0]);
    });

    it('answers the exit code and the last engine error of a stopped run', async () => {
      const ctx = setup();
      const done = ctx.runner.runInRepo(CORE, seedSpec(), LINK);
      await vi.waitFor(() => expect(ctx.startRun).toHaveBeenCalled());
      end(ctx, 'r1', 'warning', 124, [{ type: 'log', level: 'error', message: 'the wall clock ran out' } as KataEvent]);
      expect(await drive(done)).toEqual({ exit: 124, error: 'the wall clock ran out' });
    });

    it('answers a failed start without reading anything afterwards', async () => {
      const ctx = setup();
      ctx.startRun.mockResolvedValueOnce(null as never);
      const out = await ctx.runner.runInRepo(CORE, seedSpec(), LINK);
      expect(out.exit).toBeNull();
      expect(out.error).toBe('The run did not start');
      expect(ctx.lock.addRun).not.toHaveBeenCalled();
      expect(ctx.fake.sdlcLeftovers).not.toHaveBeenCalled();
    });

    it('touches nothing while the engine is still stopping', async () => {
      const ctx = setup();
      ctx.fake.exited = false;
      const done = ctx.runner.runInRepo(CORE, seedSpec(), LINK);
      await vi.waitFor(() => expect(ctx.startRun).toHaveBeenCalled());
      end(ctx, 'r1', 'warning', 130);
      const out = await drive(done);
      expect(out.exit).toBe(130);
      expect(out.error).toBe('The engine is still stopping');
      expect(ctx.fake.sdlcLeftovers).not.toHaveBeenCalled();
    });
  });

  describe('leftovers and finishBuild', () => {
    async function runBoth(ctx: ReturnType<typeof setup>) {
      ctx.fake.sdlcSnapshot.mockImplementation(async (...a: unknown[]) => { ctx.fake.calls.push('snapshot'); return { head: String(a[0]), dirty: {} }; });
      ctx.fake.sdlcLeftovers.mockImplementation((async (path: string) => LEFT(path === '/ws/commerce-core' ? ['src/x.rs'] : ['notes.md'])) as never);
      const core = ctx.runner.runInRepo(CORE, seedSpec(), LINK);
      await vi.waitFor(() => expect(ctx.startRun).toHaveBeenCalledTimes(1));
      end(ctx, 'r1', 'warning', 124);
      await drive(core);
      const review = ctx.runner.runInRepo(REVIEW, seedSpec(), LINK);
      await vi.waitFor(() => expect(ctx.startRun).toHaveBeenCalledTimes(2));
      end(ctx, 'r2', 'warning', 130);
      await drive(review);
    }

    it("leftovers are reported per repository and discard touches only that run's files (R6.3)", async () => {
      const ctx = setup();
      await runBoth(ctx);
      expect(ctx.fake.sdlcLeftovers).toHaveBeenCalledWith('/ws/commerce-core', { head: '/ws/commerce-core', dirty: {} }, [], BUILD);
      // The build is still going when a repository ends: nothing opens until the build is over.
      expect(ctx.runner.leftovers()).toBeNull();
      const finished = ctx.runner.finishBuild(BUILD_START);
      await vi.waitFor(() => expect(ctx.runner.leftovers()).not.toBeNull());
      expect(ctx.runner.leftovers()!.map((l) => l.repo)).toEqual(['commerce-docs', 'commerce-core']);
      expect(ctx.runner.leftovers()![1].data.new_commits).toEqual([]);
      expect(ctx.fake.sdlcBuildSettle).not.toHaveBeenCalled();
      await expect(ctx.runner.discard('commerce-core', ['src/x.rs'])).resolves.toBe(true);
      expect(ctx.fake.sdlcDiscard).toHaveBeenCalledTimes(1);
      expect(ctx.fake.sdlcDiscard).toHaveBeenCalledWith('/ws/commerce-core', { head: '/ws/commerce-core', dirty: {} }, ['src/x.rs'], BUILD);
      expect(ctx.runner.leftovers()!.map((l) => l.repo)).toEqual(['commerce-docs']);
      expect(ctx.fake.sdlcBuildSettle).not.toHaveBeenCalled();
      ctx.runner.closeLeftovers();
      await finished;
      expect(ctx.fake.sdlcBuildSettle).toHaveBeenCalledWith(BUILD_START);
      expect(ctx.runner.leftovers()).toBeNull();
    });

    it("an unsaved build log row is listed at the end of the build under the repository that owns it, not under the master (R6.6)", async () => {
      const ctx = setup();
      const row = 'intent/commerce/2026-10-12-photos/build/commerce-core.md';
      const owned = (repo: string, rows: string[]): Participant => ({ repo, path: `/ws/${repo}`, master: repo === 'commerce-docs', files: [], rows });
      ctx.fake.participants = [owned('commerce-docs', []), owned('commerce-core', [row])];
      const core = ctx.runner.runInRepo(CORE, seedSpec(), LINK);
      await vi.waitFor(() => expect(ctx.startRun).toHaveBeenCalledTimes(1));
      end(ctx, 'r1', 'warning', 124);
      await drive(core);
      expect(ctx.fake.sdlcBuildParticipants).toHaveBeenCalledWith('/ws', 'commerce-docs', 'commerce', '2026-10-12-photos', null);

      const finished = ctx.runner.finishBuild(BUILD_START);
      await vi.waitFor(() => expect(ctx.runner.leftovers()).not.toBeNull());
      const shown = ctx.runner.leftovers()!;
      expect(shown.map((l) => l.repo)).toEqual(['commerce-core']);
      // The run wrote the row: it is listed as created by this run, not as changed before it too.
      expect(shown[0].data.created).toEqual([row]);
      expect(shown[0].data.touched_dirty).toEqual([]);
      expect(shown[0].data.discardable).toEqual([]);
      ctx.runner.closeLeftovers();
      await finished;
    });

    it.each(['D:\\ws\\commerce-docs', 'D:\\ws\\commerce-docs\\'])('a Windows master path %s names its repository in the participants call', async (master) => {
      const ctx = setup();
      const core = ctx.runner.runInRepo(CORE, seedSpec(), { ...LINK, master });
      await vi.waitFor(() => expect(ctx.startRun).toHaveBeenCalledTimes(1));
      end(ctx, 'r1', 'warning', 124);
      await drive(core);
      expect(ctx.fake.sdlcBuildParticipants).toHaveBeenCalledWith('/ws', 'commerce-docs', 'commerce', '2026-10-12-photos', null);
    });

    it('a build log row that was already unsaved before the run is listed as changed before and during it (R6.6)', async () => {
      const ctx = setup();
      const row = 'intent/commerce/2026-10-12-photos/build/commerce-core.md';
      const owned = (repo: string, rows: string[]): Participant => ({ repo, path: `/ws/${repo}`, master: repo === 'commerce-docs', files: [], rows });
      ctx.fake.participants = [owned('commerce-docs', []), owned('commerce-core', [row])];
      ctx.fake.sdlcSnapshot.mockImplementation(async (...a: unknown[]) => ({ head: String(a[0]), dirty: { [row]: 'abc' } }));
      const core = ctx.runner.runInRepo(CORE, seedSpec(), LINK);
      await vi.waitFor(() => expect(ctx.startRun).toHaveBeenCalledTimes(1));
      end(ctx, 'r1', 'warning', 124);
      await drive(core);
      const finished = ctx.runner.finishBuild(BUILD_START);
      await vi.waitFor(() => expect(ctx.runner.leftovers()).not.toBeNull());
      const shown = ctx.runner.leftovers()!;
      expect(shown[0].data.touched_dirty).toEqual([row]);
      expect(shown[0].data.created).toEqual([]);
      ctx.runner.closeLeftovers();
      await finished;
    });

    it("a build log row is classified against the master's snapshot, not the repository's (R6.6)", async () => {
      const ctx = setup();
      const row = 'intent/commerce/2026-10-12-photos/build/commerce-core.md';
      const owned = (repo: string, rows: string[]): Participant => ({ repo, path: `/ws/${repo}`, master: repo === 'commerce-docs', files: [], rows });
      ctx.fake.participants = [owned('commerce-docs', []), owned('commerce-core', [row])];
      // The row sits in the master's tree and was unsaved before the run; the repository's own tree knows nothing of it.
      ctx.fake.sdlcSnapshot.mockImplementation(async (...a: unknown[]) => ({ head: String(a[0]), dirty: a[0] === '/ws/commerce-docs' ? { [row]: 'abc' } : {} }));
      const core = ctx.runner.runInRepo(CORE, seedSpec(), LINK);
      await vi.waitFor(() => expect(ctx.startRun).toHaveBeenCalledTimes(1));
      end(ctx, 'r1', 'warning', 124);
      await drive(core);
      const finished = ctx.runner.finishBuild(BUILD_START);
      await vi.waitFor(() => expect(ctx.runner.leftovers()).not.toBeNull());
      const shown = ctx.runner.leftovers()!;
      expect(shown[0].data.touched_dirty).toEqual([row]);
      expect(shown[0].data.created).toEqual([]);
      ctx.runner.closeLeftovers();
      await finished;
    });

    it("a build log row the master did not hold dirty is created by the run, whatever the repository's own tree held (R6.6)", async () => {
      const ctx = setup();
      const row = 'intent/commerce/2026-10-12-photos/build/commerce-core.md';
      const owned = (repo: string, rows: string[]): Participant => ({ repo, path: `/ws/${repo}`, master: repo === 'commerce-docs', files: [], rows });
      ctx.fake.participants = [owned('commerce-docs', []), owned('commerce-core', [row])];
      ctx.fake.sdlcSnapshot.mockImplementation(async (...a: unknown[]) => ({ head: String(a[0]), dirty: a[0] === '/ws/commerce-core' ? { [row]: 'abc' } : {} }));
      const core = ctx.runner.runInRepo(CORE, seedSpec(), LINK);
      await vi.waitFor(() => expect(ctx.startRun).toHaveBeenCalledTimes(1));
      end(ctx, 'r1', 'warning', 124);
      await drive(core);
      const finished = ctx.runner.finishBuild(BUILD_START);
      await vi.waitFor(() => expect(ctx.runner.leftovers()).not.toBeNull());
      const shown = ctx.runner.leftovers()!;
      expect(shown[0].data.created).toEqual([row]);
      expect(shown[0].data.touched_dirty).toEqual([]);
      ctx.runner.closeLeftovers();
      await finished;
    });

    it('discardAll discards every chosen repository, then closes and keeps the rest', async () => {
      const ctx = setup();
      await runBoth(ctx);
      const finished = ctx.runner.finishBuild(BUILD_START);
      await vi.waitFor(() => expect(ctx.runner.leftovers()).not.toBeNull());
      await expect(ctx.runner.discardAll([{ repo: 'commerce-core', paths: ['src/x.rs'] }, { repo: 'commerce-docs', paths: [] }])).resolves.toBe(true);
      expect(ctx.fake.sdlcDiscard).toHaveBeenCalledTimes(1);
      await finished;
      expect(ctx.fake.sdlcBuildSettle).toHaveBeenCalledTimes(1);
    });

    it('a failed discard keeps the dialog open', async () => {
      const ctx = setup();
      await runBoth(ctx);
      const finished = ctx.runner.finishBuild(BUILD_START);
      await vi.waitFor(() => expect(ctx.runner.leftovers()).not.toBeNull());
      ctx.fake.sdlcDiscard.mockRejectedValueOnce(new Error('locked'));
      await expect(ctx.runner.discardAll([{ repo: 'commerce-core', paths: ['src/x.rs'] }])).resolves.toBe(false);
      expect(ctx.toasts.error).toHaveBeenCalledWith('Could not discard: locked');
      expect(ctx.runner.leftovers()).toHaveLength(2);
      expect(ctx.fake.sdlcBuildSettle).not.toHaveBeenCalled();
      ctx.runner.closeLeftovers();
      await finished;
    });

    it('settles at once when no repository left anything', async () => {
      const ctx = setup();
      const done = ctx.runner.runInRepo(CORE, seedSpec(), LINK);
      await vi.waitFor(() => expect(ctx.startRun).toHaveBeenCalled());
      end(ctx, 'r1', 'success', 0);
      await drive(done);
      await ctx.runner.finishBuild(BUILD_START);
      expect(ctx.fake.sdlcBuildSettle).toHaveBeenCalledWith(BUILD_START);
      expect(ctx.runner.leftovers()).toBeNull();
    });

    it('a settle error toasts and does not throw', async () => {
      const ctx = setup();
      ctx.fake.sdlcBuildSettle.mockRejectedValueOnce(new Error('git is busy'));
      await expect(ctx.runner.finishBuild(BUILD_START)).resolves.toBeUndefined();
      expect(ctx.toasts.error).toHaveBeenCalledWith(expect.stringContaining('git is busy'));
    });
  });

  it('part 1 runs still report master leftovers as one entry', async () => {
    const { runner, fake } = setup(() => 'warning');
    fake.leftovers = { ...EMPTY, new_commits: ['docs: a'], discardable: ['x.txt'] };
    await runner.run('Running setup', seedSpec(), TARGET);
    expect(runner.leftovers()).toEqual([{ repo: 'commerce-docs', path: '/ws/commerce-docs', snapshot: SNAPSHOT, data: fake.leftovers }]);
  });
});
