import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import type { ChangeState } from '@bindings/ChangeState';
import type { ChangeView } from '@bindings/ChangeView';
import type { SystemView } from '@bindings/SystemView';
import type { WorkspaceView } from '@bindings/WorkspaceView';
import type { Readiness } from '@bindings/Readiness';
import type { HomeList } from '@bindings/HomeList';
import type { HomeOpen } from '@bindings/HomeOpen';
import type { HomeRow } from '@bindings/HomeRow';
import type { HomeChecked } from '@bindings/HomeChecked';
import type { HomeAction } from '@bindings/HomeAction';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import type { RunSpec } from '@bindings/RunSpec';
import type { WorkspaceScan } from '@bindings/WorkspaceScan';
import { toastState } from '@spartan-ng/brain/sonner';
import { ProgressStore } from '../../core/progress/progress.store';
import { PROGRESS_STEPS } from '../../lib/progress-steps';
import { LockStore } from '../../core/lock/lock.store';
import { ChangeRunStore, changeRunKey } from '../../core/run/change-run.store';
import { RunStore } from '../../core/run/run.store';
import { VersionsStore } from '../../core/versions/versions.store';
import { SdlcRunner } from '../../core/sdlc/sdlc-runner';
import { RunPreviewViewModel } from '../../core/given/run-preview.view-model';
import { KataTransport, type NamingState } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import { MOCK_WORKSPACE_FOLDER, MOCK_MASTER } from '../../lib/sdlc-mock';
import { seedCatalog, seedSpec } from '../../lib/mock';
import { documentForm } from '../../lib/build-host';
import { SdlcHomeViewModel } from './sdlc-home.view-model';

const NEW_FOLDER = 'D:/Work/new-ws';
const toastText = () => toastState.toasts().map((t) => String(t.title)).join(' | ');
const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
  TestBed.tick();
};

/** `preview: 'confirm'` (the default) lets the preview confirm every run at once, so a test about something else never meets it; `'real'` leaves it to the test. */
function setup(over: { catalogHasPlugin?: boolean; preview?: 'confirm' | 'real'; home?: 'legacy' | 'listed' } = {}) {
  const transport = new MockTransport();
  // The tests that spy on `sdlcState` are about the legacy list; the open-changes home has its own describe.
  if (over.home !== 'listed') vi.spyOn(transport, 'sdlcHomeList').mockResolvedValue({ kind: 'legacy' });
  if (over.catalogHasPlugin === false) vi.spyOn(transport, 'catalog').mockResolvedValue(seedCatalog);
  TestBed.configureTestingModule({
    providers: [SdlcHomeViewModel, RunPreviewViewModel, { provide: KataTransport, useValue: transport }, provideRouter([])],
  });
  const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  const lock = TestBed.inject(LockStore);
  const runAgent = vi.spyOn(lock, 'runAgent').mockResolvedValue('success');
  const runSteps = vi.spyOn(lock, 'runSteps');
  const openWorkspace = vi.spyOn(transport, 'sdlcOpenWorkspace');
  const addWorkspace = vi.spyOn(transport, 'sdlcAddWorkspace');
  const removeWorkspace = vi.spyOn(transport, 'sdlcRemoveWorkspace');
  const saveSettings = vi.spyOn(transport, 'sdlcSaveSettings');
  const preview = TestBed.inject(RunPreviewViewModel);
  if (over.preview !== 'real') vi.spyOn(preview, 'open').mockImplementation(async (req) => req.spec);
  return { vm: TestBed.inject(SdlcHomeViewModel), preview, transport, lock, runAgent, runSteps, navigate, openWorkspace, addWorkspace, removeWorkspace, saveSettings, runner: TestBed.inject(SdlcRunner) };
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
    expect(vm.rows().length).toBe(7);
    expect(vm.branches()?.others.map((o) => o.change)).toEqual(['2026-10-17-product-notes']);
    expect(vm.masterBranch()).toBe('main');
    expect(vm.contexts()['customer-portal']).toEqual({ kind: 'stale', commits: 14 });
    expect(vm.pluginMissing()).toBe(false);
  });

  it('opens the workspace with the newest last_opened when several exist', async () => {
    const { vm, transport } = setup();
    vi.spyOn(transport, 'sdlcWorkspaces').mockResolvedValue([
      { id: 'old', name: 'old', folder: '/old', last_opened: 5 },
      { id: 'new', name: 'new', folder: '/new', last_opened: 50 },
    ]);
    vi.spyOn(transport, 'sdlcCurrentWorkspace').mockResolvedValue('new');
    await vm.init();
    expect(vm.current()?.id).toBe('new');
  });

  it('opens the workspace the backend names as current, even on a tie a TS sort would break the other way', async () => {
    const { vm, transport } = setup();
    vi.spyOn(transport, 'sdlcWorkspaces').mockResolvedValue([
      { id: 'first', name: 'first', folder: '/first', last_opened: 0 },
      { id: 'last', name: 'last', folder: '/last', last_opened: 0 },
    ]);
    const ask = vi.spyOn(transport, 'sdlcCurrentWorkspace').mockResolvedValue('last');
    await vm.init();
    expect(ask).toHaveBeenCalled();
    expect(vm.current()?.id).toBe('last');
  });

  it('removing the current workspace moves to what the backend answers', async () => {
    const { vm, transport, removeWorkspace } = setup();
    const list: WorkspaceEntry[] = [
      { id: 'a', name: 'a', folder: '/a', last_opened: 0 },
      { id: 'b', name: 'b', folder: '/b', last_opened: 0 },
      { id: 'c', name: 'c', folder: '/c', last_opened: 0 },
    ];
    vi.spyOn(transport, 'sdlcWorkspaces').mockResolvedValue(list);
    vi.spyOn(transport, 'sdlcCurrentWorkspace').mockResolvedValue('a');
    await vm.init();
    expect(vm.current()?.id).toBe('a');
    removeWorkspace.mockResolvedValue({ workspaces: [list[1], list[2]], current: 'c' });
    await vm.removeWorkspace('a');
    expect(removeWorkspace).toHaveBeenCalledWith('a');
    expect(vm.workspaces().map((w) => w.id)).toEqual(['b', 'c']);
    expect(vm.current()?.id).toBe('c');
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
  it('on a set-up workspace runs the five checks, saves the entry on confirm with no base branch, and starts no run', async () => {
    const { vm, transport, runSteps, runAgent, addWorkspace } = setup();
    vi.spyOn(transport, 'pickDirectory').mockResolvedValue(NEW_FOLDER);
    await vm.init();
    await vm.addWorkspace();
    expect(runSteps.mock.calls[0][0]).toBe('Checking workspace');
    expect(runSteps.mock.calls[0][1].map((s) => s.label)).toEqual([
      'Scan folder for repos', 'Find master repo', 'Read .ai-sdlc.json', 'Check context staleness', 'List changes',
    ]);
    expect(runAgent).not.toHaveBeenCalled();
    expect(vm.candidate()?.folder).toBe(NEW_FOLDER);
    expect(addWorkspace).not.toHaveBeenCalled();

    await vm.confirmAddWorkspace();
    expect(addWorkspace).toHaveBeenCalledWith('new-ws', NEW_FOLDER);
    expect(vm.workspaces().find((w) => w.folder === NEW_FOLDER)).toMatchObject({ name: 'new-ws' });
    expect(vm.workspaces().find((w) => w.folder === NEW_FOLDER)).not.toHaveProperty('base_branch');
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
    const { vm, transport, runAgent, addWorkspace } = setup();
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
    expect(addWorkspace).not.toHaveBeenCalled();
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
    expect(snap.mock.calls.map((c) => c[0])).toEqual([
      { kind: 'workspace', master: `${NEW_FOLDER}/commerce-docs` },
      { kind: 'workspace', master: `${NEW_FOLDER}/customer-portal` },
    ]);
    expect(left).toHaveBeenCalledWith({ kind: 'workspace', master: `${NEW_FOLDER}/commerce-docs` }, expect.anything());
    expect(vm.leftovers()?.[0].data.discardable).toEqual(['.ai-sdlc.json']);
    expect(vm.candidate()).toBeNull();
  });

  it('says so when the workspace check is cancelled, and adds nothing', async () => {
    const { vm, transport, lock, addWorkspace } = setup();
    vi.spyOn(transport, 'pickDirectory').mockResolvedValue(NEW_FOLDER);
    await vm.init();
    vi.spyOn(lock, 'runSteps').mockResolvedValue('cancelled');
    await vm.addWorkspace();
    expect(toastText()).toContain('Workspace check cancelled. Nothing was added.');
    expect(vm.candidate()).toBeNull();
    expect(addWorkspace).not.toHaveBeenCalled();
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
      { id: 'acme-commerce', name: 'acme-commerce', folder: 'D:\\Work\\acme-commerce\\', last_opened: 1 },
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

  it('switches to the base the backend resolves, not a stored one', async () => {
    const { vm, transport } = setup();
    await vm.init();
    vi.spyOn(transport, 'sdlcBranches').mockResolvedValue({ current: 'change/2026-10-12-x', others: [], default_base: 'develop' });
    const done = vm.runContext('customer-portal');
    await flush();
    expect(vm.switchPrompt()).toBe(`Switch ${MOCK_MASTER} to develop first?`);
    vm.answerSwitch(false);
    await done;
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

  it('offers the light track only when the plugin is ready', async () => {
    const { vm, transport } = setup();
    vi.spyOn(transport, 'sdlcPluginReadiness').mockResolvedValue({ kind: 'blocked', reason: 'pluginTooOld', message: 'The AI-SDLC mode needs ai-sdlc 1.1.0 or later; this machine has 0.9.0.' });
    await vm.init();
    expect(vm.lightTrack()).toBe(false);
    vi.spyOn(transport, 'sdlcPluginReadiness').mockResolvedValue({ kind: 'ready', plugin: { dir: '/p', version: '1.1.0', layouts: [1] }, gh: 'present' });
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
    // After the checkout the change exists on the branch just checked out, so the plugin's answer lists it.
    vi.spyOn(transport, 'sdlcState').mockResolvedValue(oneSystem({ ...systemViewOf(0), changes: [viewOf('2026-10-17-product-notes', 'Intent · awaiting acceptance', READY)] }));
    await vm.openOtherBranch('2026-10-17-product-notes');
    expect(checkout).toHaveBeenCalledWith(`${MOCK_WORKSPACE_FOLDER}/${MOCK_MASTER}`, 'change/2026-10-17-product-notes');
    expect(navigate).toHaveBeenCalledWith(['/sdlc', 'commerce', '2026-10-17-product-notes']);
  });

  it('checks out the branch the list read, which a record may name other than change/<change>', async () => {
    const { vm, transport } = setup();
    vi.spyOn(transport, 'sdlcBranches').mockResolvedValue({
      current: 'main',
      default_base: 'main',
      others: [
        { branch: 'feat/PROJ-123-password-reset', change: '2026-11-02-password-reset' },
        { branch: 'change/2026-10-17-product-notes', change: '2026-10-17-product-notes' },
      ],
    });
    await vm.init();
    expect(vm.otherBranches()).toEqual(['2026-11-02-password-reset', '2026-10-17-product-notes']);
    const checkout = vi.spyOn(transport, 'sdlcCheckout');
    await vm.openOtherBranch('2026-11-02-password-reset');
    expect(checkout).toHaveBeenCalledWith(`${MOCK_WORKSPACE_FOLDER}/${MOCK_MASTER}`, 'feat/PROJ-123-password-reset');
  });

  it('openOtherBranch is refused while a change works in the master checkout, and the toast names that change (F5)', async () => {
    const { vm, transport, navigate } = setup();
    await vm.init();
    // A change started before copies existed: its spec run works in the master checkout itself.
    await transport.sdlcRunChange({ workspace: MOCK_WORKSPACE_FOLDER, system: 'commerce', change: '2026-10-12-product-photo-upload' }, 'spec', documentForm(seedSpec()));
    await vm.openOtherBranch('2026-10-17-product-notes');
    expect(toastText()).toContain('The change 2026-10-12-product-photo-upload has a run working in');
    expect(navigate).not.toHaveBeenCalled();
    // The branch the run works on is still checked out.
    expect((await transport.sdlcBranches(`${MOCK_WORKSPACE_FOLDER}/${MOCK_MASTER}`)).current).not.toBe('change/2026-10-17-product-notes');
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
  it('selecting a workspace asks the backend and never writes last_opened', async () => {
    const { vm, transport, openWorkspace } = setup();
    await vm.init();
    const first = vm.workspaces()[0];
    const second = { id: 'second', name: 'second', folder: '/second', last_opened: 1 };
    vm.workspaces.set([first, second]);
    const appVersions = vi.spyOn(transport, 'appVersions');
    openWorkspace.mockResolvedValue({ workspaces: [first, { ...second, last_opened: 99 }], current: 'second' });
    await vm.selectWorkspace('second');
    expect(openWorkspace).toHaveBeenCalledWith('second');
    expect(vm.current()?.id).toBe('second');
    expect(vm.workspaces().find((w) => w.id === 'second')!.last_opened).toBe(99);
    expect(appVersions).toHaveBeenCalledTimes(1);
  });

  it('a failed open keeps the shown workspace', async () => {
    const { vm, transport, openWorkspace } = setup();
    await vm.init();
    const before = vm.workspaces();
    vm.workspaces.set([...before, { id: 'second', name: 'second', folder: '/second', last_opened: 1 }]);
    const shown = vm.workspaces();
    const appVersions = vi.spyOn(transport, 'appVersions');
    openWorkspace.mockRejectedValue(new Error('disk full'));
    await vm.selectWorkspace('second');
    expect(vm.current()?.id).toBe(before[0].id);
    expect(vm.workspaces()).toBe(shown);
    expect(toastText()).toContain('Could not save the workspace list: disk full');
    expect(appVersions).not.toHaveBeenCalled();
  });

  it('a failed removal keeps the shown workspace', async () => {
    const { vm, transport, removeWorkspace } = setup();
    await vm.init();
    const shown = vm.workspaces();
    const current = vm.current()!.id;
    const appVersions = vi.spyOn(transport, 'appVersions');
    removeWorkspace.mockRejectedValue(new Error('disk full'));
    await vm.removeWorkspace(current);
    expect(vm.current()?.id).toBe(current);
    expect(vm.workspaces()).toBe(shown);
    expect(toastText()).toContain('Could not save the workspace list: disk full');
    expect(appVersions).not.toHaveBeenCalled();
  });

  it("adding a workspace takes the backend's id and current", async () => {
    const { vm, transport, addWorkspace } = setup();
    vi.spyOn(transport, 'pickDirectory').mockResolvedValue(NEW_FOLDER);
    await vm.init();
    const first = vm.workspaces()[0];
    const added = { id: 'backend-chose-this', name: 'new-ws', folder: NEW_FOLDER, last_opened: 77 };
    addWorkspace.mockResolvedValue({ workspaces: [first, added], current: added.id });
    await vm.addWorkspace();
    await vm.confirmAddWorkspace();
    expect(addWorkspace).toHaveBeenCalledWith('new-ws', NEW_FOLDER);
    expect(vm.workspaces()).toEqual([first, added]);
    expect(vm.current()?.id).toBe('backend-chose-this');
  });

  it('selectWorkspace asks for the versions again after the backend opened it, and the line shows the new answer', async () => {
    const { vm, transport, openWorkspace } = setup();
    await vm.init();
    const versions = TestBed.inject(VersionsStore);
    const answer = await transport.appVersions();
    const appVersions = vi.spyOn(transport, 'appVersions').mockResolvedValue({ ...answer, copy: 'second workspace' });
    const second = { id: 'second', name: 'second', folder: '/second', last_opened: 1 };
    vm.workspaces.set([...vm.workspaces(), second]);
    openWorkspace.mockResolvedValue({ workspaces: [...vm.workspaces()], current: 'second' });
    await vm.selectWorkspace('second');
    expect(appVersions).toHaveBeenCalledTimes(1);
    expect(appVersions.mock.invocationCallOrder[0]).toBeGreaterThan(openWorkspace.mock.invocationCallOrder.at(-1)!);
    expect(versions.versions()?.copy).toBe('second workspace');
  });

  it('adding a workspace asks for the versions again after the backend added it', async () => {
    const { vm, transport, addWorkspace } = setup();
    vi.spyOn(transport, 'pickDirectory').mockResolvedValue(NEW_FOLDER);
    await vm.init();
    const appVersions = vi.spyOn(transport, 'appVersions');
    await vm.addWorkspace();
    await vm.confirmAddWorkspace();
    expect(appVersions).toHaveBeenCalledTimes(1);
    expect(appVersions.mock.invocationCallOrder[0]).toBeGreaterThan(addWorkspace.mock.invocationCallOrder.at(-1)!);
  });

  it('removing the current workspace asks for the versions again; removing another does not', async () => {
    const { vm, transport } = setup();
    await vm.init();
    const second = (await transport.sdlcAddWorkspace('second', '/second')).workspaces.find((w) => w.id === 'second')!;
    await transport.sdlcOpenWorkspace('acme-commerce');
    vm.workspaces.set([...vm.workspaces(), second]);
    const appVersions = vi.spyOn(transport, 'appVersions');
    await vm.removeWorkspace('second');
    expect(appVersions).not.toHaveBeenCalled();
    await vm.removeWorkspace(vm.current()!.id);
    expect(appVersions).toHaveBeenCalledTimes(1);
  });

  it('removing asks first, forgets only the list entry, and moves to the next workspace', async () => {
    const { vm, removeWorkspace } = setup();
    await vm.init();
    vm.askRemove();
    expect(vm.removePrompt()).toContain('acme-commerce');
    expect(removeWorkspace).not.toHaveBeenCalled();
    await vm.confirmRemove();
    expect(removeWorkspace).toHaveBeenCalledWith('acme-commerce');
    expect(vm.workspaces()).toEqual([]);
    expect(vm.current()).toBeNull();
    expect(vm.removePrompt()).toBeNull();
  });

  it('declining the removal keeps the workspace', async () => {
    const { vm, removeWorkspace } = setup();
    await vm.init();
    vm.askRemove();
    vm.cancelRemove();
    expect(vm.removePrompt()).toBeNull();
    expect(removeWorkspace).not.toHaveBeenCalled();
  });

  it('saving the settings dialog with prompt persists permission_mode prompt', async () => {
    const { vm, saveSettings, transport } = setup();
    await vm.init();
    vm.openSettings();
    await vm.saveSettings({ settings: { ...vm.settings()!, permission_mode: 'prompt' } });
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ permission_mode: 'prompt' }));
    expect((await transport.sdlcSettings()).permission_mode).toBe('prompt');
    expect(vm.settingsOpen()).toBe(false);
  });

  it('never rewrites the workspaces when the settings are saved: the base branch is not stored', async () => {
    const { vm, openWorkspace, addWorkspace, removeWorkspace } = setup();
    await vm.init();
    await vm.saveSettings({ settings: vm.settings()! });
    for (const write of [openWorkspace, addWorkspace, removeWorkspace]) expect(write).not.toHaveBeenCalled();
    expect(vm.current()).not.toHaveProperty('base_branch', 'develop');
  });
});

describe('SdlcHomeViewModel plan notice (F20)', () => {
  const noticeOf = (vm: SdlcHomeViewModel) => vm.listNotice();
  /** The plugin's answer, with the first change's plan unreadable and the plugin's own reason, if it gave one. */
  const withUnreadablePlan = (transport: MockTransport, reason: string | null = null) => {
    const answer = systemViewOf(2, READY);
    answer.changes[0].offer = { ...answer.changes[0].offer, stage: 'plan-unreadable', label: { step: 'plan', text: 'Plan · could not be read', tone: 'warning' } };
    answer.problems = reason === null ? [] : [reason];
    vi.spyOn(transport, 'sdlcState').mockResolvedValue(oneSystem(answer));
  };

  it('says to install the plugin on the change list when a plan could not be read and the plugin is missing', async () => {
    const { vm, transport } = setup();
    withUnreadablePlan(transport);
    vi.spyOn(transport, 'sdlcPluginReadiness').mockResolvedValue({ kind: 'blocked', reason: 'pluginMissing', message: 'Install the ai-sdlc plugin' });
    await vm.init();
    expect(noticeOf(vm)?.text).toBe('Install the ai-sdlc plugin to read this document');
    expect(noticeOf(vm)?.tone).toBe('warning');
  });

  it('says to update the plugin when it is too old', async () => {
    const { vm, transport } = setup();
    withUnreadablePlan(transport);
    vi.spyOn(transport, 'sdlcPluginReadiness').mockResolvedValue({ kind: 'blocked', reason: 'pluginTooOld', message: 'The AI-SDLC mode needs ai-sdlc 1.1.0 or later; this machine has 0.6.0.' });
    await vm.init();
    expect(noticeOf(vm)?.text).toBe('The AI-SDLC mode needs ai-sdlc 1.1.0 or later; this machine has 0.6.0.');
  });

  it('says a plan could not be read when the plugin is usable but gave no reason', async () => {
    const { vm, transport } = setup();
    withUnreadablePlan(transport);
    await vm.init();
    expect(noticeOf(vm)?.text).toContain('could not be read');
  });

  it("shows the plugin's own reason on the change list instead of blaming Node.js (F26)", async () => {
    const { vm, transport } = setup();
    withUnreadablePlan(transport, 'layout 3 is newer than this program reads');
    await vm.init();
    expect(noticeOf(vm)?.text).toContain('layout 3 is newer than this program reads');
    expect(noticeOf(vm)?.text).not.toContain('Node.js 20');
  });

  it('shows no notice when every plan was read', async () => {
    const { vm } = setup();
    await vm.init();
    expect(noticeOf(vm)).toBeNull();
  });
});

describe('SdlcHomeViewModel workspace instructions', () => {
  const lightReady: Readiness = { kind: 'ready', plugin: { dir: '/p', version: '1.1.0', layouts: [1] }, gh: 'present' };

  it('reads the instructions state only when the plugin supports the light track', async () => {
    const { vm, transport } = setup();
    const read = vi.spyOn(transport, 'sdlcInstructions');
    vi.spyOn(transport, 'sdlcPluginReadiness').mockResolvedValue({ kind: 'blocked', reason: 'pluginTooOld', message: 'The AI-SDLC mode needs ai-sdlc 1.1.0 or later; this machine has 0.9.0.' });
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


/* --- R1.4: the changes list reads every change in one pass --- */

const gate = { candidate: false, stop: null, accept: [] };
const stateOf = (change: string): ChangeState => ({
  change,
  master: '/m',
  folder: `/m/intent/commerce/${change}`,
  inCopy: false,
  title: null,
  track: 'full',
  documents: {
    intent: { exists: true, inHead: true, headStatus: 'accepted', workingStatus: 'accepted', uncommitted: false, pin: null },
    spec: { exists: false, inHead: false, headStatus: null, workingStatus: null, uncommitted: false, pin: null },
    plan: { exists: false, inHead: false, headStatus: null, workingStatus: null, uncommitted: false, pin: null },
  },
  scenarios: null,
  tasks: null,
  buildLogs: {},
  review: { committed: 0, draft: 'none' },
  fix: null,
  ready: { spec: gate, plan: gate, build: gate, review: gate, done: gate, reject: gate },
});
const viewOf = (change: string, text: string, readiness: Readiness): ChangeView => ({
  state: stateOf(change),
  offer: { stage: 'spec-ready', label: { step: 'spec', text, tone: 'muted' }, actions: [] },
  live: { runLive: false, buildStopped: false, buildLive: false },
  readiness,
});
const READY: Readiness = { kind: 'ready', plugin: { dir: '/p', version: '1.1.0', layouts: [1, 2] }, gh: 'present' };
const BLOCKED: Readiness = { kind: 'blocked', reason: 'pluginTooOld', message: 'The AI-SDLC mode needs ai-sdlc 1.1.0 or later; this machine has 1.0.0.' };
/** The plugin's answer for a system with `n` changes, each labeled by the plugin with words of its own. */
const systemViewOf = (n: number, readiness: Readiness = READY): SystemView => ({
  system: 'commerce',
  readiness,
  canStartChange: readiness.kind === 'ready',
  startChangeReason: readiness.kind === 'blocked' ? readiness.message : null,
  changes: Array.from({ length: n }, (_, i) => viewOf(`2026-10-${String(10 + i).padStart(2, '0')}-change-${i}`, `The plugin says ${i}`, readiness)),
  problems: [],
});

/** The backend's answer for a workspace of one system: the set may start a change exactly when that system may. */
const oneSystem = (v: SystemView): WorkspaceView => ({ systems: [v], canStartChange: v.canStartChange, startChangeReason: v.startChangeReason });

const second: WorkspaceEntry = { id: 'second', name: 'second', folder: '/second', last_opened: 1 };

describe('SdlcHomeViewModel changes list', () => {
  it('names show at once and every stage fills in from one state read (R1.4)', async () => {
    const { vm, transport } = setup();
    const answer = systemViewOf(20);
    const read = vi.spyOn(transport, 'sdlcState').mockResolvedValue(oneSystem(answer));
    // The slow reads never finish: the names must be on screen without them.
    const health = vi.spyOn(transport, 'sdlcContextHealth').mockImplementation(() => new Promise(() => undefined));
    void vm.init();
    await vi.waitFor(() => expect(vm.rows().length).toBe(20));
    expect(health).toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
    expect(vm.rows().map((r) => r.change)).toEqual(answer.changes.map((c) => c.state.change));
    expect(vm.rows().map((r) => r.offer?.label.text)).toEqual(answer.changes.map((c) => c.offer.label.text));
  });

  it('a blocked readiness offers no new change (R10.1)', async () => {
    const { vm, transport } = setup();
    vi.spyOn(transport, 'sdlcState').mockResolvedValue(oneSystem(systemViewOf(2, BLOCKED)));
    await vm.init();
    await vi.waitFor(() => expect(vm.rows().length).toBe(2));
    expect(vm.canStartChange()).toBe(false);
    expect(vm.startChangeReason()).toBe(BLOCKED.message);
    vm.openNewChange();
    expect(vm.newChangeOpen()).toBe(false);
    expect(toastText()).toContain('1.1.0');
  });

  it('reads every system in one call and shows whether a change may start as the backend decided for the set (F11)', async () => {
    const { vm, transport } = setup();
    // Each system says it may, yet the backend refuses for the set: the page follows the backend, it merges nothing itself.
    const read = vi.spyOn(transport, 'sdlcState').mockResolvedValue({ systems: [systemViewOf(1), { ...systemViewOf(1), system: 'other' }], canStartChange: false, startChangeReason: 'other: refused' });
    await vm.init();
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0][1]).toEqual(['commerce']);
    expect(vm.canStartChange()).toBe(false);
    expect(vm.startChangeReason()).toBe('other: refused');
  });

  it('a ready readiness offers a new change (R10.1)', async () => {
    const { vm, transport } = setup();
    vi.spyOn(transport, 'sdlcState').mockResolvedValue(oneSystem(systemViewOf(1)));
    await vm.init();
    expect(vm.canStartChange()).toBe(true);
    expect(vm.startChangeReason()).toBeNull();
    vm.openNewChange();
    expect(vm.newChangeOpen()).toBe(true);
  });

  it('reads the context health and the instructions after the change list (R1.1)', async () => {
    const { vm, transport } = setup();
    const state = vi.spyOn(transport, 'sdlcState');
    const health = vi.spyOn(transport, 'sdlcContextHealth');
    const instructions = vi.spyOn(transport, 'sdlcInstructions');
    await vm.init();
    expect(health).toHaveBeenCalled();
    expect(instructions).toHaveBeenCalled();
    expect(state.mock.invocationCallOrder[0]).toBeLessThan(health.mock.invocationCallOrder[0]);
    expect(state.mock.invocationCallOrder[0]).toBeLessThan(instructions.mock.invocationCallOrder[0]);
  });

  it('opens a change and starts a new change while the slow reads are still going (R1.2)', async () => {
    const { vm, transport, navigate, runner } = setup();
    vi.spyOn(transport, 'sdlcContextHealth').mockImplementation(() => new Promise(() => undefined));
    const start = vi.spyOn(runner, 'newChange').mockResolvedValue({ kind: 'opened', change: '2026-10-30-new', branch: 'change/2026-10-30-new' });
    void vm.init();
    await vi.waitFor(() => expect(vm.rows().length).toBeGreaterThan(0));
    expect(vm.state()).toBe('ready');
    await vm.openChange('commerce', '2026-10-12-product-photo-upload');
    expect(navigate).toHaveBeenCalledWith(['/sdlc', 'commerce', '2026-10-12-product-photo-upload']);
    // The reload after the run waits for the slow reads, so the call is not awaited.
    void vm.newChange('commerce', 'flag prices', 'full');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('reads only the current workspace; the switcher has no counts (R3.1)', async () => {
    const { vm, transport } = setup();
    const three: WorkspaceEntry[] = [
      { id: 'a', name: 'a', folder: '/a', last_opened: 30 },
      { id: 'b', name: 'b', folder: '/b', last_opened: 20 },
      { id: 'c', name: 'c', folder: '/c', last_opened: 10 },
    ];
    vi.spyOn(transport, 'sdlcWorkspaces').mockResolvedValue(three);
    vi.spyOn(transport, 'sdlcCurrentWorkspace').mockResolvedValue('a');
    const missing = vi.spyOn(transport, 'sdlcMissingFolders').mockResolvedValue(['/c']);
    const scan = vi.spyOn(transport, 'sdlcScan');
    const state = vi.spyOn(transport, 'sdlcState');
    await vm.init();
    expect(scan.mock.calls.map((c) => c[0])).toEqual(['/a']);
    expect(state.mock.calls.every((c) => c[0] === '/a')).toBe(true);
    expect(missing).toHaveBeenCalledWith(['/a', '/b', '/c']);
    expect(vm.missing()).toEqual(['c']);
    expect('counts' in vm).toBe(false);
  });

  it('picking a workspace reads the state for it (R3.2)', async () => {
    const { vm, transport } = setup();
    const state = vi.spyOn(transport, 'sdlcState');
    await vm.init();
    vm.workspaces.set((await transport.sdlcAddWorkspace(second.name, second.folder)).workspaces);
    await vm.selectWorkspace('second');
    expect(state.mock.calls.at(-1)![0]).toBe('/second');
  });

  describe('progress while the plugin is asked', () => {
    afterEach(() => vi.useRealTimers());

    it('a slow state read shows a progress line naming the step', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
      const { vm, transport } = setup();
      const state = vi.spyOn(transport, 'sdlcState');
      const line = TestBed.inject(ProgressStore).view('home');
      await vm.init();
      expect(line()).toBeNull();
      let answer: (v: WorkspaceView) => void = () => undefined;
      state.mockImplementation(() => new Promise<WorkspaceView>((ok) => (answer = ok)));
      vm.windowFocused();
      vi.advanceTimersByTime(300);
      expect(line()).toBeNull();
      vi.advanceTimersByTime(200);
      expect(line()?.label).toBe('Reading changes');
      expect(PROGRESS_STEPS['reading-stages'].lines).toContain(line()!.line);
      // The focus asks the list first, so the state read starts a moment later.
      await vi.waitFor(() => expect(state).toHaveBeenCalledTimes(2));
      answer(oneSystem(systemViewOf(1)));
      await vi.waitFor(() => expect(line()).toBeNull());
    });
  });

  describe('reads the state again on each trigger (R5.1)', () => {
    const C = '2026-10-12-product-photo-upload';
    const relabeled = (text: string): WorkspaceView => {
      const answer = systemViewOf(0);
      answer.changes = [viewOf(C, text, READY)];
      return oneSystem(answer);
    };
    const labelOf = (vm: SdlcHomeViewModel) => vm.rows().find((r) => r.change === C)?.label?.text;

    it('the window regaining focus asks the plugin again and the row follows its new answer', async () => {
      const { vm, transport } = setup();
      const state = vi.spyOn(transport, 'sdlcState').mockResolvedValue(relabeled('Plan · ready to start'));
      await vm.init();
      expect(labelOf(vm)).toBe('Plan · ready to start');
      state.mockResolvedValue(relabeled('Plan · superseded'));
      vm.windowFocused();
      await vi.waitFor(() => expect(labelOf(vm)).toBe('Plan · superseded'));
      expect(state).toHaveBeenCalledTimes(2);
    });

    it('a document run that ends reads the state again', async () => {
      const { vm, transport, runner } = setup();
      const state = vi.spyOn(transport, 'sdlcState');
      vi.spyOn(runner, 'newChange').mockResolvedValue({ kind: 'opened', change: C, branch: `change/${C}` });
      await vm.init();
      const reads = state.mock.calls.length;
      await vm.newChange('commerce', 'idea', 'full');
      expect(state.mock.calls.length).toBe(reads + 1);
    });

    it('does nothing while a task holds the page', async () => {
      const { vm, transport, lock } = setup();
      const state = vi.spyOn(transport, 'sdlcState');
      await vm.init();
      void lock.runSteps('Busy', [{ label: 'x', run: () => new Promise<null>(() => undefined) }]);
      await flush();
      const reads = state.mock.calls.length;
      vm.windowFocused();
      expect(state.mock.calls.length).toBe(reads);
    });

    it('an older read that answers after a newer one is ignored', async () => {
      const { vm, transport } = setup();
      const state = vi.spyOn(transport, 'sdlcState').mockResolvedValue(relabeled('Plan · ready to start'));
      await vm.init();
      let release: (v: WorkspaceView) => void = () => undefined;
      state.mockImplementationOnce(() => new Promise<WorkspaceView>((ok) => (release = ok)));
      vm.windowFocused();
      state.mockResolvedValueOnce(relabeled('Plan · superseded'));
      vm.windowFocused();
      await vi.waitFor(() => expect(labelOf(vm)).toBe('Plan · superseded'));
      release(relabeled('Spec · ready to start'));
      await flush();
      expect(labelOf(vm)).toBe('Plan · superseded');
    });

    it('a state read that fails says so and keeps the rows it had', async () => {
      const { vm, transport } = setup();
      const state = vi.spyOn(transport, 'sdlcState');
      await vm.init();
      const before = vm.rows().length;
      state.mockRejectedValue('the program did not run');
      vm.windowFocused();
      await vi.waitFor(() => expect(toastText()).toContain('the program did not run'));
      expect(vm.rows().length).toBe(before);
    });
  });
});

describe('SdlcHomeViewModel naming at the start of a change', () => {
  const ALL = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'];

  async function opened(naming?: NamingState) {
    const ctx = setup();
    if (naming) vi.spyOn(ctx.transport, 'sdlcNaming').mockResolvedValue(naming);
    await ctx.vm.init();
    ctx.vm.openNewChange();
    await vi.waitFor(() => expect(ctx.vm.newChangeNaming()).not.toBeNull());
    return ctx;
  }

  it('the picker offers the eleven types with the route default first (R4.1)', async () => {
    const { vm } = await opened();
    // The dialog opens on the triage route.
    expect(vm.workTypes()).toHaveLength(11);
    expect(vm.workTypes()[0]).toBe('fix');
    expect(vm.workType()).toBe('fix');
    expect([...vm.workTypes()].sort()).toEqual([...ALL].sort());
    vm.pickTrack('full');
    expect(vm.workTypes()[0]).toBe('feat');
    expect(vm.workType()).toBe('feat');
    expect(vm.workTypes()).toHaveLength(11);
  });

  it('keeps a type the engineer picked when the route stays the same (R4.1)', async () => {
    const { vm } = await opened();
    vm.pickWorkType('docs');
    expect(vm.workType()).toBe('docs');
  });

  it('offers the system commit scope as the default, else the system name (R4.1)', async () => {
    const { vm, transport } = await opened();
    expect(vm.scope()).toBe('commerce');
    const scan = await transport.sdlcScan(MOCK_WORKSPACE_FOLDER);
    vi.spyOn(transport, 'sdlcScan').mockResolvedValue({ ...scan, marker: { version: 1, systems: { commerce: { repos: ['customer-portal'], commitScope: 'shop' } } } });
    vm.closeNewChange();
    await vm.selectWorkspace(vm.workspaces()[0].id);
    vm.openNewChange();
    await vi.waitFor(() => expect(vm.scope()).toBe('shop'));
  });

  it('a refusal names the base branch the backend resolves, not a stored one', async () => {
    const { vm, transport } = await opened({ kind: 'error', reason: 'unusable', message: 'no {slug}' });
    vi.spyOn(transport, 'sdlcBranches').mockResolvedValue({ current: 'main', others: [], default_base: 'develop' });
    await vm.selectWorkspace(vm.workspaces()[0].id);
    vm.openNewChange();
    await vi.waitFor(() => expect(vm.namingError()).toContain('committed to develop;'));
  });

  it('shows no type or scope picker without a naming setting (R2.1)', async () => {
    const { vm, runner } = await opened({ kind: 'none' });
    expect(vm.workTypes()).toEqual([]);
    expect(vm.namingError()).toBeNull();
    expect(vm.namingReady()).toBe(true);
    const spy = vi.spyOn(runner, 'newChange').mockResolvedValue({ kind: 'stopped' });
    await vm.newChange('commerce', 'flag prices', 'full');
    expect(spy).toHaveBeenCalledWith(expect.anything(), 'commerce', 'flag prices', 'full', expect.any(Function));
  });

  it.each([
    ['pluginMissing', 'the ai-sdlc plugin is not installed'],
    ['pluginTooOld', 'the system naming setting needs ai-sdlc plugin 0.14.0 or later'],
    ['unusable', 'the naming setting cannot be used: "ticket" is not a known part of a name'],
    ['unreadable', 'the naming setting cannot be read: .ai-sdlc.json is not committed at the base branch'],
    ['name', 'not a usable branch name: -D'],
  ] as const)('starting a change in a system with a broken setting is refused: %s (R3.2)', async (reason, text) => {
    const { vm, transport } = await opened({ kind: 'error', reason, message: text });
    const start = vi.spyOn(transport, 'sdlcStartChange');
    expect(vm.namingReady()).toBe(false);
    expect(vm.namingError()).toContain(text);
    expect(vm.namingError()).toContain('fix');
    expect(vm.workTypes()).toEqual([]);
    await vm.newChange('commerce', 'flag prices', 'full');
    expect(start).not.toHaveBeenCalled();
  });

  it('refuses a scope with a space and disables start until it is fixed (R5.2)', async () => {
    const { vm } = await opened();
    vm.setScope('PROJ 123');
    await vi.waitFor(() => expect(vm.scopeProblems()).toEqual(['a scope cannot contain a space']));
    expect(vm.namingReady()).toBe(false);
    vm.setScope('PROJ-123');
    await vi.waitFor(() => expect(vm.scopeProblems()).toEqual([]));
    expect(vm.namingReady()).toBe(true);
  });

  it('does not start with an empty scope (R4.1)', async () => {
    const { vm } = await opened();
    vm.setScope('');
    expect(vm.namingReady()).toBe(false);
  });

  it('hands the picked type and scope to the runner (R4.2)', async () => {
    const { vm, runner, transport } = await opened();
    const start = vi.spyOn(transport, 'sdlcStartChange');
    const spy = vi.spyOn(runner, 'newChange').mockResolvedValue({ kind: 'stopped' });
    vm.pickTrack('full');
    vm.pickWorkType('refactor');
    vm.setScope('PROJ-123');
    await vi.waitFor(() => expect(vm.namingReady()).toBe(true));
    await vm.newChange('commerce', 'flag prices', 'full');
    expect(spy).toHaveBeenCalledWith(expect.anything(), 'commerce', 'flag prices', 'full', expect.any(Function), { workType: 'refactor', scope: 'PROJ-123' });
    expect(start).not.toHaveBeenCalled();
  });
});

describe('SdlcHomeViewModel a refused start (R2.2)', () => {
  async function opened() {
    const ctx = setup();
    await ctx.vm.init();
    ctx.vm.openNewChange();
    await vi.waitFor(() => expect(ctx.vm.newChangeNaming()).not.toBeNull());
    ctx.vm.pickTrack('full');
    ctx.vm.pickWorkType('refactor');
    ctx.vm.setScope('PROJ-123');
    await vi.waitFor(() => expect(ctx.vm.namingReady()).toBe(true));
    return ctx;
  }

  it.each([
    ['taken', 'feat/x is taken in master by the branch feat/x'],
    ['invalid', 'feat/x: a branch name cannot contain a space'],
  ])('a %s branch name: the dialog opens again on the same description with the reason and asks for another name', async (_row, problem) => {
    const { vm, runner } = await opened();
    vi.spyOn(runner, 'newChange').mockResolvedValue({ kind: 'retry', ask: 'branch', problems: [problem] });
    await vm.newChange('commerce', 'flag prices', 'full');
    expect(vm.newChangeOpen()).toBe(true);
    expect(vm.newChangeIdea()).toBe('flag prices');
    expect(vm.newChangeTrack()).toBe('full');
    expect(vm.newChangeSystem()).toBe('commerce');
    expect(vm.branchProblems()).toEqual([problem]);
    // What the engineer picked is still picked.
    expect(vm.workType()).toBe('refactor');
    expect(vm.scope()).toBe('PROJ-123');
  });

  it('starts again with the branch name the engineer gave, and asks for no branch once it works', async () => {
    const { vm, runner } = await opened();
    const spy = vi.spyOn(runner, 'newChange').mockResolvedValueOnce({ kind: 'retry', ask: 'branch', problems: ['taken'] }).mockResolvedValue({ kind: 'stopped' });
    await vm.newChange('commerce', 'flag prices', 'full');
    await vm.newChange('commerce', 'flag prices', 'full', 'feat/y');
    expect(spy.mock.calls[1][6]).toBe('feat/y');
    expect(spy.mock.calls[1][5]).toEqual({ workType: 'refactor', scope: 'PROJ-123' });
    expect(vm.newChangeOpen()).toBe(false);
    expect(vm.branchProblems()).toEqual([]);
  });

  it('a scope the plugin refuses: the dialog opens again with the reason on the scope and Start off until it is changed', async () => {
    const { vm, runner } = await opened();
    vi.spyOn(runner, 'newChange').mockResolvedValue({ kind: 'retry', ask: 'scope', problems: ['the scope: a scope cannot contain a space'] });
    await vm.newChange('commerce', 'flag prices', 'full');
    expect(vm.newChangeOpen()).toBe(true);
    expect(vm.scopeProblems()).toEqual(['the scope: a scope cannot contain a space']);
    expect(vm.namingReady()).toBe(false);
    expect(vm.branchProblems()).toEqual([]);
  });

  it('a start that went through leaves the dialog closed', async () => {
    const { vm, runner } = await opened();
    vi.spyOn(runner, 'newChange').mockResolvedValue({ kind: 'opened', change: '2026-10-18-x', branch: 'change/2026-10-18-x' });
    await vm.newChange('commerce', 'flag prices', 'full');
    expect(vm.newChangeOpen()).toBe(false);
  });
});

describe('SdlcHomeViewModel old per-machine checks', () => {
  const demoAt = (demo: string | null) => history.replaceState({}, '', demo ? `/?demo=${demo}` : '/');
  afterEach(() => demoAt(null));

  it('shows the old checks file with its text the first time the system is opened, and converts or commits nothing (R6.1)', async () => {
    demoAt('old-checks');
    const { vm, transport, saveSettings, runAgent } = setup();
    const seen = vi.spyOn(transport, 'sdlcOldChecksSeen');
    await vm.init();
    await flush();
    const [shown] = vm.oldChecks();
    expect(vm.oldChecks().length).toBe(1);
    expect(shown.system).toBe('commerce');
    expect(shown.path).toMatch(/workbench.checks.commerce\.toml$/);
    expect(shown.text).toContain('command');
    // Told once: the backend is asked to remember it, and nothing else is written or run.
    expect(seen).toHaveBeenCalledWith(['commerce']);
    expect(saveSettings).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('does not show it again once the engineer has been told, in this session or the next (R6.2)', async () => {
    demoAt('old-checks');
    const { vm, transport } = setup();
    await vm.init();
    await flush();
    expect(vm.oldChecks().length).toBe(1);
    vm.dismissOldChecks('commerce');
    expect(vm.oldChecks()).toEqual([]);
    // Opening the system again: the backend has it as told.
    expect(await transport.sdlcOldChecks('D:/Work/acme-commerce', ['commerce'])).toEqual([]);
    await vm.init();
    await flush();
    expect(vm.oldChecks()).toEqual([]);
  });

  it('shows nothing when there is no old checks file', async () => {
    const { vm, transport } = setup();
    const seen = vi.spyOn(transport, 'sdlcOldChecksSeen');
    await vm.init();
    await flush();
    expect(vm.oldChecks()).toEqual([]);
    expect(seen).not.toHaveBeenCalled();
  });
});

describe("SdlcHomeViewModel: Close waits on the settling of the run on show, tracked per run (F32)", () => {
  const LIVE = ['running', 'awaiting'];
  /** Hold the engine's exit of the next run that waits on it, so its after-run work stays going. */
  const holdExit = (transport: MockTransport) => {
    let exit!: (v: boolean) => void;
    const wait = vi.spyOn(transport, 'sdlcWaitRunExit').mockImplementationOnce(() => new Promise<boolean>((r) => (exit = r)));
    return { wait, release: () => exit(true) };
  };
  /** A new change's intent run, started from the home and cancelled: a change run, which the home never shows, held in its after-run work. */
  const intentSettling = async (transport: MockTransport, runner: SdlcRunner) => {
    const workspace = (await transport.sdlcWorkspaces())[0];
    const held = holdExit(transport);
    void runner.newChange({ workspace, master: MOCK_MASTER }, 'commerce', 'flag prices', 'full');
    const key = changeRunKey({ workspace: workspace.folder, system: 'commerce', change: await transport.sdlcChangeName('flag prices') });
    const runs = TestBed.inject(ChangeRunStore);
    await vi.waitFor(() => expect(runs.session(key)?.runId).toBeTruthy());
    runs.cancel(key);
    await vi.waitFor(() => expect(held.wait).toHaveBeenCalled());
  };
  /** A run of no change that takes the screen, cancelled; it has no master, so it leaves nothing to decide. */
  const lockRun = async (transport: MockTransport, runner: SdlcRunner, settling: boolean) => {
    const lock = TestBed.inject(LockStore);
    void runner.run('Context', { ...seedSpec(), name: 'sdlc-context' }, { workspaceId: 'w', target: null, link: null });
    await vi.waitFor(() => expect(LIVE).toContain(TestBed.inject(RunStore).state()));
    const held = settling ? holdExit(transport) : null;
    lock.cancel();
    await vi.waitFor(() => expect(lock.active()).toMatchObject({ kind: 'run', finished: expect.anything() }));
    if (held) await vi.waitFor(() => expect(held.wait).toHaveBeenCalled());
    else await flush();
  };

  const cases: { name: string; shown: 'lock' | 'none'; settling: boolean; other: boolean; blocked: boolean }[] = [
    { name: 'a lock run on show settling', shown: 'lock', settling: true, other: false, blocked: true },
    { name: "a lock run on show settled, a new change's intent run settling", shown: 'lock', settling: false, other: true, blocked: false },
    { name: "no run on show, a new change's intent run settling", shown: 'none', settling: false, other: true, blocked: false },
  ];

  for (const c of cases) {
    it(`${c.name}: Close ${c.blocked ? 'is' : 'is not'} blocked`, async () => {
      const { vm, transport, runAgent, runner } = setup();
      runAgent.mockRestore();
      // The intent run comes first: a new change cannot start while a run holds the screen.
      if (c.other) await intentSettling(transport, runner);
      if (c.shown === 'lock') await lockRun(transport, runner, c.settling);
      expect(vm.session() === null).toBe(c.shown === 'none');
      expect(vm.closeBlocked()).toBe(c.blocked);
    });
  }
});

const listedOf = (system: string, systems: string[], names: string[], finished: { change: string; finished: 'merged' | 'rejected' }[] = [], finishedCount = finished.length): HomeList => ({
  kind: 'listed',
  system,
  systems,
  open: names.map((change) => ({ change, title: `Title of ${change}` })),
  finished: finished.map((f) => ({ ...f, title: null })),
  finishedCount,
  canStartChange: true,
  startChangeReason: null,
});
const homeRowOf = (change: string, text: string, action: HomeAction = 'workflow'): HomeRow => ({
  view: viewOf(change, text, READY),
  reading: { label: { step: 'spec', text, tone: 'muted' }, action },
});
const openOf = (rows: HomeRow[], over: Partial<HomeOpen> = {}): HomeOpen => ({ rows, check: [], relist: false, problems: [], ...over });
const NAMES = ['2026-11-01-a', '2026-11-03-c', '2026-11-02-b'];

describe('SdlcHomeViewModel open changes', () => {
  it("home opens on the system the backend chose and shows that system's changes only", async () => {
    const { vm, transport } = setup({ home: 'listed' });
    vi.spyOn(transport, 'sdlcHomeList').mockResolvedValue(listedOf('bob', ['bob', 'kata'], ['b1', 'b2']));
    const pick = vi.spyOn(transport, 'sdlcHomePick').mockResolvedValue(listedOf('kata', ['bob', 'kata'], ['k1']));
    vi.spyOn(transport, 'sdlcHomeOpen').mockImplementation(async (_f, system, shown) => openOf(shown.map((n) => homeRowOf(n, `${system} ${n}`))));
    await vm.init();
    expect(vm.shownSystem()).toBe('bob');
    expect(vm.systemChoice()).toEqual(['bob', 'kata']);
    expect(vm.rows().map((r) => `${r.system}/${r.change}`)).toEqual(['bob/b1', 'bob/b2']);
    await vm.showSystem('kata');
    expect(pick.mock.calls[0][0]).toBe(vm.current()!.id);
    expect(pick.mock.calls[0][1]).toBe('kata');
    expect(vm.shownSystem()).toBe('kata');
    expect(vm.rows().map((r) => `${r.system}/${r.change}`)).toEqual(['kata/k1']);
    expect(vm.rows()[0].label?.text).toBe('kata k1');
  });

  it('lists open changes by name and title before their stages arrive', async () => {
    const { vm, transport } = setup({ home: 'listed' });
    vi.spyOn(transport, 'sdlcHomeList').mockResolvedValue(listedOf('commerce', ['commerce'], NAMES));
    let release!: (a: HomeOpen) => void;
    vi.spyOn(transport, 'sdlcHomeOpen').mockReturnValue(new Promise<HomeOpen>((r) => (release = r)));
    void vm.init();
    await vi.waitFor(() => expect(vm.rows().length).toBe(3));
    expect(vm.rows().map((r) => [r.change, r.title, r.label])).toEqual(NAMES.map((n) => [n, `Title of ${n}`, null]));
    release(openOf([homeRowOf(NAMES[0], 'Spec A', 'open'), homeRowOf(NAMES[1], 'Spec C'), homeRowOf(NAMES[2], 'Spec B', 'remove-copy')]));
    await vi.waitFor(() => expect(vm.rows().map((r) => r.label?.text)).toEqual(['Spec A', 'Spec C', 'Spec B']));
    expect(vm.rows().map((r) => r.action)).toEqual(['open', 'workflow', 'remove-copy']);
  });

  it("keeps the workflow's order of open changes", async () => {
    const { vm, transport } = setup({ home: 'listed' });
    vi.spyOn(transport, 'sdlcHomeList').mockResolvedValue(listedOf('commerce', ['commerce'], NAMES));
    vi.spyOn(transport, 'sdlcHomeOpen').mockResolvedValue(openOf([homeRowOf(NAMES[2], 'B'), homeRowOf(NAMES[0], 'A'), homeRowOf(NAMES[1], 'C')]));
    await vm.init();
    expect(vm.rows().map((r) => r.change)).toEqual(NAMES);
    expect(vm.rows().map((r) => r.label?.text)).toEqual(['A', 'C', 'B']);
  });

  it('a refresh asks for the open changes only and keeps the rows', async () => {
    const { vm, transport } = setup({ home: 'listed' });
    const list = vi.spyOn(transport, 'sdlcHomeList').mockResolvedValue(listedOf('commerce', ['commerce'], NAMES));
    const all = (text: string) => NAMES.map((n) => homeRowOf(n, text));
    const open = vi.spyOn(transport, 'sdlcHomeOpen').mockResolvedValue(openOf(all('First')));
    const checked = vi.spyOn(transport, 'sdlcHomePullRequests').mockResolvedValue({ rows: [], problems: [] });
    const state = vi.spyOn(transport, 'sdlcState');
    await vm.init();
    list.mockClear();
    open.mockClear();
    state.mockClear();
    checked.mockClear();
    // The window comes back: only the open read, with `focus`.
    let release!: (a: HomeOpen) => void;
    open.mockReturnValueOnce(new Promise<HomeOpen>((r) => (release = r)));
    vm.windowFocused();
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(open.mock.calls[0][3]).toBe('focus');
    expect(vm.rows().length).toBe(3);
    release(openOf(all('Second')));
    await vi.waitFor(() => expect(vm.rows().map((r) => r.label?.text)).toEqual(['Second', 'Second', 'Second']));
    expect(list).not.toHaveBeenCalled();
    expect(state).not.toHaveBeenCalled();
    expect(checked).not.toHaveBeenCalled();
    // An action ended: the scan again, then the open read with `action-ended` and the check it names.
    open.mockClear();
    let releaseOpen!: (a: HomeOpen) => void;
    open.mockReturnValueOnce(new Promise<HomeOpen>((r) => (releaseOpen = r)));
    let releaseChecked!: (a: HomeChecked) => void;
    checked.mockReturnValueOnce(new Promise<HomeChecked>((r) => (releaseChecked = r)));
    void vm.discardLeftovers([]);
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(open.mock.calls[0][3]).toBe('action-ended');
    expect(list).not.toHaveBeenCalled();
    expect(vm.rows().length).toBe(3);
    releaseOpen(openOf(all('Third'), { check: [NAMES[1]] }));
    await vi.waitFor(() => expect(checked).toHaveBeenCalledTimes(1));
    expect(checked.mock.calls[0][2]).toEqual([NAMES[1]]);
    expect(vm.rows().length).toBe(3);
    releaseChecked({ rows: [homeRowOf(NAMES[1], 'Merged', 'remove-copy')], problems: [] });
    await vi.waitFor(() => expect(vm.rows().map((r) => r.label?.text)).toEqual(['Third', 'Merged', 'Third']));
    expect(vm.rows()[1].action).toBe('remove-copy');
  });

  it('a change that finishes leaves the open changes and is counted', async () => {
    const { vm, transport } = setup({ home: 'listed' });
    const versions = '2026-11-03-versions';
    const names = ['2026-11-01-a', versions, '2026-11-02-b'];
    const list = vi
      .spyOn(transport, 'sdlcHomeList')
      .mockResolvedValueOnce(listedOf('commerce', ['commerce'], names, [], 0))
      .mockResolvedValueOnce(listedOf('commerce', ['commerce'], [names[0], names[2]], [{ change: versions, finished: 'merged' }], 1));
    const open = vi.spyOn(transport, 'sdlcHomeOpen').mockResolvedValueOnce(openOf(names.map((n) => homeRowOf(n, 'Stage'))));
    await vm.init();
    expect(vm.rows().length).toBe(3);
    expect(vm.finishedCount()).toBe(0);
    open.mockResolvedValueOnce(openOf([homeRowOf(names[0], 'Stage'), homeRowOf(names[2], 'Stage')], { relist: true }));
    vm.windowFocused();
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(vm.rows().map((r) => r.change)).toEqual([names[0], names[2]]));
    expect(vm.finishedCount()).toBe(1);
    expect(vm.finished()).toEqual([{ change: versions, title: null, finished: 'merged' }]);
    expect(vm.rows().every((r) => r.label?.text === 'Stage')).toBe(true);
  });
});

describe('SdlcHomeViewModel failed reads and an older plugin', () => {
  const failures = [
    'the ai-sdlc program could not run: ai-sdlc needs Node.js 22.18 or later',
    'the ai-sdlc program could not run: it did not finish in 60 seconds',
    'the ai-sdlc program refused: change not found',
  ];
  for (const failure of failures) {
    it(`a failed refresh keeps the rows and shows today's message: ${failure}`, async () => {
      const { vm, transport } = setup({ home: 'listed' });
      vi.spyOn(transport, 'sdlcHomeList').mockResolvedValue(listedOf('commerce', ['commerce'], NAMES));
      const open = vi.spyOn(transport, 'sdlcHomeOpen').mockResolvedValueOnce(openOf(NAMES.map((n) => homeRowOf(n, 'Stage'))));
      await vm.init();
      const before = vm.rows();
      expect(before.length).toBe(3);
      open.mockRejectedValueOnce(new Error(failure));
      vm.windowFocused();
      await vi.waitFor(() => expect(toastText()).toContain(`Could not read the changes: ${failure}`));
      expect(vm.rows()).toEqual(before);
      expect(vm.rows().some((r) => r.failed)).toBe(false);
    });
  }

  it('a failed first stage read marks each row unread', async () => {
    const { vm, transport } = setup({ home: 'listed' });
    vi.spyOn(transport, 'sdlcHomeList').mockResolvedValue(listedOf('commerce', ['commerce'], NAMES));
    vi.spyOn(transport, 'sdlcHomeOpen').mockRejectedValue(new Error('the ai-sdlc program refused: nope'));
    await vm.init();
    expect(vm.rows().map((r) => r.change)).toEqual(NAMES);
    expect(vm.rows().every((r) => r.failed)).toBe(true);
    expect(toastText()).toContain('Could not read the changes: the ai-sdlc program refused: nope');
  });

  it('an older plugin takes today\'s path', async () => {
    const { vm, transport } = setup();
    const state = vi.spyOn(transport, 'sdlcState');
    await vm.init();
    expect(state).toHaveBeenCalledTimes(1);
    expect(state.mock.calls[0][1].length).toBeGreaterThan(0);
    expect(vm.rows().length).toBe(7);
    expect(vm.systemChoice()).toEqual([]);
    expect(vm.finishedCount()).toBe(0);
  });

  it('an update to 1.3.0 is picked up on window focus', async () => {
    const { vm, transport } = setup();
    const list = vi.spyOn(transport, 'sdlcHomeList');
    const state = vi.spyOn(transport, 'sdlcState');
    await vm.init();
    expect(state).toHaveBeenCalledTimes(1);
    list.mockResolvedValue(listedOf('bob', ['bob', 'kata'], ['b1', 'b2']));
    vi.spyOn(transport, 'sdlcHomeOpen').mockImplementation(async (_f, _s, shown) => openOf(shown.map((n) => homeRowOf(n, `Stage ${n}`))));
    vm.windowFocused();
    await vi.waitFor(() => expect(vm.rows().map((r) => `${r.system}/${r.change}`)).toEqual(['bob/b1', 'bob/b2']));
    await vi.waitFor(() => expect(vm.rows().map((r) => r.label?.text)).toEqual(['Stage b1', 'Stage b2']));
    expect(vm.shownSystem()).toBe('bob');
    expect(state).toHaveBeenCalledTimes(1);
  });
});
