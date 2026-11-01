import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import type { RunSpec } from '@bindings/RunSpec';
import type { Leftovers } from '@bindings/Leftovers';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import type { Readiness } from '@bindings/Readiness';
import type { KataEvent, RunState } from '../../lib/events';
import { seedCatalog, seedSpec } from '../../lib/mock';
import { LockStore } from '../lock/lock.store';
import { RunStore } from '../run/run.store';
import { ToastStore } from '../toast/toast.store';
import { KataTransport } from '../transport/kata-transport';
import { SdlcRunner, type RunTarget } from './sdlc-runner';

const SNAPSHOT = { head: 'abc', dirty: {} };
const EMPTY: Leftovers = { new_commits: [], discardable: [], touched_dirty: [], created: [], product_repos_changed: [], product_repos_unchecked: [] };
const WORKSPACE: WorkspaceEntry = { id: 'acme', name: 'acme', folder: '/ws', last_opened: 1 };
const TARGET: RunTarget = {
  workspaceId: 'acme',
  master: '/ws/commerce-docs',
  productRepos: ['commerce-core'],
  link: { system: 'commerce', change: '2026-10-12-photos', stage: 'spec' },
};
const transcript = (path: string): KataEvent => ({ type: 'log', level: 'info', message: `transcript: ${path}` }) as KataEvent;

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
  sdlcChangeState = vi.fn(async (..._a: unknown[]) => ({ state: { track: 'full' } }));
  sdlcSuggestBranch = vi.fn(async (_f: string, _m: string, _s: string, _c: string, type: string) => `${type}/PROJ-1-password-reset`);
  sdlcConfirmBranch = vi.fn(async (...a: unknown[]) => ({ renamed: { branch: a[5] as string, change: a[3] as string } }));
  sdlcChecksDir = vi.fn(async () => '/kata/workbench/checks');
  sdlcSettings = vi.fn(async () => ({ mode: null, remember: false, permission_mode: 'bypass' as const }));
  catalog = vi.fn(async (..._a: unknown[]) => seedCatalog);
  readiness: Readiness = { kind: 'ready', plugin: { dir: '/plugins/ai-sdlc', version: '0.9.0', layouts: [1, 2] }, gh: 'present' };
  sdlcPluginReadiness = vi.fn(async (..._a: unknown[]) => { this.calls.push('readiness'); return this.readiness; });
  sdlcBuildHeads = vi.fn(async (..._a: unknown[]) => ({ 'commerce-core': 'c0ffee' }));
  sdlcRunChange = vi.fn(async (..._a: unknown[]) => '41');
}

function setup(agent: (spec: RunSpec) => Promise<RunState> | RunState = () => 'success') {
  const fake = new FakeTransport();
  const events = signal<KataEvent[]>([]);
  const summary = signal<{ result?: string | null } | null>(null);
  const active = signal<unknown>(null);
  const lock = {
    active,
    runAgent: vi.fn(async (_title: string, spec: RunSpec, _via?: (s: RunSpec) => Promise<string>) => {
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

describe('SdlcRunner.run for a change that exists', () => {
  const ref = { workspace: '/ws', system: 'commerce', change: '2026-10-12-photos' };

  it('launches a spec run through sdlcRunChange, not through run_spec', async () => {
    const { runner, lock, fake } = setup();
    const spec: RunSpec = { ...seedSpec(), name: 'sdlc-commerce-photos-spec', task: 'Use the ai-sdlc spec skill.' };
    spec.permissions = { mode: 'auto', allow: [], deny: [], ask: [], unmatched: 'ask' };
    spec.leash = { ...spec.leash, timeout_secs: 7200 };
    spec.given = { hooks: [], skills: ['brainstorming'], plugins: [], instructions: [], tool_servers: [], required_plugins: ['ai-sdlc'] };
    await runner.run('Starting spec', spec, TARGET, { ref, kind: 'spec' });
    const via = lock.runAgent.mock.calls[0][2] as ((s: RunSpec) => Promise<string>) | undefined;
    expect(via).toBeTypeOf('function');
    expect(await via!(spec)).toBe('41');
    expect(fake.sdlcRunChange).toHaveBeenCalledWith(ref, 'spec', {
      name: 'sdlc-commerce-photos-spec',
      task: 'Use the ai-sdlc spec skill.',
      permissionMode: 'auto',
      timeoutSecs: 7200,
      bare: false,
      given: spec.given,
    });
  });

  it('a run of no change goes the old way', async () => {
    const { runner, lock } = setup();
    await runner.run('Running setup', seedSpec(), TARGET);
    expect(lock.runAgent.mock.calls[0]).toHaveLength(2);
  });
});

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
    expect(fake.sdlcStartChange).toHaveBeenCalledWith('/ws/commerce-docs');
    expect(fake.sdlcFinishChange).toHaveBeenCalledWith('/ws/commerce-docs', 'change/pending-1');
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
    const task: string = lock.runAgent.mock.calls[0][1].task;
    expect(task).toContain('The change: flag prices scope:PROJ-123\nThe person');
    expect(task.charAt(task.indexOf('scope:PROJ-123') + 'scope:PROJ-123'.length)).toMatch(/^\s$/);
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
    expect(ctx.fake.sdlcFinishChange).toHaveBeenCalledWith('/ws/commerce-docs', 'change/pending-1');
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
    ctx.fake.sdlcChangeState.mockResolvedValue({ state: { track } });
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

describe('SdlcRunner leftovers', () => {
  it('part 1 runs still report master leftovers as one entry', async () => {
    const { runner, fake } = setup(() => 'warning');
    fake.leftovers = { ...EMPTY, new_commits: ['docs: a'], discardable: ['x.txt'] };
    await runner.run('Running setup', seedSpec(), TARGET);
    expect(runner.leftovers()).toEqual([{ repo: 'commerce-docs', path: '/ws/commerce-docs', snapshot: SNAPSHOT, data: fake.leftovers }]);
  });
});
