import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import type { RunSpec } from '@bindings/RunSpec';
import type { WorkspaceScan } from '@bindings/WorkspaceScan';
import { toastState } from '@spartan-ng/brain/sonner';
import { LockStore } from '../../core/lock/lock.store';
import { SdlcRunner } from '../../core/sdlc/sdlc-runner';
import { RunPreviewViewModel } from '../../core/given/run-preview.view-model';
import { KataTransport } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import { MOCK_WORKSPACE_FOLDER, MOCK_MASTER } from '../../lib/sdlc-mock';
import { seedCatalog } from '../../lib/mock';
import { SdlcHomeViewModel } from './sdlc-home.view-model';

const NEW_FOLDER = 'D:/Work/new-ws';
const toastText = () => toastState.toasts().map((t) => String(t.title)).join(' | ');
const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
  TestBed.tick();
};

/** `preview: 'confirm'` (the default) lets the preview confirm every run at once, so a test about something else never meets it; `'real'` leaves it to the test. */
function setup(over: { catalogHasPlugin?: boolean; preview?: 'confirm' | 'real' } = {}) {
  const transport = new MockTransport();
  if (over.catalogHasPlugin === false) vi.spyOn(transport, 'catalog').mockResolvedValue(seedCatalog);
  TestBed.configureTestingModule({
    providers: [SdlcHomeViewModel, RunPreviewViewModel, { provide: KataTransport, useValue: transport }, provideRouter([])],
  });
  const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  const lock = TestBed.inject(LockStore);
  const runAgent = vi.spyOn(lock, 'runAgent').mockResolvedValue('success');
  const runSteps = vi.spyOn(lock, 'runSteps');
  const saveWorkspaces = vi.spyOn(transport, 'sdlcSaveWorkspaces');
  const saveSettings = vi.spyOn(transport, 'sdlcSaveSettings');
  const preview = TestBed.inject(RunPreviewViewModel);
  if (over.preview !== 'real') vi.spyOn(preview, 'open').mockImplementation(async (req) => req.spec);
  return { vm: TestBed.inject(SdlcHomeViewModel), preview, transport, lock, runAgent, runSteps, navigate, saveWorkspaces, saveSettings, runner: TestBed.inject(SdlcRunner) };
}

const previewReady = (preview: RunPreviewViewModel) => vi.waitFor(() => expect(preview.isOpen() && !preview.busy()).toBe(true));

const scanOf = (over: Partial<WorkspaceScan>): WorkspaceScan => ({
  folder: NEW_FOLDER,
  repos: ['claims-intent', 'customer-portal'],
  master: { kind: 'one', repo: 'claims-intent', committed: true },
  marker: { version: 1, systems: { claims: { repos: ['customer-portal'] } } },
  marker_error: null,
  ...over,
});
const specOf = (runAgent: { mock: { calls: unknown[][] } }, n = 0) => runAgent.mock.calls[n][1] as RunSpec;

afterEach(() => toastState.reset());

describe('SdlcHomeViewModel init', () => {
  it('opens the last-used workspace with its changes, branches and context health', async () => {
    const { vm } = setup();
    await vm.init();
    expect(vm.current()?.name).toBe('acme-claims');
    expect(vm.state()).toBe('ready');
    expect(vm.changes().length).toBe(5);
    expect(vm.branches()?.others).toEqual(['2026-10-17-claim-notes']);
    expect(vm.masterBranch()).toBe('main');
    expect(vm.contexts()['customer-portal']).toEqual({ kind: 'stale', commits: 14 });
    expect(vm.pluginMissing()).toBe(false);
  });

  it('opens the workspace with the newest last_opened when several exist', async () => {
    const { vm, transport } = setup();
    vi.spyOn(transport, 'sdlcWorkspaces').mockResolvedValue([
      { id: 'old', name: 'old', folder: '/old', base_branch: 'main', last_opened: 5 },
      { id: 'new', name: 'new', folder: '/new', base_branch: 'main', last_opened: 50 },
    ]);
    await vm.init();
    expect(vm.current()?.id).toBe('new');
  });

  it('is blocked, with every workspace action withheld, when the catalog has no ai-sdlc plugin', async () => {
    const { vm } = setup({ catalogHasPlugin: false });
    await vm.init();
    expect(vm.pluginMissing()).toBe(true);
    expect(vm.state()).toBe('plugin-missing');
    expect(vm.canWork()).toBe(false);
  });

  it('asks for a first workspace when there are none', async () => {
    const { vm, transport } = setup();
    vi.spyOn(transport, 'sdlcWorkspaces').mockResolvedValue([]);
    vi.spyOn(transport, 'catalog').mockResolvedValue([...seedCatalog, { kind: 'plugin', name: 'ai-sdlc', description: '', source: 'user', path: '', provides: [], mcp_servers: [] }]);
    await vm.init();
    expect(vm.state()).toBe('no-workspaces');
    expect(vm.canWork()).toBe(false);
  });

  it('reports a workspace folder that cannot be read, and flags it in the switcher', async () => {
    const { vm, transport } = setup();
    vi.spyOn(transport, 'sdlcScan').mockRejectedValue('no such folder');
    await vm.init();
    expect(vm.state()).toBe('folder-missing');
    expect(vm.scanError()).toContain('no such folder');
    expect(vm.missing()).toEqual(['acme-claims']);
  });

  it('reports a workspace without a master repo', async () => {
    const { vm, transport } = setup();
    vi.spyOn(transport, 'sdlcScan').mockResolvedValue(scanOf({ master: { kind: 'none' }, marker: null }));
    await vm.init();
    expect(vm.state()).toBe('master-gone');
  });

  it('lists every master when more than one repo holds the marker', async () => {
    const { vm, transport } = setup();
    vi.spyOn(transport, 'sdlcScan').mockResolvedValue(scanOf({ master: { kind: 'many', repos: ['a-intent', 'b-intent'] } }));
    await vm.init();
    expect(vm.state()).toBe('many-masters');
    expect(vm.masters()).toEqual(['a-intent', 'b-intent']);
  });

  it('reports a master whose marker is not committed as not set up', async () => {
    const { vm, transport } = setup();
    vi.spyOn(transport, 'sdlcScan').mockResolvedValue(scanOf({ master: { kind: 'one', repo: 'claims-intent', committed: false } }));
    await vm.init();
    expect(vm.state()).toBe('not-set-up');
  });

  it('shows the last run time per change from the run links', async () => {
    const { vm, transport } = setup();
    await transport.sdlcLinkRun({ workspace_id: 'acme-claims', system: 'claims', change: '2026-10-12-fnol-photo-upload', stage: 'spec', run_id: 'r', started_at: 1792281600 });
    await vm.init();
    expect(vm.lastRuns()['claims/2026-10-12-fnol-photo-upload']).toBe(1792281600);
  });
});

describe('SdlcHomeViewModel add workspace', () => {
  it('on a set-up workspace runs the five checks, saves the entry on confirm with the default base branch, and starts no run', async () => {
    const { vm, transport, runSteps, runAgent, saveWorkspaces } = setup();
    vi.spyOn(transport, 'pickDirectory').mockResolvedValue(NEW_FOLDER);
    await vm.init();
    await vm.addWorkspace();
    expect(runSteps.mock.calls[0][0]).toBe('Checking workspace');
    expect(runSteps.mock.calls[0][1].map((s) => s.label)).toEqual([
      'Scan folder for repos', 'Find master repo', 'Read .ai-sdlc.json', 'Check context staleness', 'List changes',
    ]);
    expect(runAgent).not.toHaveBeenCalled();
    expect(vm.candidate()?.folder).toBe(NEW_FOLDER);
    expect(saveWorkspaces).not.toHaveBeenCalled();

    await vm.confirmAddWorkspace();
    const saved = saveWorkspaces.mock.calls[0][0];
    expect(saved.find((w) => w.folder === NEW_FOLDER)).toMatchObject({ name: 'new-ws', base_branch: 'main' });
    expect(vm.current()?.folder).toBe(NEW_FOLDER);
    expect(vm.candidate()).toBeNull();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('on a workspace that is not set up starts exactly one run named sdlc-setup, then offers the workspace', async () => {
    const { vm, transport, runAgent } = setup();
    vi.spyOn(transport, 'pickDirectory').mockResolvedValue(NEW_FOLDER);
    await vm.init();
    const scan = vi.spyOn(transport, 'sdlcScan');
    scan.mockResolvedValueOnce(scanOf({ master: { kind: 'none' }, marker: null }));
    await vm.addWorkspace();
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(specOf(runAgent).name).toBe('sdlc-setup');
    expect(runAgent.mock.calls[0][0]).toBe('Running setup');
    expect(vm.candidate()?.folder).toBe(NEW_FOLDER);
  });

  it('opens the leftover dialog and adds nothing when setup is cancelled', async () => {
    const { vm, transport, runAgent, saveWorkspaces } = setup();
    vi.spyOn(transport, 'pickDirectory').mockResolvedValue(NEW_FOLDER);
    vi.spyOn(transport, 'sdlcLeftovers').mockResolvedValue({ new_commits: [], discardable: ['.ai-sdlc.json'], touched_dirty: [], created: [], product_repos_changed: [], product_repos_unchecked: [] });
    runAgent.mockResolvedValue('warning');
    await vm.init();
    vi.spyOn(transport, 'sdlcScan').mockResolvedValueOnce(
      scanOf({ master: { kind: 'one', repo: 'claims-intent', committed: false }, marker: null }),
    );
    await vm.addWorkspace();
    expect(vm.leftovers()?.[0].data.discardable).toEqual(['.ai-sdlc.json']);
    expect(vm.candidate()).toBeNull();
    expect(saveWorkspaces).not.toHaveBeenCalled();
  });

  it('reports leftovers in the master a cancelled first setup created, against its pre-run snapshot', async () => {
    const { vm, transport, runAgent } = setup();
    vi.spyOn(transport, 'pickDirectory').mockResolvedValue(NEW_FOLDER);
    runAgent.mockResolvedValue('warning');
    await vm.init();
    const snap = vi.spyOn(transport, 'sdlcSnapshot');
    const left = vi.spyOn(transport, 'sdlcLeftovers').mockResolvedValue({
      new_commits: [], discardable: ['.ai-sdlc.json'], touched_dirty: [], created: [], product_repos_changed: [], product_repos_unchecked: [],
    });
    vi.spyOn(transport, 'sdlcScan')
      .mockResolvedValueOnce(scanOf({ master: { kind: 'none' }, marker: null }))
      .mockResolvedValueOnce(scanOf({ master: { kind: 'one', repo: 'claims-intent', committed: false }, marker: null }));
    await vm.addWorkspace();
    expect(snap.mock.calls.map((c) => c[0])).toEqual([`${NEW_FOLDER}/claims-intent`, `${NEW_FOLDER}/customer-portal`]);
    expect(left).toHaveBeenCalledWith(`${NEW_FOLDER}/claims-intent`, expect.anything(), [`${NEW_FOLDER}/customer-portal`]);
    expect(vm.leftovers()?.[0].data.discardable).toEqual(['.ai-sdlc.json']);
    expect(vm.candidate()).toBeNull();
  });

  it('says so when the workspace check is cancelled, and adds nothing', async () => {
    const { vm, transport, lock, saveWorkspaces } = setup();
    vi.spyOn(transport, 'pickDirectory').mockResolvedValue(NEW_FOLDER);
    await vm.init();
    vi.spyOn(lock, 'runSteps').mockResolvedValue('cancelled');
    await vm.addWorkspace();
    expect(toastText()).toContain('Workspace check cancelled. Nothing was added.');
    expect(vm.candidate()).toBeNull();
    expect(saveWorkspaces).not.toHaveBeenCalled();
  });

  it('reports a failed context read after setup instead of rejecting', async () => {
    const { vm, transport } = setup();
    vi.spyOn(transport, 'pickDirectory').mockResolvedValue(NEW_FOLDER);
    await vm.init();
    vi.spyOn(transport, 'sdlcScan').mockResolvedValueOnce(scanOf({ master: { kind: 'none' }, marker: null }));
    vi.spyOn(transport, 'sdlcContextHealth').mockRejectedValue('git exploded');
    await expect(vm.addWorkspace()).resolves.toBeUndefined();
    expect(toastText()).toContain('git exploded');
    expect(vm.candidate()).toBeNull();
  });

  it('explains a folder with no repos instead of running anything', async () => {
    const { vm, transport, runAgent } = setup();
    vi.spyOn(transport, 'pickDirectory').mockResolvedValue(NEW_FOLDER);
    await vm.init();
    vi.spyOn(transport, 'sdlcScan').mockResolvedValueOnce(scanOf({ repos: [], master: { kind: 'none' }, marker: null }));
    await vm.addWorkspace();
    expect(runAgent).not.toHaveBeenCalled();
    expect(vm.candidate()?.scan.repos).toEqual([]);
  });

  it('lists the markers instead of running setup when two repos hold one', async () => {
    const { vm, transport, runAgent } = setup();
    vi.spyOn(transport, 'pickDirectory').mockResolvedValue(NEW_FOLDER);
    await vm.init();
    vi.spyOn(transport, 'sdlcScan').mockResolvedValueOnce(scanOf({ master: { kind: 'many', repos: ['a', 'b'] } }));
    await vm.addWorkspace();
    expect(runAgent).not.toHaveBeenCalled();
    expect(vm.candidate()?.scan.master).toEqual({ kind: 'many', repos: ['a', 'b'] });
  });

  it('does nothing when the folder picker is dismissed', async () => {
    const { vm, runSteps } = setup();
    await vm.init();
    await vm.addWorkspace();
    expect(runSteps).not.toHaveBeenCalled();
    expect(vm.candidate()).toBeNull();
  });

  it('selects the existing entry instead of adding a folder that is already listed', async () => {
    const { vm, transport, runSteps } = setup();
    vi.spyOn(transport, 'pickDirectory').mockResolvedValue(MOCK_WORKSPACE_FOLDER);
    await vm.init();
    await vm.addWorkspace();
    expect(runSteps).not.toHaveBeenCalled();
    expect(toastText()).toContain('already in the list');
  });

  it('treats a listed folder as already listed despite slashes, a trailing separator and case', async () => {
    const { vm, transport, runSteps } = setup();
    vi.spyOn(transport, 'sdlcWorkspaces').mockResolvedValue([
      { id: 'acme-claims', name: 'acme-claims', folder: 'D:\\Work\\acme-claims\\', base_branch: 'main', last_opened: 1 },
    ]);
    vi.spyOn(transport, 'pickDirectory').mockResolvedValue('d:/work/acme-claims');
    await vm.init();
    await vm.addWorkspace();
    expect(runSteps).not.toHaveBeenCalled();
    expect(toastText()).toContain('already in the list');
  });

  it('drops the candidate on cancel', async () => {
    const { vm, transport } = setup();
    vi.spyOn(transport, 'pickDirectory').mockResolvedValue(NEW_FOLDER);
    await vm.init();
    await vm.addWorkspace();
    vm.cancelAddWorkspace();
    expect(vm.candidate()).toBeNull();
  });
});

describe('SdlcHomeViewModel runs', () => {
  it('runContext starts a run named for the repo system and refreshes afterwards', async () => {
    const { vm, runAgent, transport } = setup();
    await vm.init();
    const health = vi.spyOn(transport, 'sdlcContextHealth');
    await vm.runContext('customer-portal');
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(specOf(runAgent).name).toBe('sdlc-claims-context');
    expect(specOf(runAgent).task).toContain('customer-portal');
    expect(health).toHaveBeenCalled();
  });

  it('setup and a context run open the preview first; cancel starts nothing', async () => {
    const { vm, runAgent, preview, transport } = setup({ preview: 'real' });
    await vm.init();
    const link = vi.spyOn(transport, 'sdlcLinkRun');
    for (const start of [() => vm.addSystem(), () => vm.runContext('customer-portal')]) {
      const run = start();
      await previewReady(preview);
      expect(runAgent).not.toHaveBeenCalled();
      preview.cancel();
      await run;
      expect(runAgent).not.toHaveBeenCalled();
    }
    expect(link).not.toHaveBeenCalled();
    expect(TestBed.inject(LockStore).active()).toBeNull();

    const confirmed = vm.runContext('customer-portal');
    await previewReady(preview);
    preview.start();
    await confirmed;
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(specOf(runAgent).name).toBe('sdlc-claims-context');
  });

  it('first-time setup of a new folder opens the preview first; cancel starts nothing', async () => {
    const { vm, transport, runAgent, preview } = setup({ preview: 'real' });
    vi.spyOn(transport, 'pickDirectory').mockResolvedValue(NEW_FOLDER);
    await vm.init();
    vi.spyOn(transport, 'sdlcScan').mockResolvedValueOnce(scanOf({ master: { kind: 'none' }, marker: null }));
    const added = vm.addWorkspace();
    await previewReady(preview);
    expect(runAgent).not.toHaveBeenCalled();
    preview.cancel();
    await added;
    expect(runAgent).not.toHaveBeenCalled();
    expect(vm.candidate()).toBeNull();
  });

  it('a new change previews in the AI-SDLC mode before any branch is made', async () => {
    const { vm, preview, transport } = setup({ preview: 'real' });
    const open = vi.spyOn(preview, 'open');
    const start = vi.spyOn(transport, 'sdlcStartChange');
    await vm.init();
    const run = vm.newChange('claims', 'flag fraud');
    await previewReady(preview);
    expect(open.mock.calls[0][0]).toMatchObject({ mode: 'sdlc' });
    expect(start).not.toHaveBeenCalled();
    preview.cancel();
    await run;
    expect(start).not.toHaveBeenCalled();
  });

  it('addSystem reruns setup in the workspace', async () => {
    const { vm, runAgent } = setup();
    await vm.init();
    await vm.addSystem();
    expect(specOf(runAgent).name).toBe('sdlc-setup');
    expect(specOf(runAgent).workdir).toBe(MOCK_WORKSPACE_FOLDER);
  });

  it('asks to switch to the base branch first, and only then runs', async () => {
    const { vm, transport, runAgent } = setup();
    await vm.init();
    vi.spyOn(transport, 'sdlcBranches').mockResolvedValue({ current: 'change/2026-10-12-x', others: [], default_base: 'main' });
    const checkout = vi.spyOn(transport, 'sdlcCheckout');
    const done = vm.runContext('customer-portal');
    await flush();
    expect(vm.switchPrompt()).toBe(`Switch ${MOCK_MASTER} to main first?`);
    expect(runAgent).not.toHaveBeenCalled();
    vm.answerSwitch(true);
    await done;
    expect(checkout).toHaveBeenCalledWith(`${MOCK_WORKSPACE_FOLDER}/${MOCK_MASTER}`, 'main');
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(vm.switchPrompt()).toBeNull();
  });

  it('runs nothing when the switch is declined', async () => {
    const { vm, transport, runAgent } = setup();
    await vm.init();
    vi.spyOn(transport, 'sdlcBranches').mockResolvedValue({ current: 'change/2026-10-12-x', others: [], default_base: 'main' });
    const checkout = vi.spyOn(transport, 'sdlcCheckout');
    const done = vm.runContext('customer-portal');
    await flush();
    vm.answerSwitch(false);
    await done;
    expect(checkout).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('shows git message and runs nothing when the switch is refused', async () => {
    const { vm, transport, runAgent } = setup();
    await vm.init();
    vi.spyOn(transport, 'sdlcBranches').mockResolvedValue({ current: 'change/2026-10-12-x', others: [], default_base: 'main' });
    vi.spyOn(transport, 'sdlcCheckout').mockRejectedValue('the master repo has uncommitted changes: a.md');
    const done = vm.runContext('customer-portal');
    await flush();
    vm.answerSwitch(true);
    await done;
    expect(toastText()).toContain('uncommitted changes: a.md');
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('aborts with an error and runs nothing when the branch cannot be read', async () => {
    const { vm, transport, runAgent } = setup();
    await vm.init();
    vi.spyOn(transport, 'sdlcBranches').mockRejectedValue('not a git repository');
    await vm.runContext('customer-portal');
    expect(toastText()).toContain('not a git repository');
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('aborts context with an error when the master repo is not on a branch', async () => {
    const { vm, transport, runAgent } = setup();
    await vm.init();
    vi.spyOn(transport, 'sdlcBranches').mockResolvedValue({ current: null, others: [], default_base: 'main' });
    await vm.runContext('customer-portal');
    expect(toastText()).toContain(`${MOCK_MASTER} is not on a branch`);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('aborts setup with an error when the master repo is not on a branch', async () => {
    const { vm, transport, runAgent } = setup();
    await vm.init();
    vi.spyOn(transport, 'sdlcBranches').mockResolvedValue({ current: null, others: [], default_base: 'main' });
    await vm.addSystem();
    expect(toastText()).toContain('is not on a branch');
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('refuses a second task while one holds the lock', async () => {
    const { vm, lock, runAgent } = setup();
    await vm.init();
    const hold = lock.runSteps('Busy', [{ label: 'x', run: () => new Promise<null>(() => undefined) }]);
    void hold;
    await flush();
    await vm.runContext('customer-portal');
    expect(runAgent).not.toHaveBeenCalled();
    expect(toastText()).toContain('already running');
  });

  it('newChange delegates to the runner with the workspace, master and system', async () => {
    const { vm, runner } = setup();
    await vm.init();
    const spy = vi.spyOn(runner, 'newChange').mockResolvedValue();
    await vm.newChange('claims', 'flag fraud');
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: expect.objectContaining({ id: 'acme-claims' }), master: `${MOCK_WORKSPACE_FOLDER}/${MOCK_MASTER}` }),
      'claims',
      'flag fraud',
      expect.any(Function),
    );
    expect(vm.newChangeOpen()).toBe(false);
  });

  it('shows leftovers from the runner and discards through it', async () => {
    const { vm, runner, transport } = setup();
    await vm.init();
    vi.spyOn(transport, 'sdlcLeftovers').mockResolvedValue({ new_commits: [], discardable: ['a.md'], touched_dirty: [], created: [], product_repos_changed: [], product_repos_unchecked: [] });
    const discard = vi.spyOn(transport, 'sdlcDiscard');
    vi.spyOn(TestBed.inject(LockStore), 'runAgent').mockResolvedValue('error');
    await vm.runContext('customer-portal');
    expect(vm.leftovers()?.[0].data.discardable).toEqual(['a.md']);
    await vm.discardLeftovers([{ repo: vm.leftovers()![0].repo, paths: ['a.md'] }]);
    expect(discard).toHaveBeenCalled();
    expect(vm.leftovers()).toBeNull();
    expect(runner.leftovers()).toBeNull();
  });
});

describe('SdlcHomeViewModel navigation', () => {
  it('openChange navigates to the change page', async () => {
    const { vm, navigate } = setup();
    await vm.init();
    await vm.openChange('claims', '2026-10-12-fnol-photo-upload');
    expect(navigate).toHaveBeenCalledWith(['/sdlc', 'claims', '2026-10-12-fnol-photo-upload']);
  });

  it('openOtherBranch checks the branch out, then opens the change found there', async () => {
    const { vm, transport, navigate } = setup();
    await vm.init();
    const checkout = vi.spyOn(transport, 'sdlcCheckout');
    vi.spyOn(transport, 'sdlcChanges').mockResolvedValue([
      { system: 'claims', change: '2026-10-17-claim-notes', intent: { exists: true, committed: true, status: 'draft' }, spec: { exists: false, committed: false, status: null }, plan: { exists: false, committed: false, status: null }, stage: 'intent-awaiting', build: { tasks: 0, finished: 0, repos: 0 }, scope: 'claims', out_of_date: null, plan_unreadable: false, plan_unreadable_reason: null },
    ]);
    await vm.openOtherBranch('2026-10-17-claim-notes');
    expect(checkout).toHaveBeenCalledWith(`${MOCK_WORKSPACE_FOLDER}/${MOCK_MASTER}`, 'change/2026-10-17-claim-notes');
    expect(navigate).toHaveBeenCalledWith(['/sdlc', 'claims', '2026-10-17-claim-notes']);
  });

  it('openOtherBranch shows git message on a dirty refusal and stays put', async () => {
    const { vm, transport, navigate } = setup();
    await vm.init();
    vi.spyOn(transport, 'sdlcCheckout').mockRejectedValue('the master repo has uncommitted changes: notes.md');
    await vm.openOtherBranch('2026-10-17-claim-notes');
    expect(toastText()).toContain('the master repo has uncommitted changes: notes.md');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('switchMode goes back to the workbench', async () => {
    const { vm, navigate } = setup();
    await vm.init();
    await vm.switchMode();
    expect(navigate).toHaveBeenCalledWith(['/']);
  });
});

describe('SdlcHomeViewModel workspaces and settings', () => {
  it('selectWorkspace stamps last_opened and loads that workspace', async () => {
    const { vm, transport, saveWorkspaces } = setup();
    await vm.init();
    vi.spyOn(transport, 'sdlcWorkspaces').mockResolvedValue([]);
    vm.workspaces.set([
      ...vm.workspaces(),
      { id: 'second', name: 'second', folder: '/second', base_branch: 'main', last_opened: 1 },
    ]);
    await vm.selectWorkspace('second');
    expect(vm.current()?.id).toBe('second');
    const saved = saveWorkspaces.mock.calls.at(-1)![0];
    expect(saved.find((w) => w.id === 'second')!.last_opened).toBeGreaterThan(1);
  });

  it('removing asks first, forgets only the list entry, and moves to the next workspace', async () => {
    const { vm, saveWorkspaces } = setup();
    await vm.init();
    vm.askRemove();
    expect(vm.removePrompt()).toContain('acme-claims');
    expect(saveWorkspaces).not.toHaveBeenCalled();
    await vm.confirmRemove();
    expect(saveWorkspaces).toHaveBeenCalledWith([]);
    expect(vm.workspaces()).toEqual([]);
    expect(vm.current()).toBeNull();
    expect(vm.removePrompt()).toBeNull();
  });

  it('declining the removal keeps the workspace', async () => {
    const { vm, saveWorkspaces } = setup();
    await vm.init();
    vm.askRemove();
    vm.cancelRemove();
    expect(vm.removePrompt()).toBeNull();
    expect(saveWorkspaces).not.toHaveBeenCalled();
  });

  it('saving the settings dialog with prompt persists permission_mode prompt', async () => {
    const { vm, saveSettings, transport } = setup();
    await vm.init();
    vm.openSettings();
    await vm.saveSettings({ settings: { ...vm.settings()!, permission_mode: 'prompt' }, baseBranch: 'main' });
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ permission_mode: 'prompt' }));
    expect((await transport.sdlcSettings()).permission_mode).toBe('prompt');
    expect(vm.settingsOpen()).toBe(false);
  });

  it('saving a different base branch updates the workspace entry', async () => {
    const { vm, saveWorkspaces } = setup();
    await vm.init();
    await vm.saveSettings({ settings: vm.settings()!, baseBranch: 'develop' });
    expect(saveWorkspaces).toHaveBeenCalledWith([expect.objectContaining({ id: 'acme-claims', base_branch: 'develop' })]);
    expect(vm.current()?.base_branch).toBe('develop');
  });

  it('does not rewrite the workspaces when the base branch is unchanged', async () => {
    const { vm, saveWorkspaces } = setup();
    await vm.init();
    await vm.saveSettings({ settings: vm.settings()!, baseBranch: 'main' });
    expect(saveWorkspaces).not.toHaveBeenCalled();
  });
});

describe("SdlcHomeViewModel plan notice (F20)", () => {
  const noticeOf = (vm: SdlcHomeViewModel) => vm.listNotice();
  const withUnreadablePlan = (transport: MockTransport) => {
    const real = transport.sdlcChanges.bind(transport);
    vi.spyOn(transport, "sdlcChanges").mockImplementation(async (master, system) => {
      const list = await real(master, system);
      return list.map((c, i) => (i === 0 ? { ...c, stage: "plan-unreadable" as never, plan_unreadable: true } : c));
    });
  };

  it("says to install the plugin on the change list when a plan could not be read and the plugin is missing", async () => {
    const { vm, transport } = setup();
    withUnreadablePlan(transport);
    vi.spyOn(transport, "sdlcPluginReadiness").mockResolvedValue({ kind: "missing" });
    await vm.init();
    expect(noticeOf(vm)?.text).toBe("Install the ai-sdlc plugin to read this document");
    expect(noticeOf(vm)?.tone).toBe("warning");
  });

  it("says to update the plugin when it is too old", async () => {
    const { vm, transport } = setup();
    withUnreadablePlan(transport);
    vi.spyOn(transport, "sdlcPluginReadiness").mockResolvedValue({ kind: "tooOld", have: "0.6.0", need: "0.9.0" });
    await vm.init();
    expect(noticeOf(vm)?.text).toBe("Update the ai-sdlc plugin to 0.9.0 or later");
  });

  it("says a plan could not be read when the plugin is usable but the program did not run", async () => {
    const { vm, transport } = setup();
    withUnreadablePlan(transport);
    await vm.init();
    expect(noticeOf(vm)?.text).toContain("could not be read");
  });

  it("shows the program's own cause on the change list instead of blaming Node.js (F26)", async () => {
    const { vm, transport } = setup();
    const real = transport.sdlcChanges.bind(transport);
    vi.spyOn(transport, "sdlcChanges").mockImplementation(async (master, system) => {
      const list = await real(master, system);
      return list.map((c, i) => (i === 0 ? ({ ...c, stage: "plan-unreadable", plan_unreadable: true, plan_unreadable_reason: "layout 3 is newer than this program reads" } as never) : c));
    });
    await vm.init();
    expect(noticeOf(vm)?.text).toContain("layout 3 is newer than this program reads");
    expect(noticeOf(vm)?.text).not.toContain("Node.js 20");
  });

  it("shows no notice when every plan was read", async () => {
    const { vm } = setup();
    await vm.init();
    expect(noticeOf(vm)).toBeNull();
  });
});
