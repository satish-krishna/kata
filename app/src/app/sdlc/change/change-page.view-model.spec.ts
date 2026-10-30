import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import type { ChangeInfo } from '@bindings/ChangeInfo';
import type { DoneView } from '@bindings/DoneView';
import type { PrLink } from '@bindings/PrLink';
import type { RunSpec } from '@bindings/RunSpec';
import { toastState } from '@spartan-ng/brain/sonner';
import { BehaviorSubject } from 'rxjs';
import { LockStore } from '../../core/lock/lock.store';
import { GivenStore } from '../../core/given/given.store';
import { RunPreviewViewModel } from '../../core/given/run-preview.view-model';
import { SdlcStagesStore, stageKey } from '../../core/sdlc/sdlc-stages.store';
import { KataTransport } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import { givenKey, markLabel, type KindGroup, type PresetRow } from '../../lib/given';
import { actionsFor, safetyRules, type StageAction } from '../../lib/sdlc';
import { MOCK_BUILD_CHANGE } from '../../lib/sdlc-mock';
import { BuildPageViewModel } from '../build/build-page.view-model';
import { ChangePageViewModel } from './change-page.view-model';

const PHOTOS_CHANGE = '2026-10-12-product-photo-upload';
const FRAUD = '2026-10-16-price-flag';
const REASSIGN = '2026-10-09-merchant-reassign';
const toastText = () => toastState.toasts().map((t) => String(t.title)).join(' | ');

/** `confirm` (the default) lets the preview confirm every run at once, so a test about something else never meets it; `real` leaves it to the test. */
function setup(change = PHOTOS_CHANGE, transport = new MockTransport(), preview: 'confirm' | 'real' = 'confirm') {
  const params = new BehaviorSubject(convertToParamMap({ system: 'commerce', change }));
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      ChangePageViewModel,
      BuildPageViewModel,
      RunPreviewViewModel,
      { provide: KataTransport, useValue: transport },
      { provide: ActivatedRoute, useValue: { paramMap: params.asObservable() } },
    ],
  });
  const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  const runAgent = vi.spyOn(TestBed.inject(LockStore), 'runAgent').mockResolvedValue('success');
  const previewVm = TestBed.inject(RunPreviewViewModel);
  if (preview === 'confirm') vi.spyOn(previewVm, 'open').mockImplementation(async (req) => req.spec);
  return { vm: TestBed.inject(ChangePageViewModel), transport, params, navigate, runAgent, preview: previewVm };
}
/** Wait for the preview to be open with its rows resolved. */
const previewReady = (preview: RunPreviewViewModel) => vi.waitFor(() => expect(preview.isOpen() && !preview.busy()).toBe(true));
const previewRows = (preview: RunPreviewViewModel) => preview.groups().flatMap((k) => k.groups.flatMap((g) => g.rows.map((r) => r.row)));
const ready = async (vm: ChangePageViewModel) => {
  await vi.waitFor(() => {
    TestBed.tick();
    expect(vm.state()).not.toBe('loading');
  });
};
/** The build the page started keeps running after the engineer goes back to the change; stop it and wait for the page to give the lock back. */
const settleBuild = async () => {
  TestBed.inject(BuildPageViewModel).cancelBuild();
  await vi.waitFor(() => {
    TestBed.tick();
    expect(TestBed.inject(LockStore).active()).toBeNull();
  });
};
const withStage = (transport: MockTransport, name: string, stage: ChangeInfo['stage'], extra: Partial<ChangeInfo> = {}) => {
  const real = transport.sdlcReadChange.bind(transport);
  vi.spyOn(transport, 'sdlcReadChange').mockImplementation(async (m, s, n) =>
    [await real(m, s, n)].map((c) => (c.change === name ? { ...c, stage, ...extra } : c))[0],
  );
};

afterEach(() => toastState.reset());

describe('ChangePageViewModel', () => {
  it.each([FRAUD, PHOTOS_CHANGE, REASSIGN])('offers exactly the stage actions for %s', async (name) => {
    const { vm } = setup(name);
    await ready(vm);
    expect(vm.state()).toBe('ready');
    expect(vm.change()?.change).toBe(name);
    expect(vm.actions()).toEqual(actionsFor(vm.change()!.stage));
    expect(vm.crumbs()).toEqual([name]);
    expect(vm.masterBranch()).toBe('main');
  });

  it('shows the current stage document from the working tree', async () => {
    const { vm } = setup(PHOTOS_CHANGE);
    await ready(vm);
    expect(vm.docName()).toBe('spec.md');
    expect(vm.doc()).toContain('# Spec: photo upload');
    expect(vm.docParts().fields).toEqual([['status', 'draft']]);
    expect(vm.docParts().body).toContain('Up to 10 photos');
  });

  it('asks the backend for the document by its stem, as read_doc expects', async () => {
    const transport = new MockTransport();
    const read = vi.spyOn(transport, 'sdlcReadDoc');
    const { vm } = setup(PHOTOS_CHANGE, transport);
    await ready(vm);
    expect(read).toHaveBeenCalledWith(expect.any(String), 'commerce', PHOTOS_CHANGE, 'spec');
  });

  it('shows an earlier document when its tile is picked, and the current one again after a reload', async () => {
    const { vm } = setup(PHOTOS_CHANGE);
    await ready(vm);
    expect(vm.docs()).toEqual({ intent: true, spec: true, plan: false });
    await vm.showDoc('intent');
    expect(vm.shownDoc()).toBe('intent');
    expect(vm.docName()).toBe('intent.md');
    expect(vm.doc()).toContain('# Photo upload on the product form');
    await vm.act('accept-spec');
    expect(vm.shownDoc()).toBe('spec');
    expect(vm.doc()).toContain('# Spec: photo upload');
  });

  it('a pick during a reload neither cancels the reload nor lands on top of it', async () => {
    const transport = new MockTransport();
    const { vm } = setup(PHOTOS_CHANGE, transport);
    await ready(vm);
    const realChanges = transport.sdlcReadChange.bind(transport);
    let reloading!: () => void;
    const started = new Promise<void>((r) => (reloading = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.spyOn(transport, 'sdlcReadChange').mockImplementation(async (m, sys, n) => {
      reloading();
      await gate;
      return realChanges(m, sys, n);
    });
    const decided = vm.act('accept-spec');
    await started;
    await vm.showDoc('intent');
    expect(vm.doc()).toContain('# Photo upload on the product form');
    release();
    await decided;
    expect(vm.change()!.stage).toBe('plan-ready');
    expect(vm.shownDoc()).toBe('spec');
    expect(vm.doc()).toContain('# Spec: photo upload');
  });

  it('stays on the shown document and says why when the picked one cannot be read', async () => {
    const transport = new MockTransport();
    const { vm } = setup(PHOTOS_CHANGE, transport);
    await ready(vm);
    vi.spyOn(transport, 'sdlcReadDoc').mockRejectedValue('permission denied');
    await vm.showDoc('intent');
    expect(vm.shownDoc()).toBe('spec');
    expect(vm.docName()).toBe('spec.md');
    expect(vm.doc()).toContain('# Spec: photo upload');
    expect(toastText()).toContain('Could not read intent.md: permission denied');
  });

  it('keeps the old tab and its document until the picked one has been read, then switches both together', async () => {
    const transport = new MockTransport();
    const { vm } = setup(PHOTOS_CHANGE, transport);
    await ready(vm);
    const old = vm.doc();
    let release!: (text: string) => void;
    vi.spyOn(transport, 'sdlcReadDoc').mockReturnValue(new Promise<string>((r) => (release = r)));
    const picking = vm.showDoc('intent');
    expect(vm.shownDoc()).toBe('spec');
    expect(vm.docName()).toBe('spec.md');
    expect(vm.doc()).toBe(old);
    release('# the intent text');
    await picking;
    expect(vm.shownDoc()).toBe('intent');
    expect(vm.doc()).toBe('# the intent text');
  });

  it('holds the picked tab in pendingDoc while it reads, and clears it on success and on failure', async () => {
    const transport = new MockTransport();
    const { vm } = setup(PHOTOS_CHANGE, transport);
    await ready(vm);
    expect(vm.pendingDoc()).toBeNull();
    let release!: (text: string) => void;
    vi.spyOn(transport, 'sdlcReadDoc').mockReturnValueOnce(new Promise<string>((r) => (release = r)));
    const picking = vm.showDoc('intent');
    expect(vm.pendingDoc()).toBe('intent');
    release('# the intent text');
    await picking;
    expect(vm.pendingDoc()).toBeNull();
    vi.spyOn(transport, 'sdlcReadDoc').mockRejectedValueOnce('permission denied');
    const failing = vm.showDoc('spec');
    expect(vm.pendingDoc()).toBe('spec');
    await failing;
    expect(vm.pendingDoc()).toBeNull();
    expect(vm.shownDoc()).toBe('intent');
  });

  it('lets a click back on the shown tab cancel a pick still reading', async () => {
    const transport = new MockTransport();
    const { vm } = setup(PHOTOS_CHANGE, transport);
    await ready(vm);
    const old = vm.doc();
    let release!: (text: string) => void;
    vi.spyOn(transport, 'sdlcReadDoc').mockReturnValue(new Promise<string>((r) => (release = r)));
    const picking = vm.showDoc('intent');
    expect(vm.pendingDoc()).toBe('intent');
    await vm.showDoc('spec');
    expect(vm.pendingDoc()).toBeNull();
    release('# the intent text');
    await picking;
    expect(vm.shownDoc()).toBe('spec');
    expect(vm.doc()).toBe(old);
  });

  it('lets a click back on the Build tab cancel a pick still reading', async () => {
    const transport = new MockTransport();
    const { vm } = setup(MOCK_BUILD_CHANGE, transport);
    await ready(vm);
    await vm.showDoc('build');
    expect(vm.shownDoc()).toBe('build');
    let release!: (text: string) => void;
    vi.spyOn(transport, 'sdlcReadDoc').mockReturnValue(new Promise<string>((r) => (release = r)));
    const picking = vm.showDoc('intent');
    expect(vm.pendingDoc()).toBe('intent');
    await vm.showDoc('build');
    expect(vm.pendingDoc()).toBeNull();
    release('# the intent text');
    await picking;
    expect(vm.shownDoc()).toBe('build');
  });

  it('ignores a pick for a document that does not exist yet', async () => {
    const transport = new MockTransport();
    const { vm } = setup(PHOTOS_CHANGE, transport);
    await ready(vm);
    const read = vi.spyOn(transport, 'sdlcReadDoc');
    await vm.showDoc('plan');
    expect(vm.shownDoc()).toBe('spec');
    expect(read).not.toHaveBeenCalled();
  });

  it('shows the intent while the spec has not been started', async () => {
    const transport = new MockTransport();
    withStage(transport, PHOTOS_CHANGE, 'spec-ready', { spec: { exists: false, committed: false, status: null, head_status: null } });
    const { vm } = setup(PHOTOS_CHANGE, transport);
    await ready(vm);
    expect(vm.docName()).toBe('intent.md');
  });

  it('counts the open stage runs from the links plus unlinked history records with the stage name', async () => {
    const transport = new MockTransport();
    vi.spyOn(transport, 'sdlcRunLinks').mockResolvedValue([
      { workspace_id: 'acme-commerce', system: 'commerce', change: PHOTOS_CHANGE, stage: 'intent', run_id: 'r1', started_at: 1 },
      { workspace_id: 'acme-commerce', system: 'commerce', change: PHOTOS_CHANGE, stage: 'spec', run_id: 'r2', started_at: 2 },
    ]);
    vi.spyOn(transport, 'listRuns').mockResolvedValue([
      { id: 'r2', kata: `sdlc-commerce-${PHOTOS_CHANGE}-spec`, started_at: 2, isolation: 'none', steered: false },
      { id: 'r3', kata: `sdlc-commerce-${PHOTOS_CHANGE}-spec`, started_at: 3, isolation: 'none', steered: false },
    ]);
    const { vm } = setup(PHOTOS_CHANGE, transport);
    await ready(vm);
    expect(vm.railRuns().total).toBe(2);
    await vm.showDoc('intent');
    expect(vm.railRuns().total).toBe(1);
  });

  it('says so when the change is not in the workspace', async () => {
    const { vm } = setup('2026-01-01-nope');
    await ready(vm);
    expect(vm.state()).toBe('not-found');
    expect(vm.change()).toBeNull();
    expect(vm.actions()).toEqual([]);
  });

  it('follows the route when only the change param changes (no snapshot)', async () => {
    const { vm, params } = setup(PHOTOS_CHANGE);
    await ready(vm);
    params.next(convertToParamMap({ system: 'commerce', change: FRAUD }));
    await vi.waitFor(() => expect(vm.change()?.change).toBe(FRAUD));
    expect(vm.docName()).toBe('intent.md');
  });

  describe('decisions', () => {
    it('accept-spec calls sdlcDecide with accept-spec, not confirmed, and the reloaded stage is plan-ready', async () => {
      const { vm, transport } = setup(PHOTOS_CHANGE);
      const decide = vi.spyOn(transport, 'sdlcDecide');
      await ready(vm);
      await vm.act('accept-spec');
      expect(decide).toHaveBeenCalledWith(expect.stringContaining('commerce-docs'), 'commerce', PHOTOS_CHANGE, 'accept-spec', false);
      expect(vm.change()?.stage).toBe('plan-ready');
      expect(vm.actions()).toEqual(actionsFor('plan-ready'));
    });

    it('accept plan commits through sdlcDecide and opens the build (R1.2)', async () => {
      const { vm, transport } = setup(REASSIGN);
      const decide = vi.spyOn(transport, 'sdlcDecide');
      await ready(vm);
      expect(vm.primary()).toBe('accept-plan');
      await vm.act('accept-plan');
      expect(decide).toHaveBeenCalledWith(expect.stringContaining('commerce-docs'), 'commerce', REASSIGN, 'accept-plan', false);
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
      const { vm, transport } = setup(PHOTOS_CHANGE);
      const decide = vi.spyOn(transport, 'sdlcDecide').mockResolvedValueOnce({ kind: 'needsConfirm', other_edits: true });
      await ready(vm);
      await vm.act('accept-spec');
      expect(vm.confirmPrompt()).toBe('spec.md has other uncommitted edits; accepting commits them too.');
      expect(decide).toHaveBeenCalledTimes(1);
      await vm.confirmDecision();
      expect(decide).toHaveBeenCalledTimes(2);
      expect(decide.mock.calls[1]).toEqual([expect.any(String), 'commerce', PHOTOS_CHANGE, 'accept-spec', true]);
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
      const { vm, transport } = setup(PHOTOS_CHANGE);
      vi.spyOn(transport, 'sdlcDecide').mockResolvedValue({ kind: 'gitFailed', stderr: 'error: gpg failed to sign the data' });
      await ready(vm);
      await vm.act('accept-spec');
      expect(toastText()).toContain('error: gpg failed to sign the data');
    });

    it('falls back to a plain message when git says nothing', async () => {
      const { vm, transport } = setup(PHOTOS_CHANGE);
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
      withStage(transport, PHOTOS_CHANGE, stage);
      const { vm } = setup(PHOTOS_CHANGE, transport);
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
      expect(specOf(runAgent).name).toBe(`sdlc-commerce-${REASSIGN}-spec`);
      expect(specOf(runAgent).task).toContain('already confirmed reopening this accepted spec');
      expect(specOf(runAgent).task).toContain('Operator feedback:\nR2 is wrong: supervisors and team leads can reassign.');
    });

    it("a plan run's preview starts from the spec run's choices", async () => {
      const transport = new MockTransport();
      const { vm, runAgent, preview } = setup(PHOTOS_CHANGE, transport, 'real');
      await ready(vm);
      const writes = [vi.spyOn(transport, 'saveSpec'), vi.spyOn(transport, 'saveKata'), vi.spyOn(transport, 'savePreset'), vi.spyOn(transport, 'sdlcSaveSettings'), vi.spyOn(transport, 'sdlcSaveWorkspaces')];
      const github = () => previewRows(preview).find((r) => r.item.id === 'personal:tool-server:github')!;

      const specRun = vm.act('start-spec');
      await previewReady(preview);
      expect(github().off).toBe(false);
      preview.toggle(github().key, true);
      preview.start();
      await specRun;
      expect(runAgent).toHaveBeenCalledTimes(1);

      const planRun = vm.act('start-plan');
      await previewReady(preview);
      expect(github().off).toBe(true);
      expect(github().mark).toBe('kept');
      preview.cancel();
      await planRun;
      expect(runAgent).toHaveBeenCalledTimes(1);
      for (const write of writes) expect(write).not.toHaveBeenCalled();
    });

    it("a plan run's preview starts from the spec run's switched-off project hook", async () => {
      const transport = new MockTransport();
      const { vm, runAgent, preview } = setup(PHOTOS_CHANGE, transport, 'real');
      await ready(vm);
      const writes = [vi.spyOn(transport, 'saveSpec'), vi.spyOn(transport, 'saveKata'), vi.spyOn(transport, 'savePreset'), vi.spyOn(transport, 'sdlcSaveSettings'), vi.spyOn(transport, 'sdlcSaveWorkspaces')];
      const hook = () => previewRows(preview).find((r) => r.item.id === 'project:hook:PostToolUse:Write|Edit:8c1f77e2d3a40b95')!;
      const sdlcPlugin = () => previewRows(preview).find((r) => r.item.id === 'personal:plugin:ai-sdlc@ai-sdlc')!;

      const specRun = vm.act('start-spec');
      await previewReady(preview);
      // Not a build run, so a project hook can be switched off; the ai-sdlc plugin is locked on for every AI-SDLC run.
      expect(hook().locked).toBeNull();
      expect(sdlcPlugin().locked).toMatchObject({ kind: 'required' });
      expect(hook().off).toBe(false);
      const hookId = hook().item.id;
      preview.toggle(hook().key, true);
      preview.start();
      await specRun;
      expect((runAgent.mock.calls[0][1] as RunSpec).given).toMatchObject({ hooks: [hookId], required_plugins: ['ai-sdlc'], build: false });

      const planRun = vm.act('start-plan');
      await previewReady(preview);
      expect(hook()).toMatchObject({ off: true, mark: 'kept' });
      expect(markLabel(hook().mark)).toBe('kept from an earlier run');
      expect(sdlcPlugin().locked).toMatchObject({ kind: 'required' });
      preview.cancel();
      await planRun;
      for (const write of writes) expect(write).not.toHaveBeenCalled();
    });

    it('a revisit opens the preview after the feedback dialog', async () => {
      const { vm, runAgent, preview } = setup(REASSIGN, new MockTransport(), 'real');
      await ready(vm);
      await vm.act('reopen-spec');
      expect(vm.feedbackFor()).toBe('Reopen spec');
      expect(preview.isOpen()).toBe(false);
      const run = vm.runWithFeedback('R2 is wrong.');
      await previewReady(preview);
      expect(vm.feedbackFor()).toBeNull();
      expect(runAgent).not.toHaveBeenCalled();
      preview.start();
      await run;
      expect(runAgent).toHaveBeenCalledTimes(1);
      expect((runAgent.mock.calls[0][1] as RunSpec).task).toContain('Operator feedback:\nR2 is wrong.');
    });

    it('a cancelled preview starts no run and leaves no lock', async () => {
      const { vm, runAgent, preview } = setup(PHOTOS_CHANGE, new MockTransport(), 'real');
      await ready(vm);
      const run = vm.act('start-spec');
      await previewReady(preview);
      preview.cancel();
      await run;
      expect(runAgent).not.toHaveBeenCalled();
      expect(TestBed.inject(LockStore).active()).toBeNull();
    });

    it('starting a first draft needs no feedback', async () => {
      const { vm, runAgent } = setup(REASSIGN);
      await ready(vm);
      await vm.act('start-plan');
      expect(vm.feedbackFor()).toBeNull();
      expect(runAgent).toHaveBeenCalledTimes(1);
    });

    it('reopen intent starts an intent run whose task says the reopen was already confirmed', async () => {
      const { vm, runAgent } = setup(PHOTOS_CHANGE);
      await ready(vm);
      await vm.act('reopen-intent');
      await vm.runWithFeedback('');
      expect(runAgent).toHaveBeenCalledTimes(1);
      expect(specOf(runAgent).task).toContain('already confirmed reopening');
      expect(specOf(runAgent).name).toBe(`sdlc-commerce-${PHOTOS_CHANGE}-intent`);
    });

    it('continue spec runs the spec skill on this change', async () => {
      const { vm, runAgent } = setup(PHOTOS_CHANGE);
      await ready(vm);
      await vm.act('continue-spec');
      await vm.runWithFeedback('');
      expect(specOf(runAgent).name).toBe(`sdlc-commerce-${PHOTOS_CHANGE}-spec`);
      expect(specOf(runAgent).task).toContain(PHOTOS_CHANGE);
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
      const { vm, transport, runAgent } = setup(PHOTOS_CHANGE);
      await ready(vm);
      const changes = vi.spyOn(transport, 'sdlcReadChange');
      await vm.act('start-spec');
      expect(runAgent).toHaveBeenCalled();
      expect(changes).toHaveBeenCalled();
    });

    it('refuses a second task while the lock is held', async () => {
      const { vm, runAgent, transport } = setup(PHOTOS_CHANGE);
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
    const { vm, navigate } = setup(PHOTOS_CHANGE);
    await ready(vm);
    await vm.selectWorkspace('acme-commerce');
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
      expect(vm.buildRepos()).toEqual(['commerce-docs', 'commerce-core', 'customer-portal']);
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
      expect(prepare).toHaveBeenCalledWith(expect.any(String), 'commerce-docs', 'commerce', BUILD, false, null, 'start');
      expect(vm.buildMode()).toBeNull();
      const h = TestBed.inject(BuildPageViewModel).current()!;
      expect(h.timeoutSecs).toBe(5400);
      expect(h.round).toBeNull();
      expect(h.start.repos.map((r) => r.repo)).toEqual(['commerce-core', 'customer-portal']);
      expect(h.checksDir).toBe(await transport.sdlcChecksDir());
    });

    it('the handoff records whether the leftovers were confirmed, so the run is not asked to ask again', async () => {
      const { vm, transport } = setup(BUILD);
      const real = transport.sdlcBuildPrepare.bind(transport);
      vi.spyOn(transport, 'sdlcBuildPrepare').mockResolvedValueOnce({ kind: 'needsConfirm', leftovers: [{ repo: 'commerce-core', files: ['a'] }] }).mockImplementation(real);
      await ready(vm);
      await vm.submitBuild(REQUEST);
      await vm.confirmLeftovers();
      expect(TestBed.inject(BuildPageViewModel).current()!.continueOnLeftovers).toEqual(['commerce-core']);
      await settleBuild();
      await vm.submitBuild(REQUEST);
      expect(TestBed.inject(BuildPageViewModel).current()!.continueOnLeftovers).toEqual([]);
    });

    it('Another round names its repository, so the backend counts it as taking part even when its tasks are all done or it is the master (R6.4)', async () => {
      const transport = new MockTransport();
      withStage(transport, BUILD, 'build-finished');
      const { vm } = setup(BUILD, transport);
      const prepare = vi.spyOn(transport, 'sdlcBuildPrepare');
      await ready(vm);
      for (const repo of ['commerce-core', 'commerce-docs']) {
        await vm.act('another-round');
        await vm.submitBuild({ timeoutSecs: 14400, instructions: 'tidy up', repo });
        expect(prepare).toHaveBeenLastCalledWith(expect.any(String), 'commerce-docs', 'commerce', BUILD, false, repo, 'round');
        await settleBuild();
      }
    });

    it('names the workspace, folder, system, change and every product repository of the system for the build view (R18.5)', async () => {
      const { vm, transport } = setup(BUILD);
      await ready(vm);
      const w = (await transport.sdlcWorkspaces())[0];
      expect(vm.buildContext()).toEqual({ workspaceId: w.id, folder: w.folder, system: 'commerce', change: BUILD, systemRepos: ['commerce-core', 'customer-portal', 'billing-api'] });
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
      await vm.submitBuild({ timeoutSecs: 14400, instructions: 'rename the status field to state', repo: 'commerce-core' });
      expect(TestBed.inject(BuildPageViewModel).current()!.round).toEqual({ instructions: 'rename the status field to state', repo: 'commerce-core' });
      expect(TestBed.inject(BuildPageViewModel).current()!.timeoutSecs).toBe(14400);
    });

    it('the change page confirms and retries with leftovers (R6.4)', async () => {
      const { vm, transport } = setup(BUILD);
      const left = [{ repo: 'commerce-core', files: ['src/new.rs'] }];
      const real = transport.sdlcBuildPrepare.bind(transport);
      const prepare = vi
        .spyOn(transport, 'sdlcBuildPrepare')
        .mockResolvedValueOnce({ kind: 'needsConfirm', leftovers: left })
        .mockImplementation(real);
      await ready(vm);
      await vm.act('start-build');
      await vm.submitBuild(REQUEST);
      expect(vm.leftoverPrompt()!.lines).toEqual(['commerce-core: src/new.rs']);
      expect(TestBed.inject(BuildPageViewModel).current()).toBeNull();
      expect(prepare).toHaveBeenCalledTimes(1);
      await vm.confirmLeftovers();
      expect(prepare).toHaveBeenCalledTimes(2);
      expect(prepare.mock.calls[0][4]).toBe(false);
      expect(prepare.mock.calls[1][4]).toBe(true);
      expect(vm.leftoverPrompt()).toBeNull();
      expect(TestBed.inject(BuildPageViewModel).current()!.timeoutSecs).toBe(5400);
    });

    it('declining the leftovers prepares nothing more', async () => {
      const { vm, transport } = setup(BUILD);
      const prepare = vi.spyOn(transport, 'sdlcBuildPrepare').mockResolvedValue({ kind: 'needsConfirm', leftovers: [{ repo: 'commerce-core', files: ['a'] }] });
      await ready(vm);
      await vm.submitBuild(REQUEST);
      vm.cancelLeftovers();
      expect(vm.leftoverPrompt()).toBeNull();
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(TestBed.inject(BuildPageViewModel).current()).toBeNull();
    });

    it.each([['start-build', 'start'], ['continue-build', 'continue'], ['another-round', 'round']] as const)('a refusal by the gate lists its problems and starts nothing: %s asks for %s (R8.1)', async (act, action) => {
      const problem = { file: 'build/app.md', line: 14, message: 'entry T1 is recorded twice, first on line 7' };
      const { vm, transport } = setup(BUILD);
      const prepare = vi.spyOn(transport, 'sdlcBuildPrepare').mockResolvedValue({ kind: 'refused', message: 'A build log does not pass the check', problems: [problem] });
      await ready(vm);
      await vm.act(act);
      await vm.submitBuild(REQUEST);
      expect(prepare.mock.calls[0][6]).toBe(action);
      expect(vm.refusal()).toBe('A build log does not pass the check');
      expect(vm.refusalProblems()).toEqual([problem]);
      expect(TestBed.inject(BuildPageViewModel).current()).toBeNull();
      vm.closeRefusal();
      expect(vm.refusal()).toBeNull();
      expect(vm.refusalProblems()).toEqual([]);
    });

    it('a refusal is shown and starts nothing', async () => {
      const { vm, transport } = setup(BUILD);
      vi.spyOn(transport, 'sdlcPluginReadiness').mockResolvedValue({ kind: 'tooOld', have: '0.7.9', need: '0.9.0' });
      await ready(vm);
      await vm.submitBuild(REQUEST);
      expect(vm.refusal()).toBe('Update the ai-sdlc plugin to 0.9.0 or later, then start the build again.');
      expect(TestBed.inject(BuildPageViewModel).current()).toBeNull();
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
      const { vm, transport } = setup(PHOTOS_CHANGE);
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
      await transport.sdlcPublish('f', 'w1', 'commerce-docs', 'commerce', BUILD, await transport.sdlcTouchedRepos('f', 'commerce-docs', 'commerce', BUILD));
      return transport;
    };

    it('has no pills before the change is read, then the four from the stage', async () => {
      const { vm } = setup(PHOTOS_CHANGE);
      expect(vm.pills()).toEqual([]);
      await ready(vm);
      expect(vm.pills().map((p) => p.text)).toEqual(['Intent', 'Spec · awaiting acceptance', 'Plan · not started', 'Build · locked']);
    });

    it('opens the Build pill once the plan is accepted', async () => {
      const { vm } = setup(BUILD);
      await ready(vm);
      expect(vm.pills()[3].disabled).toBe(false);
    });

    it('keeps the pills and the pull request links while a build is live: the build page stands beside the change, not in place of it', async () => {
      const { vm } = setup(BUILD, await finished());
      await ready(vm);
      expect(vm.pills().length).toBe(4);
      expect(vm.pullLinks().length).toBe(3);
      await vm.submitBuild({ timeoutSecs: 5400, instructions: null, repo: null });
      expect(TestBed.inject(BuildPageViewModel).current()).not.toBeNull();
      expect(vm.pills().length).toBe(4);
      expect(vm.pullLinks().length).toBe(3);
      await settleBuild();
    });

    it('lists each pull request that has an address, with its number', async () => {
      const { vm } = setup(BUILD, await finished());
      await ready(vm);
      const links = vm.pullLinks();
      expect(links.map((l) => l.repo)).toEqual(['commerce-docs', 'commerce-core', 'customer-portal']);
      expect(links.every((l) => l.url.startsWith('https://') && /^\d+$/.test(l.number ?? ''))).toBe(true);
    });

    it('has no pills and no pull request links while a skill run holds the page', async () => {
      const { vm } = setup(BUILD, await finished());
      const lock = TestBed.inject(LockStore);
      vi.spyOn(lock, 'active').mockReturnValue({ kind: 'run', title: 'Starting spec', finished: null });
      vi.spyOn(lock, 'spec').mockReturnValue({} as RunSpec);
      await ready(vm);
      expect(vm.session()).not.toBeNull();
      expect(vm.change()?.stage).toBe('build-finished');
      expect(vm.pills()).toEqual([]);
      expect(vm.pullLinks()).toEqual([]);
    });

    it('has no pull request links before any is open', async () => {
      const { vm } = setup(PHOTOS_CHANGE);
      await ready(vm);
      expect(vm.pullLinks()).toEqual([]);
    });

    it('shows the branch chip only when the master repository is not on the change branch', async () => {
      const { vm } = setup(PHOTOS_CHANGE);
      await ready(vm);
      expect(vm.branchChip()).toBe('main');
    });

    it('hides the branch chip when the master repository is on the change branch', async () => {
      const transport = new MockTransport();
      vi.spyOn(transport, 'sdlcBranches').mockResolvedValue({ current: `change/${PHOTOS_CHANGE}`, others: [], default_base: 'main', pending_change: null });
      const { vm } = setup(PHOTOS_CHANGE, transport);
      await ready(vm);
      expect(vm.masterBranch()).toBe(`change/${PHOTOS_CHANGE}`);
      expect(vm.branchChip()).toBeNull();
    });

    it('asks for a name only for the change the pending branch created, not for another change opened while it is checked out (R6.6)', async () => {
      const pending = 'change/pending-20261102T000000Z';
      const branches = (pending_change: string | null) => ({ current: pending, others: [], default_base: 'main', pending_change });
      const other = new MockTransport();
      vi.spyOn(other, 'sdlcBranches').mockResolvedValue(branches('product/2026-11-02-password-reset'));
      const { vm: otherVm } = setup(PHOTOS_CHANGE, other);
      await ready(otherVm);
      expect(otherVm.masterBranch()).toBe(pending);
      expect(otherVm.needsName()).toBe(false);

      const created = new MockTransport();
      vi.spyOn(created, 'sdlcBranches').mockResolvedValue(branches(`product/${PHOTOS_CHANGE}`));
      const { vm: createdVm } = setup(PHOTOS_CHANGE, created);
      await ready(createdVm);
      expect(createdVm.needsName()).toBe(true);
    });

    it('reads the strip status from the open document front matter', async () => {
      const { vm } = setup(PHOTOS_CHANGE);
      await ready(vm);
      expect(vm.stripStatus()).toEqual({ text: 'Draft', tone: 'warning' });
      await vm.showDoc('intent');
      expect(vm.stripStatus()).toEqual({ text: 'Accepted', tone: 'success' });
    });

    it('leaves the status of the Build tab to its pill, so the strip does not word it a second way', async () => {
      const { vm } = setup(BUILD);
      await ready(vm);
      await vm.showDoc('build');
      expect(vm.pills()[3]).toMatchObject({ step: 'build', text: 'Build · ready to start', tone: 'idle' });
      expect(vm.stripStatus()).toBeNull();
    });

    it('never puts the stage label on the Build tab strip: the pills own it, so "Build · done" has no "Done · pull requests open" beside it', async () => {
      const { vm } = setup(BUILD, await finished());
      await ready(vm);
      await vm.showDoc('build');
      expect(vm.done()).toBe(true);
      expect(vm.pills()[3].text).toBe('Build · done');
      expect(vm.stripStatus()).toBeNull();
    });

    it('draws no strip on the Build tab when there is no status, no facts and no action', async () => {
      const transport = await finished();
      vi.spyOn(transport, 'sdlcBuildStatus').mockResolvedValue({ tasks: [], repos: [], departures: [], hasTasks: false, problems: [], logLayouts: [] });
      const { vm } = setup(BUILD, transport);
      await ready(vm);
      await vm.showDoc('build');
      expect(vm.actions()).toEqual([]);
      expect(vm.stripShown()).toBe(false);
    });

    it('offers the build page\'s actions on every tab of a build-stage change, not the change\'s own (R10.2)', async () => {
      const transport = new MockTransport();
      withStage(transport, BUILD, 'build-finished');
      const { vm } = setup(BUILD, transport);
      await ready(vm);
      // Cancelled during the review: the page's stage offers Continue build and Another round, where the change's stage would offer Declare done.
      Object.defineProperty(TestBed.inject(BuildPageViewModel), 'actions', { value: signal<StageAction[]>(['continue-build', 'another-round']) });
      await vm.showDoc('build');
      const onBuild = vm.actions();
      await vm.showDoc('plan');
      expect(vm.actions()).toEqual(onBuild);
      expect(vm.actions()).toEqual(['continue-build', 'another-round', 'reopen-spec', 'reopen-intent']);
    });

    it('offers Reopen intent and Reopen spec once each on the build step of a full-pipeline change (R1.2)', async () => {
      const transport = new MockTransport();
      withStage(transport, BUILD, 'build-finished');
      const { vm } = setup(BUILD, transport);
      await ready(vm);
      expect(vm.actions().filter((a) => a === 'reopen-intent')).toHaveLength(1);
      expect(vm.actions().filter((a) => a === 'reopen-spec')).toHaveLength(1);
      expect(vm.barExtras().map((e) => e.action)).toEqual(['reopen-spec', 'reopen-intent']);
    });

    it('leaves the reopen actions to the change page at build-ready, offering each once in the change\'s order (R1.2)', async () => {
      const { vm } = setup(BUILD);
      await ready(vm);
      expect(vm.change()!.stage).toBe('build-ready');
      expect(TestBed.inject(BuildPageViewModel).actions()).not.toContain('reopen-intent');
      expect(vm.actions()).toEqual(['start-build', 'reopen-spec', 'reopen-intent']);
      expect(vm.barExtras().map((e) => e.action)).toEqual(['reopen-spec', 'reopen-intent']);
    });

    it('turns both reopen actions off at build-ready while a live build run holds the lock (R1.3)', async () => {
      const { vm } = setup(BUILD);
      await ready(vm);
      expect(vm.change()!.stage).toBe('build-ready');
      expect(vm.disabledFor('reopen-intent')).toBe(false);
      expect(vm.disabledFor('reopen-spec')).toBe(false);
      expect(TestBed.inject(LockStore).beginBuild('Building')).toBe(true);
      expect(vm.actions()).toContain('reopen-intent');
      expect(vm.actions()).toContain('reopen-spec');
      expect(vm.disabledFor('reopen-intent')).toBe(true);
      expect(vm.disabledFor('reopen-spec')).toBe(true);
      expect(vm.barExtras().every((e) => e.disabled)).toBe(true);
    });

    it('turns the reopen actions off while a live build run holds the lock (R1.3)', async () => {
      const transport = new MockTransport();
      withStage(transport, BUILD, 'build-finished');
      const { vm } = setup(BUILD, transport);
      await ready(vm);
      expect(vm.actions()).toContain('reopen-intent');
      expect(vm.actions()).toContain('reopen-spec');
      expect(vm.disabledFor('reopen-intent')).toBe(false);
      expect(TestBed.inject(LockStore).beginBuild('Building')).toBe(true);
      expect(vm.actions()).toContain('reopen-intent');
      expect(vm.actions()).toContain('reopen-spec');
      expect(vm.disabledFor('reopen-intent')).toBe(true);
      expect(vm.disabledFor('reopen-spec')).toBe(true);
      expect(vm.barExtras().every((e) => e.disabled)).toBe(true);
    });

    it('draws no page strip on the Build tab at all: its facts and actions sit in the Changes view strip', async () => {
      const { vm } = setup(BUILD);
      await ready(vm);
      await vm.showDoc('build');
      expect(vm.actions().length).toBeGreaterThan(0);
      expect(vm.stripShown()).toBe(false);
    });

    it('keeps the strip on a document tab, where the status and the file name are always something to say', async () => {
      const { vm } = setup(PHOTOS_CHANGE);
      await ready(vm);
      expect(vm.stripShown()).toBe(true);
    });

    it('opens a requirement the spec has, in the Requirements view', async () => {
      const { vm } = setup(BUILD);
      await ready(vm);
      await vm.openRequirement('R2.1');
      expect(vm.shownDoc()).toBe('spec');
      expect(vm.shownView()).toBe('list');
      expect(vm.pickedRequirement()?.id).toBe('R2');
    });

    it('opens the whole spec, not R1, for a requirement the spec does not have', async () => {
      const { vm } = setup(BUILD);
      await ready(vm);
      await vm.openRequirement('R99.1');
      expect(vm.shownDoc()).toBe('spec');
      expect(vm.shownView()).toBe('whole');
    });

    it('gives the rail the front matter fields except the status, which the strip says', async () => {
      const transport = new MockTransport();
      vi.spyOn(transport, 'sdlcReadDoc').mockResolvedValue('---\nauthor: Sam\nstatus: draft\ndate: 2026-10-19\n---\n# Spec\n');
      const { vm } = setup(PHOTOS_CHANGE, transport);
      await ready(vm);
      expect(vm.railFields()).toEqual([['author', 'Sam'], ['date', '2026-10-19']]);
      expect(vm.docParts().body).toBe('# Spec\n');
    });

    it('names the document that uses the open one', async () => {
      const { vm } = setup(PHOTOS_CHANGE);
      await ready(vm);
      expect(vm.usedBy()).toBeNull();
      await vm.showDoc('intent');
      expect(vm.usedBy()).toEqual({ name: 'spec.md', status: { text: 'Draft', tone: 'warning' } });
    });

    it('lists the last three runs of the open stage, newest first, and counts them all', async () => {
      const transport = new MockTransport();
      const link = (run_id: string, stage: string, started_at: number) => ({ workspace_id: 'acme-commerce', system: 'commerce', change: PHOTOS_CHANGE, stage, run_id, started_at });
      vi.spyOn(transport, 'sdlcRunLinks').mockResolvedValue([link('a', 'spec', 100), link('b', 'spec', 300), link('c', 'spec', 200), link('d', 'spec', 400), link('e', 'intent', 50)]);
      vi.spyOn(transport, 'listRuns').mockResolvedValue([]);
      const { vm } = setup(PHOTOS_CHANGE, transport);
      await ready(vm);
      expect(vm.railRuns().total).toBe(4);
      expect(vm.railRuns().rows.map((r) => r.id)).toEqual(['d', 'b', 'c']);
      expect(vm.railRuns().rows[0].kind).toBe('Spec');
      await vm.showDoc('intent');
      expect(vm.railRuns().total).toBe(1);
    });
  });
});

describe('the build\'s preview', () => {
  const BUILD = MOCK_BUILD_CHANGE;
  const KEY = `commerce/${BUILD}`;
  const GITHUB = 'personal:tool-server:github';
  const ENGINEER = 'set in this preview';
  const flat = (groups: KindGroup[]): PresetRow[] => groups.flatMap((k) => k.groups.flatMap((g) => g.rows.flatMap((e) => [e.row, ...e.followers])));
  const limit = (preview: RunPreviewViewModel) => preview.settings().find((s) => s.label === 'Time limit');
  const section = (preview: RunPreviewViewModel, title: string) => flat(preview.sections()!.find((s) => s.title === title)!.groups);
  const dbKey = (vm: ChangePageViewModel, repo: string) => givenKey(`project:tool-server:${repo}-db`, `${vm.current()!.folder}/${repo}`);
  const staged = async (stage: ChangeInfo['stage'], change = BUILD) => {
    const transport = new MockTransport();
    withStage(transport, change, stage);
    const s = setup(change, transport, 'real');
    await ready(s.vm);
    return { ...s, givens: TestBed.inject(GivenStore), prepare: vi.spyOn(transport, 'sdlcBuildPrepare') };
  };
  /** Wait for the preview, press Start run, and wait for the build to be handed over. */
  const startPreview = async (preview: RunPreviewViewModel, _vm: ChangePageViewModel) => {
    await previewReady(preview);
    preview.start();
    await vi.waitFor(() => expect(TestBed.inject(BuildPageViewModel).current()).not.toBeNull());
  };

  it('Start build opens one preview for the whole build: shared items once, a section per repository, one for the review (R11.2, R11.3)', async () => {
    const { vm, preview, prepare } = await staged('build-ready');
    await vm.act('start-build');
    await previewReady(preview);
    expect(prepare).not.toHaveBeenCalled();
    expect(preview.title()).toBe('Start build');
    // Shared items appear once and are never repeated under a section.
    const shared = flat(preview.groups());
    expect(shared.filter((r) => r.item.id === GITHUB)).toHaveLength(1);
    expect(shared.every((r) => r.key === r.item.id)).toBe(true);
    expect(preview.sections()!.map((s) => s.title)).toEqual(['commerce-core', 'customer-portal', 'Review']);
    for (const title of ['commerce-core', 'customer-portal', 'Review']) expect(section(preview, title).every((r) => r.key !== r.item.id)).toBe(true);
    // Each repository's project items sit under that repository; the master's sit under the review.
    const ids = (title: string) => section(preview, title).map((r) => r.item.id);
    expect(ids('commerce-core')).toContain('project:tool-server:commerce-core-db');
    expect(ids('commerce-core')).not.toContain('project:tool-server:customer-portal-db');
    expect(ids('customer-portal')).toContain('project:tool-server:customer-portal-db');
    expect(ids('Review')).toContain('project:tool-server:commerce-docs-db');
    expect(ids('Review')).toContain('project:skill:commerce-docs-conventions');
  });

  it('a switch on a shared row applies to every run; a switch on a project row only to its folder (R11.1, R11.2)', async () => {
    const { vm, preview, givens } = await staged('build-ready');
    await vm.act('start-build');
    await previewReady(preview);
    preview.toggle(GITHUB, true);
    preview.toggle(dbKey(vm, 'commerce-core'), true);
    await startPreview(preview, vm);
    expect(TestBed.inject(BuildPageViewModel).current()!.choices!.off).toEqual(new Set([GITHUB, dbKey(vm, 'commerce-core')]));
    // The build keeps them for the runs it starts by itself, and the next build starts from them.
    expect(givens.build(KEY)!.off).toEqual(new Set([GITHUB, dbKey(vm, 'commerce-core')]));
    expect(TestBed.inject(BuildPageViewModel).current()!.timeoutSecs).toBe(7200);
  });

  it('cancelling the build\'s preview prepares nothing and leaves the build\'s choices alone', async () => {
    const { vm, preview, prepare, givens } = await staged('build-ready');
    await vm.act('start-build');
    await previewReady(preview);
    preview.toggle(GITHUB, true);
    preview.cancel();
    await vi.waitFor(() => expect(vm.buildMode()).toBeNull());
    expect(prepare).not.toHaveBeenCalled();
    expect(givens.build(KEY)).toBeNull();
    expect(TestBed.inject(BuildPageViewModel).current()).toBeNull();
  });

  it('a first build starts from the session\'s choices, marked as kept from an earlier run (R9.1)', async () => {
    const { vm, preview, givens } = await staged('build-ready');
    givens.remember([{ item: { id: GITHUB, brought_by: null } as never, key: GITHUB, off: true, locked: null, mark: null }], '');
    await vm.act('start-build');
    await previewReady(preview);
    expect(flat(preview.groups()).find((r) => r.item.id === GITHUB)).toMatchObject({ off: true, mark: 'kept' });
  });

  it('the build\'s preview lists the safety rules read-only (R7.1)', async () => {
    const { vm, preview } = await staged('build-ready');
    await vm.act('start-build');
    await previewReady(preview);
    expect(preview.safetyRules()).toEqual(safetyRules('repo'));
    expect(preview.safetyRules()).toContain('No push');
    // Nothing in the preview switches a rule off: the rules are text, and no row carries one.
    expect(flat(preview.groups()).some((r) => preview.safetyRules()!.includes(r.item.name))).toBe(false);
  });

  it.each([
    ['a build', 'build-ready', 'start-build', '2 h', ENGINEER, true],
    ['another round', 'build-finished', 'another-round', '2 h', ENGINEER, true],
    ['a spec run', 'spec-ready', 'start-spec', '6 h', 'Kata itself', false],
    ['a review started by hand', 'build-finished', 'run-review', '2 h', 'Kata itself', false],
  ] as const)('limits are set where they are set today: %s (R17.3)', async (_name, stage, action, value, source, asks) => {
    const change = stage === 'spec-ready' ? PHOTOS_CHANGE : BUILD;
    const { vm, preview } = await staged(stage, change);
    // A document run waits for the engineer's answer to its preview, so the call is not awaited.
    void vm.act(action);
    await previewReady(preview);
    // The shown limit is read-only text; the only field that sets it is the build's time limit, and only a build or a round asks for it.
    expect(limit(preview)).toEqual({ label: 'Time limit', value, source });
    expect(preview.buildForm() !== null).toBe(asks);
    expect(preview.settings().find((s) => s.label === 'Turn cap')!.value).toBe('none');
    expect(preview.settings().find((s) => s.label === 'Spending ceiling')!.value).toBe('none');
  });

  it('the time limit the engineer sets in the preview is the limit shown and the one the build gets', async () => {
    const { vm, preview } = await staged('build-ready');
    await vm.act('start-build');
    await previewReady(preview);
    preview.buildForm()!.model.update((m) => ({ ...m, hours: 1, minutes: 30 }));
    expect(limit(preview)).toMatchObject({ value: '1 h 30 min' });
    await startPreview(preview, vm);
    expect(TestBed.inject(BuildPageViewModel).current()!.timeoutSecs).toBe(5400);
  });

  it('Start run waits while the time limit is zero', async () => {
    const { vm, preview } = await staged('build-ready');
    await vm.act('start-build');
    await previewReady(preview);
    preview.buildForm()!.model.update((m) => ({ ...m, hours: 0, minutes: 0 }));
    expect(preview.canStart()).toBe(false);
    preview.start();
    expect(preview.isOpen()).toBe(true);
    expect(TestBed.inject(BuildPageViewModel).current()).toBeNull();
  });

  describe('runs started during a build open pre-set to the build\'s choices (R12.1)', () => {
    const buildOff = () => new Set([GITHUB]);

    it('continuing every stopped repository: those repositories\' next runs and every run the build then starts by itself', async () => {
      const { vm, preview, givens } = await staged('build-stopped');
      givens.setBuild(KEY, { off: buildOff() });
      await vm.act('continue-build');
      await previewReady(preview);
      expect(preview.title()).toBe('Continue build');
      expect(flat(preview.groups()).find((r) => r.item.id === GITHUB)).toMatchObject({ off: true, mark: 'build' });
      preview.toggle(GITHUB, false);
      await startPreview(preview, vm);
      expect(givens.build(KEY)!.off.has(GITHUB)).toBe(false);
      expect(TestBed.inject(BuildPageViewModel).current()!.choices!.off.has(GITHUB)).toBe(false);
    });

    it('another round in one repository: that round and every run the build then starts by itself', async () => {
      const { vm, preview, givens } = await staged('build-finished');
      givens.setBuild(KEY, { off: buildOff() });
      await vm.act('another-round');
      await previewReady(preview);
      expect(preview.title()).toBe('Start round');
      expect(flat(preview.groups()).find((r) => r.item.id === GITHUB)).toMatchObject({ off: true, mark: 'build' });
      // Only the repository the round is picked for shows its section.
      expect(preview.sections()!.map((s) => s.title)).toEqual([]);
      preview.buildForm()!.model.update((m) => ({ ...m, instructions: 'tidy up', repo: 'commerce-core' }));
      expect(preview.sections()!.map((s) => s.title)).toEqual(['commerce-core']);
      preview.toggle(GITHUB, false);
      await startPreview(preview, vm);
      expect(TestBed.inject(BuildPageViewModel).current()!.round).toEqual({ instructions: 'tidy up', repo: 'commerce-core' });
      expect(givens.build(KEY)!.off.has(GITHUB)).toBe(false);
      expect(TestBed.inject(BuildPageViewModel).current()!.choices!.off.has(GITHUB)).toBe(false);
    });

    it('a review started by hand: that review only, the build\'s choices are not changed', async () => {
      const { vm, preview, givens } = await staged('build-finished');
      givens.setBuild(KEY, { off: buildOff() });
      await vm.act('run-review');
      await previewReady(preview);
      expect(preview.title()).toBe('Run review');
      expect(flat(preview.groups()).find((r) => r.item.id === GITHUB)).toMatchObject({ off: true, mark: 'build' });
      preview.toggle(GITHUB, false);
      await startPreview(preview, vm);
      expect(TestBed.inject(BuildPageViewModel).current()!.choices!.off.has(GITHUB)).toBe(false);
      expect(givens.build(KEY)!.off).toEqual(buildOff());
      expect(TestBed.inject(BuildPageViewModel).current()!.round).toBeNull();
    });
  });

  it('the stage Run review button opens the review preview and prepares nothing until Start run', async () => {
    const { vm, preview, prepare } = await staged('build-finished');
    expect(vm.actions()).toContain('run-review');
    await vm.act('run-review');
    await previewReady(preview);
    expect(preview.title()).toBe('Run review');
    expect(preview.sections()!.map((s) => s.title)).toEqual(['Review']);
    expect(preview.safetyRules()).toEqual(safetyRules('review'));
    expect(preview.buildForm()).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
    await startPreview(preview, vm);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(TestBed.inject(BuildPageViewModel).current()!.round).toBeNull();
    // The review is the stage button's and the done dialog's one path: it runs with Kata's review limit.
    expect(TestBed.inject(BuildPageViewModel).current()!.timeoutSecs).toBe(7200);
  });
});

const link = (repo: string, over: Partial<PrLink> = {}): PrLink => ({ repo, url: `https://github.com/acme/${repo}/pull/7`, state: 'open', seenAt: 1790000000, ...over });
const view = (over: Partial<DoneView> = {}): DoneView => ({ done: true, links: [], linksFrom: 'saved', offerDeclare: false, prCheckFailed: false, ...over });
const forever = () => new Promise<never>(() => undefined);

describe('ChangePageViewModel reads one change', () => {
  it('reads only its own change (R4.1)', async () => {
    const transport = new MockTransport();
    const one = vi.spyOn(transport, 'sdlcReadChange');
    const names = vi.spyOn(transport, 'sdlcChangeNames');
    const pass = vi.spyOn(transport, 'sdlcReadStages');
    const { vm } = setup(PHOTOS_CHANGE, transport);
    await ready(vm);
    expect(one).toHaveBeenCalledTimes(1);
    expect(one).toHaveBeenCalledWith(expect.any(String), 'commerce', PHOTOS_CHANGE);
    expect(names).not.toHaveBeenCalled();
    expect(pass).not.toHaveBeenCalled();
    expect(vm.change()).toEqual(await transport.sdlcReadChange('', 'commerce', PHOTOS_CHANGE));
    expect(vm.docName()).toBe('spec.md');
    expect(vm.doc()).toContain('# Spec: photo upload');
    expect(vm.actions()).toEqual(actionsFor(vm.change()!.stage));
  });

  it('reads the change itself while the home pass is still going (R4.2)', async () => {
    const transport = new MockTransport();
    const pass = vi.spyOn(transport, 'sdlcReadStages').mockImplementation(forever);
    const { vm } = setup(PHOTOS_CHANGE, transport);
    const store = TestBed.inject(SdlcStagesStore);
    store.markChecking('acme-commerce');
    await ready(vm);
    expect(vm.state()).toBe('ready');
    expect(pass).not.toHaveBeenCalled();
    const row = store.rows(vm.current()!.id)[stageKey('commerce', PHOTOS_CHANGE)];
    expect(row?.info?.change).toBe(PHOTOS_CHANGE);
    expect(row?.info?.stage).toBe(vm.change()!.stage);
    expect(row?.checking).toBe(false);
  });
});

describe('ChangePageViewModel shows lasting links', () => {
  const finishedBuild = (transport: MockTransport) => withStage(transport, MOCK_BUILD_CHANGE, 'build-finished');

  it('a done change shows its saved links after a restart (R8.1)', async () => {
    const transport = new MockTransport();
    finishedBuild(transport);
    const done = vi.spyOn(transport, 'sdlcDoneView').mockResolvedValue(view({ links: [link('commerce-core'), link('customer-portal')] }));
    vi.spyOn(transport, 'sdlcRefreshPrStates').mockImplementation(forever);
    const { vm } = setup(MOCK_BUILD_CHANGE, transport);
    await ready(vm);
    expect(done.mock.calls[0][5]).toBe(true);
    expect(vm.done()).toBe(true);
    expect(vm.pullLinks().map((l) => l.repo)).toEqual(['commerce-core', 'customer-portal']);
    expect(vm.actions()).toEqual([]);
  });

  it.each([
    ['every pull request still open', ['open', 'open'], false],
    ['one merged and the rest open', ['merged', 'open'], false],
    ['every pull request merged', ['merged', 'merged'], false],
    ['one closed without merging', ['closed', 'open'], false],
    ['GitHub cannot be asked', ['open', 'merged'], true],
  ] as const)('updates link states in the background (R8.2): %s', async (_row, states, stale) => {
    const transport = new MockTransport();
    finishedBuild(transport);
    const saved = [link('commerce-core'), link('customer-portal')];
    vi.spyOn(transport, 'sdlcDoneView').mockResolvedValue(view({ links: saved }));
    const fresh = saved.map((l, i) => ({ ...l, state: states[i], seenAt: stale ? 1790000000 : Math.floor(Date.now() / 1000) + 60 }));
    let answer!: (v: DoneView) => void;
    vi.spyOn(transport, 'sdlcRefreshPrStates').mockReturnValue(new Promise<DoneView>((r) => (answer = r)));
    const { vm } = setup(MOCK_BUILD_CHANGE, transport);
    await ready(vm);
    expect(vm.done()).toBe(true);
    expect(vm.pullLinks().every((l) => l.seen === null)).toBe(true);
    answer(view({ links: fresh }));
    await vi.waitFor(() => expect(vm.pullLinks().map((l) => l.state)).toEqual(states));
    expect(vm.done()).toBe(true);
    expect(vm.pullLinks().map((l) => l.seen !== null)).toEqual([stale, stale]);
  });

  it('keeps the saved links and says when they were last seen when the refresh fails (R8.2)', async () => {
    const transport = new MockTransport();
    finishedBuild(transport);
    vi.spyOn(transport, 'sdlcDoneView').mockResolvedValue(view({ links: [link('commerce-core')] }));
    vi.spyOn(transport, 'sdlcRefreshPrStates').mockRejectedValue(new Error('offline'));
    const { vm } = setup(MOCK_BUILD_CHANGE, transport);
    await ready(vm);
    await vi.waitFor(() => expect(vm.pullLinks()[0].seen).not.toBeNull());
    expect(vm.done()).toBe(true);
    expect(vm.pullLinks()[0].state).toBe('open');
  });
});
