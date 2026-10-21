import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import type { ChangeInfo } from '@bindings/ChangeInfo';
import type { RunSpec } from '@bindings/RunSpec';
import { toastState } from '@spartan-ng/brain/sonner';
import { BehaviorSubject } from 'rxjs';
import { LockStore } from '../../core/lock/lock.store';
import { KataTransport } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import { actionsFor } from '../../lib/sdlc';
import { MOCK_BUILD_CHANGE } from '../../lib/sdlc-mock';
import { ChangePageViewModel } from './change-page.view-model';

const FNOL = '2026-10-12-fnol-photo-upload';
const FRAUD = '2026-10-16-fraud-flag';
const REASSIGN = '2026-10-09-adjuster-reassign';
const toastText = () => toastState.toasts().map((t) => String(t.title)).join(' | ');

function setup(change = FNOL, transport = new MockTransport()) {
  const params = new BehaviorSubject(convertToParamMap({ system: 'claims', change }));
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      ChangePageViewModel,
      { provide: KataTransport, useValue: transport },
      { provide: ActivatedRoute, useValue: { paramMap: params.asObservable() } },
    ],
  });
  const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  const runAgent = vi.spyOn(TestBed.inject(LockStore), 'runAgent').mockResolvedValue('success');
  return { vm: TestBed.inject(ChangePageViewModel), transport, params, navigate, runAgent };
}
const ready = async (vm: ChangePageViewModel) => {
  await vi.waitFor(() => {
    TestBed.tick();
    expect(vm.state()).not.toBe('loading');
  });
};
const withStage = (transport: MockTransport, name: string, stage: ChangeInfo['stage'], extra: Partial<ChangeInfo> = {}) => {
  const real = transport.sdlcChanges.bind(transport);
  vi.spyOn(transport, 'sdlcChanges').mockImplementation(async (m, s) =>
    (await real(m, s)).map((c) => (c.change === name ? { ...c, stage, ...extra } : c)),
  );
};

afterEach(() => toastState.reset());

describe('ChangePageViewModel', () => {
  it.each([FRAUD, FNOL, REASSIGN])('offers exactly the stage actions for %s', async (name) => {
    const { vm } = setup(name);
    await ready(vm);
    expect(vm.state()).toBe('ready');
    expect(vm.change()?.change).toBe(name);
    expect(vm.actions()).toEqual(actionsFor(vm.change()!.stage));
    expect(vm.crumbs()).toEqual([name]);
    expect(vm.masterBranch()).toBe('main');
  });

  it('shows the current stage document from the working tree', async () => {
    const { vm } = setup(FNOL);
    await ready(vm);
    expect(vm.docName()).toBe('spec.md');
    expect(vm.doc()).toContain('# Spec: photo upload');
    expect(vm.docParts().frontMatter).toBe('status: draft');
    expect(vm.docParts().body).toContain('Up to 10 photos');
  });

  it('asks the backend for the document by its stem, as read_doc expects', async () => {
    const transport = new MockTransport();
    const read = vi.spyOn(transport, 'sdlcReadDoc');
    const { vm } = setup(FNOL, transport);
    await ready(vm);
    expect(read).toHaveBeenCalledWith(expect.any(String), 'claims', FNOL, 'spec');
  });

  it('shows an earlier document when its tile is picked, and the current one again after a reload', async () => {
    const { vm } = setup(FNOL);
    await ready(vm);
    expect(vm.docs()).toEqual({ intent: true, spec: true, plan: false });
    await vm.showDoc('intent');
    expect(vm.shownDoc()).toBe('intent');
    expect(vm.docName()).toBe('intent.md');
    expect(vm.doc()).toContain('# Photo upload at first notice of loss');
    await vm.act('accept-spec');
    expect(vm.shownDoc()).toBe('spec');
    expect(vm.doc()).toContain('# Spec: photo upload');
  });

  it('a pick during a reload neither cancels the reload nor lands on top of it', async () => {
    const transport = new MockTransport();
    const { vm } = setup(FNOL, transport);
    await ready(vm);
    const realChanges = transport.sdlcChanges.bind(transport);
    let reloading!: () => void;
    const started = new Promise<void>((r) => (reloading = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.spyOn(transport, 'sdlcChanges').mockImplementation(async (m, sys) => {
      reloading();
      await gate;
      return realChanges(m, sys);
    });
    const decided = vm.act('accept-spec');
    await started;
    await vm.showDoc('intent');
    expect(vm.doc()).toContain('# Photo upload at first notice of loss');
    release();
    await decided;
    expect(vm.change()!.stage).toBe('plan-ready');
    expect(vm.shownDoc()).toBe('spec');
    expect(vm.doc()).toContain('# Spec: photo upload');
  });

  it('stays on the shown document and says why when the picked one cannot be read', async () => {
    const transport = new MockTransport();
    const { vm } = setup(FNOL, transport);
    await ready(vm);
    vi.spyOn(transport, 'sdlcReadDoc').mockRejectedValue('permission denied');
    await vm.showDoc('intent');
    expect(vm.shownDoc()).toBe('spec');
    expect(vm.docName()).toBe('spec.md');
    expect(vm.doc()).toContain('# Spec: photo upload');
    expect(toastText()).toContain('Could not read intent.md: permission denied');
  });

  it('ignores a pick for a document that does not exist yet', async () => {
    const transport = new MockTransport();
    const { vm } = setup(FNOL, transport);
    await ready(vm);
    const read = vi.spyOn(transport, 'sdlcReadDoc');
    await vm.showDoc('plan');
    expect(vm.shownDoc()).toBe('spec');
    expect(read).not.toHaveBeenCalled();
  });

  it('shows the intent while the spec has not been started', async () => {
    const transport = new MockTransport();
    withStage(transport, FNOL, 'spec-ready', { spec: { exists: false, committed: false, status: null } });
    const { vm } = setup(FNOL, transport);
    await ready(vm);
    expect(vm.docName()).toBe('intent.md');
  });

  it('counts runs per stage from the links plus unlinked history records with the stage name', async () => {
    const transport = new MockTransport();
    vi.spyOn(transport, 'sdlcRunLinks').mockResolvedValue([
      { workspace_id: 'acme-claims', system: 'claims', change: FNOL, stage: 'intent', run_id: 'r1', started_at: 1 },
      { workspace_id: 'acme-claims', system: 'claims', change: FNOL, stage: 'spec', run_id: 'r2', started_at: 2 },
    ]);
    vi.spyOn(transport, 'listRuns').mockResolvedValue([
      { id: 'r2', kata: `sdlc-claims-${FNOL}-spec`, started_at: 2, isolation: 'none' },
      { id: 'r3', kata: `sdlc-claims-${FNOL}-spec`, started_at: 3, isolation: 'none' },
    ]);
    const { vm } = setup(FNOL, transport);
    await ready(vm);
    expect(vm.runCounts()).toEqual({ intent: 1, spec: 2, plan: 0, build: 0, review: 0 });
  });

  it('says so when the change is not in the workspace', async () => {
    const { vm } = setup('2026-01-01-nope');
    await ready(vm);
    expect(vm.state()).toBe('not-found');
    expect(vm.change()).toBeNull();
    expect(vm.actions()).toEqual([]);
  });

  it('follows the route when only the change param changes (no snapshot)', async () => {
    const { vm, params } = setup(FNOL);
    await ready(vm);
    params.next(convertToParamMap({ system: 'claims', change: FRAUD }));
    await vi.waitFor(() => expect(vm.change()?.change).toBe(FRAUD));
    expect(vm.docName()).toBe('intent.md');
  });

  describe('decisions', () => {
    it('accept-spec calls sdlcDecide with accept-spec, not confirmed, and the reloaded stage is plan-ready', async () => {
      const { vm, transport } = setup(FNOL);
      const decide = vi.spyOn(transport, 'sdlcDecide');
      await ready(vm);
      await vm.act('accept-spec');
      expect(decide).toHaveBeenCalledWith(expect.stringContaining('claims-intent'), 'claims', FNOL, 'accept-spec', false);
      expect(vm.change()?.stage).toBe('plan-ready');
      expect(vm.actions()).toEqual(actionsFor('plan-ready'));
    });

    it('accept plan commits through sdlcDecide and opens the build (R1.2)', async () => {
      const { vm, transport } = setup(REASSIGN);
      const decide = vi.spyOn(transport, 'sdlcDecide');
      await ready(vm);
      expect(vm.primary()).toBe('accept-plan');
      await vm.act('accept-plan');
      expect(decide).toHaveBeenCalledWith(expect.stringContaining('claims-intent'), 'claims', REASSIGN, 'accept-plan', false);
      expect(toastText()).toContain('Accepted plan · committed');
      expect(vm.change()?.stage).toBe('build-ready');
    });

    it('commit-acceptance on a plan accepted but not committed decides accept-plan', async () => {
      const transport = new MockTransport();
      withStage(transport, REASSIGN, 'plan-accepted-uncommitted');
      const { vm } = setup(REASSIGN, transport);
      const decide = vi.spyOn(transport, 'sdlcDecide');
      await ready(vm);
      await vm.act('commit-acceptance');
      expect(decide.mock.calls[0][3]).toBe('accept-plan');
    });

    it('names plan.md in the confirm for a plan decision', async () => {
      const { vm, transport } = setup(REASSIGN);
      vi.spyOn(transport, 'sdlcDecide').mockResolvedValue({ kind: 'needsConfirm', other_edits: true });
      await ready(vm);
      await vm.act('accept-plan');
      expect(vm.confirmPrompt()).toBe('plan.md has other uncommitted edits; accepting commits them too.');
    });

    it('accept-intent moves a draft intent on to spec-ready', async () => {
      const { vm, transport } = setup(FRAUD);
      const decide = vi.spyOn(transport, 'sdlcDecide');
      await ready(vm);
      await vm.act('accept-intent');
      expect(decide.mock.calls[0][3]).toBe('accept-intent');
      expect(vm.change()?.stage).toBe('spec-ready');
    });

    it('reject-intent closes the change', async () => {
      const { vm, transport } = setup(FRAUD);
      const decide = vi.spyOn(transport, 'sdlcDecide');
      await ready(vm);
      await vm.act('reject-intent');
      expect(decide.mock.calls[0][3]).toBe('reject-intent');
      expect(vm.change()?.stage).toBe('rejected');
      expect(vm.actions()).toEqual([]);
    });

    it('opens the confirm on NeedsConfirm with the exact copy, and confirming repeats the decision with confirmed true', async () => {
      const { vm, transport } = setup(FNOL);
      const decide = vi.spyOn(transport, 'sdlcDecide').mockResolvedValueOnce({ kind: 'needsConfirm', other_edits: true });
      await ready(vm);
      await vm.act('accept-spec');
      expect(vm.confirmPrompt()).toBe('spec.md has other uncommitted edits; accepting commits them too.');
      expect(decide).toHaveBeenCalledTimes(1);
      await vm.confirmDecision();
      expect(decide).toHaveBeenCalledTimes(2);
      expect(decide.mock.calls[1]).toEqual([expect.any(String), 'claims', FNOL, 'accept-spec', true]);
      expect(vm.confirmPrompt()).toBeNull();
      expect(vm.change()?.stage).toBe('plan-ready');
    });

    it('names intent.md in the confirm for an intent decision, and cancelling decides nothing', async () => {
      const { vm, transport } = setup(FRAUD);
      const decide = vi.spyOn(transport, 'sdlcDecide').mockResolvedValue({ kind: 'needsConfirm', other_edits: true });
      await ready(vm);
      await vm.act('accept-intent');
      expect(vm.confirmPrompt()).toBe('intent.md has other uncommitted edits; accepting commits them too.');
      vm.cancelConfirm();
      expect(vm.confirmPrompt()).toBeNull();
      expect(decide).toHaveBeenCalledTimes(1);
      expect(vm.change()?.stage).toBe('intent-awaiting');
    });

    it('shows git stderr verbatim in an error toast', async () => {
      const { vm, transport } = setup(FNOL);
      vi.spyOn(transport, 'sdlcDecide').mockResolvedValue({ kind: 'gitFailed', stderr: 'error: gpg failed to sign the data' });
      await ready(vm);
      await vm.act('accept-spec');
      expect(toastText()).toContain('error: gpg failed to sign the data');
    });

    it('falls back to a plain message when git says nothing', async () => {
      const { vm, transport } = setup(FNOL);
      vi.spyOn(transport, 'sdlcDecide').mockResolvedValue({ kind: 'gitFailed', stderr: '  ' });
      await ready(vm);
      await vm.act('accept-spec');
      expect(toastText()).toContain('git refused the commit');
    });

    it.each([
      ['intent-accepted-uncommitted', 'accept-intent'],
      ['spec-accepted-uncommitted', 'accept-spec'],
    ] as const)('commit-acceptance at %s decides %s', async (stage, decision) => {
      const transport = new MockTransport();
      withStage(transport, FNOL, stage);
      const { vm } = setup(FNOL, transport);
      const decide = vi.spyOn(transport, 'sdlcDecide');
      await ready(vm);
      expect(vm.actions()[0]).toBe('commit-acceptance');
      await vm.act('commit-acceptance');
      expect(decide.mock.calls[0][3]).toBe(decision);
    });
  });

  describe('runs', () => {
    const specOf = (runAgent: { mock: { calls: unknown[][] } }) => runAgent.mock.calls[0][1] as RunSpec;

    it('a revisit asks for feedback first and runs nothing until the operator confirms', async () => {
      const { vm, runAgent } = setup(REASSIGN);
      await ready(vm);
      await vm.act('reopen-spec');
      expect(vm.feedbackFor()).toBe('Reopen spec');
      expect(runAgent).not.toHaveBeenCalled();
      vm.cancelFeedback();
      expect(vm.feedbackFor()).toBeNull();
      expect(runAgent).not.toHaveBeenCalled();
    });

    it('reopen spec runs the spec skill with the confirmation and the operator feedback', async () => {
      const { vm, runAgent } = setup(REASSIGN);
      await ready(vm);
      await vm.act('reopen-spec');
      await vm.runWithFeedback('R2 is wrong: supervisors and team leads can reassign.');
      expect(vm.feedbackFor()).toBeNull();
      expect(runAgent).toHaveBeenCalledTimes(1);
      expect(specOf(runAgent).name).toBe(`sdlc-claims-${REASSIGN}-spec`);
      expect(specOf(runAgent).task).toContain('already confirmed reopening this accepted spec');
      expect(specOf(runAgent).task).toContain('Operator feedback:\nR2 is wrong: supervisors and team leads can reassign.');
    });

    it('starting a first draft needs no feedback', async () => {
      const { vm, runAgent } = setup(REASSIGN);
      await ready(vm);
      await vm.act('start-plan');
      expect(vm.feedbackFor()).toBeNull();
      expect(runAgent).toHaveBeenCalledTimes(1);
    });

    it('reopen intent starts an intent run whose task says the reopen was already confirmed', async () => {
      const { vm, runAgent } = setup(FNOL);
      await ready(vm);
      await vm.act('reopen-intent');
      await vm.runWithFeedback('');
      expect(runAgent).toHaveBeenCalledTimes(1);
      expect(specOf(runAgent).task).toContain('already confirmed reopening');
      expect(specOf(runAgent).name).toBe(`sdlc-claims-${FNOL}-intent`);
    });

    it('continue spec runs the spec skill on this change', async () => {
      const { vm, runAgent } = setup(FNOL);
      await ready(vm);
      await vm.act('continue-spec');
      await vm.runWithFeedback('');
      expect(specOf(runAgent).name).toBe(`sdlc-claims-${FNOL}-spec`);
      expect(specOf(runAgent).task).toContain(FNOL);
    });

    it('re-run plan states the replace was already confirmed', async () => {
      const { vm, runAgent } = setup(REASSIGN);
      await ready(vm);
      await vm.act('rerun-plan');
      await vm.runWithFeedback('');
      expect(specOf(runAgent).task).toContain('already confirmed replacing the existing plan');
      expect(specOf(runAgent).task).not.toContain('Operator feedback');
    });

    it('reloads the change after a run', async () => {
      const { vm, transport, runAgent } = setup(FNOL);
      await ready(vm);
      const changes = vi.spyOn(transport, 'sdlcChanges');
      await vm.act('start-spec');
      expect(runAgent).toHaveBeenCalled();
      expect(changes).toHaveBeenCalled();
    });

    it('refuses a second task while the lock is held', async () => {
      const { vm, runAgent, transport } = setup(FNOL);
      await ready(vm);
      const decide = vi.spyOn(transport, 'sdlcDecide');
      vi.spyOn(TestBed.inject(LockStore), 'active').mockReturnValue({ kind: 'run', title: 'x', finished: null });
      await vm.act('accept-spec');
      await vm.act('continue-spec');
      expect(decide).not.toHaveBeenCalled();
      expect(runAgent).not.toHaveBeenCalled();
    });
  });

  it('goes to the workspace home from the workspace controls', async () => {
    const { vm, navigate } = setup(FNOL);
    await ready(vm);
    await vm.selectWorkspace('acme-claims');
    expect(navigate).toHaveBeenCalledWith(['/sdlc']);
    navigate.mockClear();
    await vm.toHome();
    expect(navigate).toHaveBeenCalledWith(['/sdlc']);
  });

  describe('the build', () => {
    const BUILD = MOCK_BUILD_CHANGE;
    const REQUEST = { timeoutSecs: 5400, instructions: null, repo: null };

    it('Start build, Continue build and Another round open the dialog in their own mode', async () => {
      const transport = new MockTransport();
      withStage(transport, BUILD, 'build-stopped');
      const { vm } = setup(BUILD, transport);
      await ready(vm);
      expect(vm.buildMode()).toBeNull();
      await vm.act('continue-build');
      expect(vm.buildMode()).toBe('continue');
      vm.cancelBuild();
      expect(vm.buildMode()).toBeNull();
      await vm.act('another-round');
      expect(vm.buildMode()).toBe('round');
      expect(vm.buildRepos()).toEqual(['claims-intent', 'claims-core', 'customer-portal']);
    });

    it('Start build opens the dialog and prepares nothing yet', async () => {
      const { vm, transport } = setup(BUILD);
      const prepare = vi.spyOn(transport, 'sdlcBuildPrepare');
      await ready(vm);
      await vm.act('start-build');
      expect(vm.buildMode()).toBe('start');
      expect(prepare).not.toHaveBeenCalled();
    });

    it('a ready preparation hands the start, the time limit and the checks folder to the build view', async () => {
      const { vm, transport } = setup(BUILD);
      const prepare = vi.spyOn(transport, 'sdlcBuildPrepare');
      await ready(vm);
      await vm.act('start-build');
      await vm.submitBuild(REQUEST);
      expect(prepare).toHaveBeenCalledWith(expect.any(String), 'claims-intent', 'claims', BUILD, false, null);
      expect(vm.buildMode()).toBeNull();
      const h = vm.handoff()!;
      expect(h.timeoutSecs).toBe(5400);
      expect(h.round).toBeNull();
      expect(h.start.repos.map((r) => r.repo)).toEqual(['claims-core', 'customer-portal']);
      expect(h.checksDir).toBe(await transport.sdlcChecksDir());
    });

    it('the handoff records whether the leftovers were confirmed, so the run is not asked to ask again', async () => {
      const { vm, transport } = setup(BUILD);
      const real = transport.sdlcBuildPrepare.bind(transport);
      vi.spyOn(transport, 'sdlcBuildPrepare').mockResolvedValueOnce({ kind: 'needsConfirm', leftovers: [{ repo: 'claims-core', files: ['a'] }] }).mockImplementation(real);
      await ready(vm);
      await vm.submitBuild(REQUEST);
      await vm.confirmLeftovers();
      expect(vm.handoff()!.continueOnLeftovers).toEqual(['claims-core']);
      await vm.closeBuild();
      await vm.submitBuild(REQUEST);
      expect(vm.handoff()!.continueOnLeftovers).toEqual([]);
    });

    it('Another round names its repository, so the backend counts it as taking part even when its tasks are all done or it is the master (R6.4)', async () => {
      const transport = new MockTransport();
      withStage(transport, BUILD, 'build-finished');
      const { vm } = setup(BUILD, transport);
      const prepare = vi.spyOn(transport, 'sdlcBuildPrepare');
      await ready(vm);
      for (const repo of ['claims-core', 'claims-intent']) {
        await vm.act('another-round');
        await vm.submitBuild({ timeoutSecs: 14400, instructions: 'tidy up', repo });
        expect(prepare).toHaveBeenLastCalledWith(expect.any(String), 'claims-intent', 'claims', BUILD, false, repo);
        await vm.closeBuild();
      }
    });

    it('names the workspace, folder, system, change and every product repository of the system for the build view (R18.5)', async () => {
      const { vm, transport } = setup(BUILD);
      await ready(vm);
      const w = (await transport.sdlcWorkspaces())[0];
      expect(vm.buildContext()).toEqual({ workspaceId: w.id, folder: w.folder, system: 'claims', change: BUILD, systemRepos: ['claims-core', 'customer-portal', 'billing-api'] });
    });

    it('closing the build forgets the handoff and reads the change again', async () => {
      const { vm, transport } = setup(BUILD);
      await ready(vm);
      await vm.submitBuild(REQUEST);
      expect(vm.handoff()).not.toBeNull();
      const changes = vi.spyOn(transport, 'sdlcChanges');
      await vm.closeBuild();
      expect(vm.handoff()).toBeNull();
      expect(changes).toHaveBeenCalled();
    });

    it('reads the checks folder once, however often the page loads', async () => {
      const transport = new MockTransport();
      const checks = vi.spyOn(transport, 'sdlcChecksDir');
      const { vm } = setup(BUILD, transport);
      await ready(vm);
      await vm.discardLeftovers([]);
      expect(checks).toHaveBeenCalledTimes(1);
    });

    it('a round carries its instructions and repository to the build view', async () => {
      const transport = new MockTransport();
      withStage(transport, BUILD, 'build-finished');
      const { vm } = setup(BUILD, transport);
      await ready(vm);
      await vm.act('another-round');
      await vm.submitBuild({ timeoutSecs: 14400, instructions: 'rename the status field to state', repo: 'claims-core' });
      expect(vm.handoff()!.round).toEqual({ instructions: 'rename the status field to state', repo: 'claims-core' });
      expect(vm.handoff()!.timeoutSecs).toBe(14400);
    });

    it('the change page confirms and retries with leftovers (R6.4)', async () => {
      const { vm, transport } = setup(BUILD);
      const left = [{ repo: 'claims-core', files: ['src/new.rs'] }];
      const real = transport.sdlcBuildPrepare.bind(transport);
      const prepare = vi
        .spyOn(transport, 'sdlcBuildPrepare')
        .mockResolvedValueOnce({ kind: 'needsConfirm', leftovers: left })
        .mockImplementation(real);
      await ready(vm);
      await vm.act('start-build');
      await vm.submitBuild(REQUEST);
      expect(vm.leftoverPrompt()!.lines).toEqual(['claims-core: src/new.rs']);
      expect(vm.handoff()).toBeNull();
      expect(prepare).toHaveBeenCalledTimes(1);
      await vm.confirmLeftovers();
      expect(prepare).toHaveBeenCalledTimes(2);
      expect(prepare.mock.calls[0][4]).toBe(false);
      expect(prepare.mock.calls[1][4]).toBe(true);
      expect(vm.leftoverPrompt()).toBeNull();
      expect(vm.handoff()!.timeoutSecs).toBe(5400);
    });

    it('declining the leftovers prepares nothing more', async () => {
      const { vm, transport } = setup(BUILD);
      const prepare = vi.spyOn(transport, 'sdlcBuildPrepare').mockResolvedValue({ kind: 'needsConfirm', leftovers: [{ repo: 'claims-core', files: ['a'] }] });
      await ready(vm);
      await vm.submitBuild(REQUEST);
      vm.cancelLeftovers();
      expect(vm.leftoverPrompt()).toBeNull();
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(vm.handoff()).toBeNull();
    });

    it('a refusal is shown and starts nothing', async () => {
      const { vm, transport } = setup(BUILD);
      vi.spyOn(transport, 'sdlcPluginVersion').mockResolvedValue('0.5.0');
      await ready(vm);
      await vm.submitBuild(REQUEST);
      expect(vm.refusal()).toBe('Update the ai-sdlc plugin to 0.6.0 or later, then start the build again.');
      expect(vm.handoff()).toBeNull();
      vm.closeRefusal();
      expect(vm.refusal()).toBeNull();
    });

    it('reads the build status once the plan exists and lists its tasks', async () => {
      const { vm, transport } = setup(BUILD);
      const status = vi.spyOn(transport, 'sdlcBuildStatus');
      await ready(vm);
      expect(status).toHaveBeenCalled();
      expect(vm.buildTasks().map((t) => t.id).length).toBeGreaterThan(0);
    });

    it('does not read the build status before there is a plan', async () => {
      const { vm, transport } = setup(FNOL);
      const status = vi.spyOn(transport, 'sdlcBuildStatus');
      await ready(vm);
      expect(status).not.toHaveBeenCalled();
      expect(vm.buildTasks()).toEqual([]);
    });
  });

  describe('the page chrome', () => {
    const BUILD = MOCK_BUILD_CHANGE;
    const finished = async () => {
      const transport = new MockTransport();
      withStage(transport, BUILD, 'build-finished');
      await transport.sdlcPublish('f', 'claims-intent', 'claims', BUILD, await transport.sdlcTouchedRepos('f', 'claims-intent', 'claims', BUILD));
      return transport;
    };

    it('has no pills before the change is read, then the four from the stage', async () => {
      const { vm } = setup(FNOL);
      expect(vm.pills()).toEqual([]);
      await ready(vm);
      expect(vm.pills().map((p) => p.text)).toEqual(['Intent', 'Spec · awaiting acceptance', 'Plan · not started', 'Build · locked']);
    });

    it('opens the Build pill once the plan is accepted and a repository has the branch', async () => {
      const { vm } = setup(BUILD);
      await ready(vm);
      expect(vm.pills()[3].disabled).toBe(false);
    });

    it('has no pills and no pull request links while a build is live', async () => {
      const { vm } = setup(BUILD, await finished());
      await ready(vm);
      expect(vm.pills().length).toBe(4);
      expect(vm.pullLinks().length).toBe(3);
      await vm.submitBuild({ timeoutSecs: 5400, instructions: null, repo: null });
      expect(vm.handoff()).not.toBeNull();
      expect(vm.pills()).toEqual([]);
      expect(vm.pullLinks()).toEqual([]);
    });

    it('lists each pull request that has an address, with its number', async () => {
      const { vm } = setup(BUILD, await finished());
      await ready(vm);
      const links = vm.pullLinks();
      expect(links.map((l) => l.repo)).toEqual(['claims-intent', 'claims-core', 'customer-portal']);
      expect(links.every((l) => l.url.startsWith('https://') && /^\d+$/.test(l.number ?? ''))).toBe(true);
    });

    it('has no pull request links before any is open', async () => {
      const { vm } = setup(FNOL);
      await ready(vm);
      expect(vm.pullLinks()).toEqual([]);
    });

    it('shows the branch chip only when the master repository is not on the change branch', async () => {
      const { vm } = setup(FNOL);
      await ready(vm);
      expect(vm.branchChip()).toBe('main');
    });

    it('hides the branch chip when the master repository is on the change branch', async () => {
      const transport = new MockTransport();
      vi.spyOn(transport, 'sdlcBranches').mockResolvedValue({ current: `change/${FNOL}`, others: [], default_base: 'main' });
      const { vm } = setup(FNOL, transport);
      await ready(vm);
      expect(vm.masterBranch()).toBe(`change/${FNOL}`);
      expect(vm.branchChip()).toBeNull();
    });

    it('reads the strip status from the open document front matter', async () => {
      const { vm } = setup(FNOL);
      await ready(vm);
      expect(vm.stripStatus()).toEqual({ text: 'Draft', tone: 'warning' });
      await vm.showDoc('intent');
      expect(vm.stripStatus()).toEqual({ text: 'Accepted', tone: 'success' });
    });

    it('reads the strip status of the build tab from the stage label', async () => {
      const { vm } = setup(BUILD);
      await ready(vm);
      await vm.showDoc('build');
      expect(vm.stripStatus()).toEqual({ text: 'Build · ready to start', tone: 'idle' });
    });

    it('gives the rail the front matter fields except the status, which the strip says', async () => {
      const transport = new MockTransport();
      vi.spyOn(transport, 'sdlcReadDoc').mockResolvedValue('---\nauthor: Sam\nstatus: draft\ndate: 2026-10-19\n---\n# Spec\n');
      const { vm } = setup(FNOL, transport);
      await ready(vm);
      expect(vm.railFields()).toEqual([['author', 'Sam'], ['date', '2026-10-19']]);
      expect(vm.docParts().body).toBe('# Spec\n');
    });

    it('names the document that uses the open one', async () => {
      const { vm } = setup(FNOL);
      await ready(vm);
      expect(vm.usedBy()).toBeNull();
      await vm.showDoc('intent');
      expect(vm.usedBy()).toEqual({ name: 'spec.md', status: { text: 'Draft', tone: 'warning' } });
    });

    it('lists the last three runs of the open stage, newest first, and counts them all', async () => {
      const transport = new MockTransport();
      const link = (run_id: string, stage: string, started_at: number) => ({ workspace_id: 'acme-claims', system: 'claims', change: FNOL, stage, run_id, started_at });
      vi.spyOn(transport, 'sdlcRunLinks').mockResolvedValue([link('a', 'spec', 100), link('b', 'spec', 300), link('c', 'spec', 200), link('d', 'spec', 400), link('e', 'intent', 50)]);
      vi.spyOn(transport, 'listRuns').mockResolvedValue([]);
      const { vm } = setup(FNOL, transport);
      await ready(vm);
      expect(vm.railRuns().total).toBe(4);
      expect(vm.railRuns().rows.map((r) => r.id)).toEqual(['d', 'b', 'c']);
      expect(vm.railRuns().rows[0].kind).toBe('Spec');
      await vm.showDoc('intent');
      expect(vm.railRuns().total).toBe(1);
    });
  });
});
