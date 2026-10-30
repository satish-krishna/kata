import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import type { ChangeInfo } from '@bindings/ChangeInfo';
import type { ChangeName } from '@bindings/ChangeName';
import type { Readiness } from '@bindings/Readiness';
import type { StageEvent } from '@bindings/StageEvent';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import type { RunSpec } from '@bindings/RunSpec';
import type { WorkspaceScan } from '@bindings/WorkspaceScan';
import { toastState } from '@spartan-ng/brain/sonner';
import { LockStore } from '../../core/lock/lock.store';
import { ProgressStore } from '../../core/progress/progress.store';
import { PROGRESS_STEPS } from '../../lib/progress-steps';
import { SdlcRunner } from '../../core/sdlc/sdlc-runner';
import { RunPreviewViewModel } from '../../core/given/run-preview.view-model';
import { KataTransport } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import { readAllChanges } from '../../../testing/read-all';
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
  instantPass(transport);
  return { vm: TestBed.inject(SdlcHomeViewModel), preview, transport, lock, runAgent, runSteps, navigate, saveWorkspaces, saveSettings, runner: TestBed.inject(SdlcRunner) };
}

const previewReady = (preview: RunPreviewViewModel) => vi.waitFor(() => expect(preview.isOpen() && !preview.busy()).toBe(true));

const scanOf = (over: Partial<WorkspaceScan>): WorkspaceScan => ({
  folder: NEW_FOLDER,
  repos: ['commerce-docs', 'customer-portal'],
  master: { kind: 'one', repo: 'commerce-docs', committed: true },
  marker: { version: 1, systems: { commerce: { repos: ['customer-portal'] } } },
  marker_error: null,
  ...over,
});
const specOf = (runAgent: { mock: { calls: unknown[][] } }, n = 0) => runAgent.mock.calls[n][1] as RunSpec;

afterEach(() => toastState.reset());

describe('SdlcHomeViewModel init', () => {
  it('opens the last-used workspace with its changes, branches and context health', async () => {
    const { vm } = setup();
    await vm.init();
    expect(vm.current()?.name).toBe('acme-commerce');
    expect(vm.state()).toBe('ready');
    await settled(vm);
    expect(vm.changes().length).toBe(7);
    expect(vm.branches()?.others.map((o) => o.change)).toEqual(['2026-10-17-product-notes']);
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
    expect(vm.missing()).toEqual(['acme-commerce']);
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
    vi.spyOn(transport, 'sdlcScan').mockResolvedValue(scanOf({ master: { kind: 'one', repo: 'commerce-docs', committed: false } }));
    await vm.init();
    expect(vm.state()).toBe('not-set-up');
  });

  it('shows the last run time per change from the run links', async () => {
    const { vm, transport } = setup();
    await transport.sdlcLinkRun({ workspace_id: 'acme-commerce', system: 'commerce', change: '2026-10-12-product-photo-upload', stage: 'spec', run_id: 'r', started_at: 1792281600 });
    await vm.init();
    expect(vm.lastRuns()['commerce/2026-10-12-product-photo-upload']).toBe(1792281600);
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
      scanOf({ master: { kind: 'one', repo: 'commerce-docs', committed: false }, marker: null }),
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
      .mockResolvedValueOnce(scanOf({ master: { kind: 'one', repo: 'commerce-docs', committed: false }, marker: null }));
    await vm.addWorkspace();
    expect(snap.mock.calls.map((c) => c[0])).toEqual([`${NEW_FOLDER}/commerce-docs`, `${NEW_FOLDER}/customer-portal`]);
    expect(left).toHaveBeenCalledWith(`${NEW_FOLDER}/commerce-docs`, expect.anything(), [`${NEW_FOLDER}/customer-portal`]);
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
      { id: 'acme-commerce', name: 'acme-commerce', folder: 'D:\\Work\\acme-commerce\\', base_branch: 'main', last_opened: 1 },
    ]);
    vi.spyOn(transport, 'pickDirectory').mockResolvedValue('d:/work/acme-commerce');
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
    expect(specOf(runAgent).name).toBe('sdlc-commerce-context');
    expect(specOf(runAgent).task).toContain('customer-portal');
    expect(health).toHaveBeenCalled();
  });

  it('openContext goes to the context screen of the repo, under its system', async () => {
    const { vm, navigate } = setup();
    await vm.init();
    await vm.openContext('customer-portal');
    expect(navigate).toHaveBeenCalledWith(['/sdlc', 'commerce', 'context', 'customer-portal']);
  });

  it('a context run handed over by the context screen starts once the workspace is read, after the address drops it', async () => {
    const { vm, runAgent, navigate } = setup();
    await vm.init(null, 'customer-portal');
    expect(navigate).toHaveBeenCalledWith(['/sdlc'], { replaceUrl: true });
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(specOf(runAgent).name).toBe('sdlc-commerce-context');
    expect(specOf(runAgent).task).toContain('customer-portal');
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
    expect(specOf(runAgent).name).toBe('sdlc-commerce-context');
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
    const run = vm.newChange('commerce', 'flag prices', 'full');
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

  it('newChange delegates to the runner with the workspace, master, system and track', async () => {
    const { vm, runner } = setup();
    await vm.init();
    const spy = vi.spyOn(runner, 'newChange').mockResolvedValue({ kind: 'opened', change: '2026-10-18-new-change', branch: 'change/2026-10-18-new-change' });
    await vm.newChange('commerce', 'flag prices', 'decide');
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: expect.objectContaining({ id: 'acme-commerce' }), master: `${MOCK_WORKSPACE_FOLDER}/${MOCK_MASTER}` }),
      'commerce',
      'flag prices',
      'decide',
      expect.any(Function),
    );
    expect(vm.newChangeOpen()).toBe(false);
  });

  describe('a triage that created no change', () => {
    const none = { kind: 'none', idea: 'flag prices', runId: 'sdlc-commerce-triage-1' } as const;

    it('shows the notice, and describing again reopens the dialog on the idea and the decide track', async () => {
      const { vm, runner } = setup();
      await vm.init();
      vi.spyOn(runner, 'newChange').mockResolvedValue(none);
      await vm.newChange('commerce', 'flag prices', 'decide');
      expect(vm.triageNotice()).toEqual({ idea: 'flag prices', runId: 'sdlc-commerce-triage-1' });
      vm.describeAgain();
      expect(vm.newChangeOpen()).toBe(true);
      expect(vm.newChangeIdea()).toBe('flag prices');
      expect(vm.newChangeTrack()).toBe('decide');
    });

    it('opens the run in the library', async () => {
      const { vm, runner, navigate } = setup();
      await vm.init();
      vi.spyOn(runner, 'newChange').mockResolvedValue(none);
      await vm.newChange('commerce', 'flag prices', 'decide');
      await vm.openRun();
      expect(navigate).toHaveBeenCalledWith(['/library'], { queryParams: { run: 'sdlc-commerce-triage-1' } });
    });

    it('shows no notice when the full pipeline made no change', async () => {
      const { vm, runner } = setup();
      await vm.init();
      vi.spyOn(runner, 'newChange').mockResolvedValue(none);
      await vm.newChange('commerce', 'flag prices', 'full');
      expect(vm.triageNotice()).toBeNull();
    });

    it('clears on the next new change', async () => {
      const { vm, runner } = setup();
      await vm.init();
      const spy = vi.spyOn(runner, 'newChange').mockResolvedValue(none);
      await vm.newChange('commerce', 'flag prices', 'decide');
      spy.mockResolvedValue({ kind: 'opened', change: '2026-10-18-new-change', branch: 'change/2026-10-18-new-change' });
      await vm.newChange('commerce', 'another', 'decide');
      expect(vm.triageNotice()).toBeNull();
    });

    it('clears on a workspace switch', async () => {
      const { vm, runner } = setup();
      await vm.init();
      vi.spyOn(runner, 'newChange').mockResolvedValue(none);
      await vm.newChange('commerce', 'flag prices', 'decide');
      await vm.selectWorkspace(vm.workspaces()[0].id);
      expect(vm.triageNotice()).toBeNull();
    });

    it('a fresh new change starts empty on the decide track', async () => {
      const { vm, runner } = setup();
      await vm.init();
      vi.spyOn(runner, 'newChange').mockResolvedValue(none);
      await vm.newChange('commerce', 'flag prices', 'decide');
      vm.describeAgain();
      vm.closeNewChange();
      vm.openNewChange();
      expect(vm.newChangeIdea()).toBe('');
    });
  });

  it('offers the light track only when the plugin reports it', async () => {
    const { vm, transport } = setup();
    vi.spyOn(transport, 'sdlcPluginReadiness').mockResolvedValue({ kind: 'ready', dir: '/p', version: '0.9.0', layouts: [1], lightTrack: false, naming: false });
    await vm.init();
    expect(vm.lightTrack()).toBe(false);
    vi.spyOn(transport, 'sdlcPluginReadiness').mockResolvedValue({ kind: 'ready', dir: '/p', version: '0.13.0', layouts: [1], lightTrack: true, naming: false });
    await vm.selectWorkspace(vm.workspaces()[0].id);
    expect(vm.lightTrack()).toBe(true);
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
    await vm.openChange('commerce', '2026-10-12-product-photo-upload');
    expect(navigate).toHaveBeenCalledWith(['/sdlc', 'commerce', '2026-10-12-product-photo-upload']);
  });

  it('openOtherBranch checks the branch out, then opens the change found there', async () => {
    const { vm, transport, navigate } = setup();
    await vm.init();
    const checkout = vi.spyOn(transport, 'sdlcCheckout');
    // After the checkout the change exists on the branch just checked out, so the reads can find it.
    const found = (await readAllChanges(transport))[0];
    vi.spyOn(transport, 'sdlcReadChange').mockResolvedValue({ ...found, change: '2026-10-17-product-notes' });
    vi.spyOn(transport, 'sdlcChangeNames').mockResolvedValue([{ change: '2026-10-17-product-notes', title: null }]);
    await vm.openOtherBranch('2026-10-17-product-notes');
    expect(checkout).toHaveBeenCalledWith(`${MOCK_WORKSPACE_FOLDER}/${MOCK_MASTER}`, 'change/2026-10-17-product-notes');
    expect(navigate).toHaveBeenCalledWith(['/sdlc', 'commerce', '2026-10-17-product-notes']);
  });

  it('openOtherBranch shows git message on a dirty refusal and stays put', async () => {
    const { vm, transport, navigate } = setup();
    await vm.init();
    vi.spyOn(transport, 'sdlcCheckout').mockRejectedValue('the master repo has uncommitted changes: notes.md');
    await vm.openOtherBranch('2026-10-17-product-notes');
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
    expect(vm.removePrompt()).toContain('acme-commerce');
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
    expect(saveWorkspaces).toHaveBeenCalledWith([expect.objectContaining({ id: 'acme-commerce', base_branch: 'develop' })]);
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
  /** The first change reads as the callback makes it; the others read as they are. */
  const alterFirst = (transport: MockTransport, change: (c: ChangeInfo) => ChangeInfo) => {
    const real = transport.sdlcReadChange.bind(transport);
    vi.spyOn(transport, "sdlcReadChange").mockImplementation(async (master, system, name) => {
      const [first] = await transport.sdlcChangeNames(master, system);
      const info = await real(master, system, name);
      return name === first.change ? change(info) : info;
    });
  };
  const withUnreadablePlan = (transport: MockTransport) => alterFirst(transport, (c) => ({ ...c, stage: "plan-unreadable" as never, plan_unreadable: true }));

  it("says to install the plugin on the change list when a plan could not be read and the plugin is missing", async () => {
    const { vm, transport } = setup();
    withUnreadablePlan(transport);
    vi.spyOn(transport, "sdlcPluginReadiness").mockResolvedValue({ kind: "missing" });
    await vm.init();
    await settled(vm);
    expect(noticeOf(vm)?.text).toBe("Install the ai-sdlc plugin to read this document");
    expect(noticeOf(vm)?.tone).toBe("warning");
  });

  it("says to update the plugin when it is too old", async () => {
    const { vm, transport } = setup();
    withUnreadablePlan(transport);
    vi.spyOn(transport, "sdlcPluginReadiness").mockResolvedValue({ kind: "tooOld", have: "0.6.0", need: "0.9.0" });
    await vm.init();
    await settled(vm);
    expect(noticeOf(vm)?.text).toBe("Update the ai-sdlc plugin to 0.9.0 or later");
  });

  it("says a plan could not be read when the plugin is usable but the program did not run", async () => {
    const { vm, transport } = setup();
    withUnreadablePlan(transport);
    await vm.init();
    await settled(vm);
    expect(noticeOf(vm)?.text).toContain("could not be read");
  });

  it("shows the program's own cause on the change list instead of blaming Node.js (F26)", async () => {
    const { vm, transport } = setup();
    alterFirst(transport, (c) => ({ ...c, stage: "plan-unreadable", plan_unreadable: true, plan_unreadable_reason: "layout 3 is newer than this program reads" }) as never);
    await vm.init();
    await settled(vm);
    expect(noticeOf(vm)?.text).toContain("layout 3 is newer than this program reads");
    expect(noticeOf(vm)?.text).not.toContain("Node.js 20");
  });

  const withFix = (transport: MockTransport, over: Record<string, unknown>) => {
    alterFirst(transport, (c) => ({ ...c, track: "fix", plan_unreadable: true, ...over }) as never);
  };

  it("shows a fix's needs-the-plugin reason as it is, without the document prefix (F5)", async () => {
    const { vm, transport } = setup();
    withFix(transport, { stage: "fix-needs-plugin", fix_row: null, plan_unreadable_reason: "Needs ai-sdlc 0.13.0 or later." });
    await vm.init();
    await settled(vm);
    expect(noticeOf(vm)?.text).toBe("Needs ai-sdlc 0.13.0 or later.");
  });

  it("names the change when the program could not say where a fix stands (F5)", async () => {
    const { vm, transport } = setup();
    withFix(transport, { stage: "fix-unsettled", fix_row: null, plan_unreadable_reason: "git failed" });
    await vm.init();
    await settled(vm);
    const name = vm.changes()[0].change;
    expect(noticeOf(vm)?.text).toBe(`Kata could not read where ${name} stands: git failed`);
  });

  it("keeps the document prefix for a row 2 fix whose plan is unreadable (F5)", async () => {
    const { vm, transport } = setup();
    withFix(transport, { stage: "fix-unsettled", fix_row: 2, plan_unreadable_reason: "front matter is not closed" });
    await vm.init();
    await settled(vm);
    expect(noticeOf(vm)?.text).toBe("Could not read this document: front matter is not closed");
  });

  it("shows no notice when every plan was read", async () => {
    const { vm } = setup();
    await vm.init();
    await settled(vm);
    expect(noticeOf(vm)).toBeNull();
  });
});

describe('SdlcHomeViewModel workspace instructions', () => {
  const lightReady: Readiness = { kind: 'ready', dir: '/p', version: '0.13.0', layouts: [1], lightTrack: true, naming: false };

  it('reads the instructions state only when the plugin supports the light track', async () => {
    const { vm, transport } = setup();
    const read = vi.spyOn(transport, 'sdlcInstructions');
    vi.spyOn(transport, 'sdlcPluginReadiness').mockResolvedValue({ ...lightReady, version: '0.9.0', lightTrack: false });
    await vm.init();
    expect(read).not.toHaveBeenCalled();
    expect(vm.instructions()).toBeNull();
    vi.spyOn(transport, 'sdlcPluginReadiness').mockResolvedValue(lightReady);
    await vm.selectWorkspace(vm.workspaces()[0].id);
    expect(read).toHaveBeenCalledTimes(1);
    expect(vm.instructions()).toBe('out-of-date');
  });

  it('refreshes through one setup task after the base-branch check, and reads current afterwards', async () => {
    const { vm, transport, runAgent } = setup();
    vi.spyOn(transport, 'sdlcPluginReadiness').mockResolvedValue(lightReady);
    const mock = transport as unknown as { sdlc: { finishSetup(withInstructions: boolean): void } };
    runAgent.mockImplementation(async (_title: string, spec: RunSpec) => {
      mock.sdlc.finishSetup(spec.task.includes('--instructions'));
      return 'success';
    });
    const branches = vi.spyOn(transport, 'sdlcBranches');
    await vm.init();
    branches.mockClear();
    await vm.refreshInstructions();
    expect(branches).toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(specOf(runAgent).name).toBe('sdlc-setup');
    expect(specOf(runAgent).task).toBe('Use the ai-sdlc setup skill with --instructions.');
    expect(vm.instructions()).toBe('current');
  });

  it('refuses while another task runs', async () => {
    const { vm, transport, lock, runAgent } = setup();
    vi.spyOn(transport, 'sdlcPluginReadiness').mockResolvedValue(lightReady);
    await vm.init();
    void lock.runSteps('Busy', [{ label: 'x', run: () => new Promise<null>(() => undefined) }]);
    await flush();
    await vm.refreshInstructions();
    expect(runAgent).not.toHaveBeenCalled();
    expect(toastText()).toContain('already running');
  });
});


/* --- the home page in two passes: names first, stages after --- */

/** A pass the test drives by hand: `send` plays the events the backend would send, `id()` is the latest pass id handed out. */
function controlledPass(transport: MockTransport) {
  const listeners = new Set<(e: StageEvent) => void>();
  let last = 0;
  vi.spyOn(transport, 'onStageEvent').mockImplementation(async (cb) => {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  });
  const reads = vi.spyOn(transport, 'sdlcReadStages').mockImplementation(async () => ++last);
  const next = () => ++last;
  const send = (ev: StageEvent) => {
    for (const l of [...listeners]) l(ev);
  };
  const finish = (pass: number, infos: ChangeInfo[] = []) => {
    infos.forEach((info, i) => {
      send({ kind: 'stage', pass, change: info.change, info });
      send({ kind: 'progress', pass, read: i + 1, total: infos.length });
    });
    send({ kind: 'done', pass });
  };
  return { reads, send, finish, next, id: () => last };
}

/** A pass that answers by itself with every stage `sdlcReadChange` gives, for the tests that are not about the pass. */
function instantPass(transport: MockTransport) {
  const pass = controlledPass(transport);
  pass.reads.mockImplementation(async (master, system) => {
    const id = pass.next();
    setTimeout(() => void readAllChanges(transport, master, system).then((infos) => pass.finish(id, infos)), 0);
    return id;
  });
}

/** The stage pass has ended: every stage the mock reads is in. */
const settled = (vm: SdlcHomeViewModel) => vi.waitFor(() => expect(vm.reading()).toBe(false));

const twelve = (): ChangeName[] => Array.from({ length: 12 }, (_, i) => ({ change: `2026-10-${String(10 + i).padStart(2, '0')}-change-${i}`, title: null }));
const infoFor = async (transport: MockTransport, change: string, stage: ChangeInfo['stage']): Promise<ChangeInfo> => {
  const found = (await readAllChanges(transport))[0];
  return { ...found, change, stage };
};
const stageOf = (vm: SdlcHomeViewModel, change: string) => vm.rows().find((r) => r.change === change);
const flushAll = async () => {
  for (let i = 0; i < 5; i++) await flush();
};
const second: WorkspaceEntry = { id: 'second', name: 'second', folder: '/second', base_branch: 'main', last_opened: 1 };

describe('SdlcHomeViewModel stage passes', () => {
  afterEach(() => vi.useRealTimers());

  it('shows the change names before any stage, each reading (R1.1)', async () => {
    const { vm, transport } = setup();
    vi.spyOn(transport, 'sdlcChangeNames').mockResolvedValue(twelve());
    const pass = controlledPass(transport);
    await vm.init();
    expect(vm.state()).toBe('ready');
    expect(vm.rows().map((r) => r.change)).toEqual(twelve().map((n) => n.change));
    expect(vm.rows().every((r) => r.info === null && r.error === null)).toBe(true);
    expect(pass.reads).toHaveBeenCalledTimes(1);
    expect(vm.reading()).toBe(true);
  });

  it('reads the context health after the names, not before the page shows (R1.1)', async () => {
    const { vm, transport } = setup();
    const names = vi.spyOn(transport, 'sdlcChangeNames');
    const health = vi.spyOn(transport, 'sdlcContextHealth');
    const instructions = vi.spyOn(transport, 'sdlcInstructions');
    vi.spyOn(transport, 'sdlcPluginReadiness').mockResolvedValue({ kind: 'ready', dir: '/p', version: '0.13.0', layouts: [1], lightTrack: true, naming: false });
    controlledPass(transport);
    await vm.init();
    expect(health).toHaveBeenCalled();
    expect(names.mock.invocationCallOrder[0]).toBeLessThan(health.mock.invocationCallOrder[0]);
    expect(names.mock.invocationCallOrder[0]).toBeLessThan(instructions.mock.invocationCallOrder[0]);
  });

  it('opens a change and starts a new change while stages are still read (R1.2)', async () => {
    const { vm, transport, navigate, runner } = setup();
    controlledPass(transport);
    const start = vi.spyOn(runner, 'newChange').mockResolvedValue({ kind: 'opened', change: '2026-10-30-new', branch: 'change/2026-10-30-new' });
    await vm.init();
    expect(vm.reading()).toBe(true);
    await vm.openChange('commerce', '2026-10-12-product-photo-upload');
    expect(navigate).toHaveBeenCalledWith(['/sdlc', 'commerce', '2026-10-12-product-photo-upload']);
    await vm.newChange('commerce', 'flag prices', 'full');
    expect(start).toHaveBeenCalledTimes(1);
    expect(vm.reading()).toBe(true);
  });

  it('says how many of the changes are read, and drops the line after the last (R2.1)', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const { vm, transport } = setup();
    vi.spyOn(transport, 'sdlcChangeNames').mockResolvedValue(twelve());
    const pass = controlledPass(transport);
    const line = TestBed.inject(ProgressStore).view('home');
    await vm.init();
    vi.advanceTimersByTime(500);
    expect(line()?.label).toBe('0 of 12 changes read');
    pass.send({ kind: 'progress', pass: pass.id(), read: 5, total: 12 });
    expect(line()?.label).toBe('5 of 12 changes read');
    pass.send({ kind: 'progress', pass: pass.id(), read: 12, total: 12 });
    pass.send({ kind: 'done', pass: pass.id() });
    await vi.waitFor(() => expect(line()).toBeNull());
    expect(vm.reading()).toBe(false);
  });

  it('shows the reading-stages progress line (R7.1)', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const { vm, transport } = setup();
    const pass = controlledPass(transport);
    const line = TestBed.inject(ProgressStore).view('home');
    await vm.init();
    expect(line()).toBeNull();
    vi.advanceTimersByTime(500);
    expect(PROGRESS_STEPS['reading-stages'].lines).toContain(line()!.line);
    expect(line()!.label).toMatch(/^0 of \d+ changes read$/);
    pass.send({ kind: 'done', pass: pass.id() });
    await vi.waitFor(() => expect(line()).toBeNull());
  });

  it('never shows a stage from before this session (R2.3)', async () => {
    const first = setup();
    const before = controlledPass(first.transport);
    await first.vm.init();
    const c = first.vm.rows()[0].change;
    before.finish(before.id(), [await infoFor(first.transport, c, 'plan-ready')]);
    expect(stageOf(first.vm, c)?.info?.stage).toBe('plan-ready');

    TestBed.resetTestingModule();
    const next = setup();
    const after = controlledPass(next.transport);
    await next.vm.init();
    expect(stageOf(next.vm, c)).toMatchObject({ info: null, error: null });
    after.finish(after.id(), [await infoFor(next.transport, c, 'plan-awaiting')]);
    expect(stageOf(next.vm, c)?.info?.stage).toBe('plan-awaiting');
  });

  it('reads only the current workspace; the switcher has no counts (R3.1)', async () => {
    const { vm, transport } = setup();
    const three: WorkspaceEntry[] = [
      { id: 'a', name: 'a', folder: '/a', base_branch: 'main', last_opened: 30 },
      { id: 'b', name: 'b', folder: '/b', base_branch: 'main', last_opened: 20 },
      { id: 'c', name: 'c', folder: '/c', base_branch: 'main', last_opened: 10 },
    ];
    vi.spyOn(transport, 'sdlcWorkspaces').mockResolvedValue(three);
    const missing = vi.spyOn(transport, 'sdlcMissingFolders').mockResolvedValue(['/c']);
    const scan = vi.spyOn(transport, 'sdlcScan');
    const names = vi.spyOn(transport, 'sdlcChangeNames');
    const pass = controlledPass(transport);
    await vm.init();
    expect(scan.mock.calls.map((c) => c[0])).toEqual(['/a']);
    expect(names.mock.calls.every((c) => c[0].startsWith('/a/'))).toBe(true);
    expect(pass.reads.mock.calls.every((c) => c[0].startsWith('/a/'))).toBe(true);
    expect(missing).toHaveBeenCalledWith(['/a', '/b', '/c']);
    expect(vm.missing()).toEqual(['c']);
    expect('counts' in vm).toBe(false);
  });

  it('picking a workspace runs both passes for it, and the pass before reports nothing more (R3.2)', async () => {
    const { vm, transport } = setup();
    const names = vi.spyOn(transport, 'sdlcChangeNames');
    const pass = controlledPass(transport);
    await vm.init();
    const old = pass.id();
    const c = vm.rows()[0].change;
    vm.workspaces.set([...vm.workspaces(), second]);
    await vm.selectWorkspace('second');
    expect(names.mock.calls.at(-1)![0].startsWith('/second/')).toBe(true);
    expect(pass.reads.mock.calls.at(-1)![0].startsWith('/second/')).toBe(true);
    expect(pass.id()).toBeGreaterThan(old);
    pass.send({ kind: 'stage', pass: old, change: c, info: await infoFor(transport, c, 'plan-ready') });
    expect(stageOf(vm, c)?.info).toBeNull();
    pass.finish(pass.id(), [await infoFor(transport, c, 'plan-awaiting')]);
    expect(stageOf(vm, c)?.info?.stage).toBe('plan-awaiting');
    await settled(vm);
  });

  describe('marks rows as checked and reads again on each trigger (R5.1)', () => {
    const C = '2026-10-12-product-photo-upload';
    type Over = ReturnType<typeof setup>;
    type Case = { event: string; before: ChangeInfo['stage']; after: ChangeInfo['stage']; first: string | null; again: (vm: SdlcHomeViewModel, over: Over) => Promise<SdlcHomeViewModel> };
    const reopened = () => TestBed.runInInjectionContext(() => new SdlcHomeViewModel());
    const cases: Case[] = [
      {
        event: 'a document run for change C ends', before: 'intent-awaiting', after: 'intent-accepted-uncommitted', first: C,
        again: async (vm, { runner }) => {
          vi.spyOn(runner, 'newChange').mockResolvedValue({ kind: 'opened', change: C, branch: `change/${C}` });
          await vm.newChange('commerce', 'idea', 'full');
          return vm;
        },
      },
      { event: 'a build run for change C ends and the page is reopened', before: 'build-stopped', after: 'build-finished', first: null, again: async () => reopened() },
      { event: 'the engineer returns to the home page from change C', before: 'spec-accepted-uncommitted', after: 'plan-ready', first: null, again: async () => reopened() },
      { event: 'the Workbench window regains focus after an outside edit', before: 'plan-accepted-uncommitted', after: 'plan-superseded', first: null, again: async (vm) => { vm.windowFocused(); return vm; } },
    ];

    it.each(cases)('$event', async (c) => {
      const over = setup();
      const { vm, transport } = over;
      const pass = controlledPass(transport);
      await vm.init();
      pass.finish(pass.id(), [await infoFor(transport, C, c.before)]);
      expect(stageOf(vm, C)).toMatchObject({ checking: false });
      expect(stageOf(vm, C)?.info?.stage).toBe(c.before);

      const reads = pass.reads.mock.calls.length;
      const shown = await c.again(vm, over);
      if (shown !== vm) await shown.init();
      await vi.waitFor(() => expect(pass.reads.mock.calls.length).toBe(reads + 1));
      expect(pass.reads.mock.calls.at(-1)![2] ?? null).toBe(c.first);
      expect(stageOf(shown, C)).toMatchObject({ checking: true });
      expect(stageOf(shown, C)?.info?.stage).toBe(c.before);

      pass.finish(pass.id(), [await infoFor(transport, C, c.after)]);
      expect(stageOf(shown, C)).toMatchObject({ checking: false });
      expect(stageOf(shown, C)?.info?.stage).toBe(c.after);
    });

    it('trigger table row 1: nothing running, nothing queued, a trigger starts a pass now', async () => {
      const { vm, transport } = setup();
      const pass = controlledPass(transport);
      await vm.init();
      pass.finish(pass.id());
      vm.windowFocused();
      await vi.waitFor(() => expect(pass.reads).toHaveBeenCalledTimes(2));
    });

    it('trigger table row 2: a pass running, a trigger queues one pass that starts when the running one ends', async () => {
      const { vm, transport } = setup();
      const pass = controlledPass(transport);
      await vm.init();
      vm.windowFocused();
      await flushAll();
      expect(pass.reads).toHaveBeenCalledTimes(1);
      pass.finish(pass.id());
      await vi.waitFor(() => expect(pass.reads).toHaveBeenCalledTimes(2));
    });

    it('trigger table row 3: a pass running and one queued, more triggers add nothing', async () => {
      const { vm, transport } = setup();
      const pass = controlledPass(transport);
      await vm.init();
      vm.windowFocused();
      vm.windowFocused();
      vm.windowFocused();
      pass.finish(pass.id());
      await vi.waitFor(() => expect(pass.reads).toHaveBeenCalledTimes(2));
      pass.finish(pass.id());
      await flushAll();
      expect(pass.reads).toHaveBeenCalledTimes(2);
    });
  });

  it('follows the row display table', async () => {
    const { vm, transport } = setup();
    const pass = controlledPass(transport);
    await vm.init();
    const c = vm.rows()[0].change;
    // Row 1: no value from this session, a pass running: Reading in place of the stage.
    expect(stageOf(vm, c)).toMatchObject({ info: null, error: null, checking: false });
    expect(vm.reading()).toBe(true);
    // Row 3: a value, no pass running: the stored stage.
    pass.finish(pass.id(), [await infoFor(transport, c, 'plan-ready')]);
    expect(stageOf(vm, c)).toMatchObject({ checking: false });
    expect(stageOf(vm, c)?.info?.stage).toBe('plan-ready');
    await settled(vm);
    // Row 2: a value, a pass running that has not sent this row yet: the stored stage, marked as being checked.
    vm.windowFocused();
    await vi.waitFor(() => expect(stageOf(vm, c)?.checking).toBe(true));
    expect(stageOf(vm, c)?.info?.stage).toBe('plan-ready');
    expect(vm.reading()).toBe(true);
    // Row 4 (no value and no pass) cannot happen: a name enters the rows only from a names read, and every names read starts a pass.
  });

  it('shows a change that could not be read with its reason, and goes on with the others', async () => {
    const { vm, transport } = setup();
    const pass = controlledPass(transport);
    await vm.init();
    const [a, b] = vm.rows().map((r) => r.change);
    pass.send({ kind: 'failed', pass: pass.id(), change: a, error: 'worker panicked' });
    pass.finish(pass.id(), [await infoFor(transport, b, 'plan-ready')]);
    expect(stageOf(vm, a)).toMatchObject({ info: null, error: 'worker panicked' });
    expect(stageOf(vm, b)?.info?.stage).toBe('plan-ready');
  });
});
