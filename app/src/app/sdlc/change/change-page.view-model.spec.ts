import { Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import type { ChangeInfo } from '../../lib/sdlc-mock-types';
import type { CopyRemoval } from '@bindings/CopyRemoval';
import type { PullRequestLink } from '@bindings/PullRequestLink';
import type { PullRequestsView } from '@bindings/PullRequestsView';
import type { RemoveOutcome } from '@bindings/RemoveOutcome';
import type { RunSpec } from '@bindings/RunSpec';
import { toastState } from '@spartan-ng/brain/sonner';
import { BehaviorSubject } from 'rxjs';
import { LockStore } from '../../core/lock/lock.store';
import { ChangeRunStore, changeRunKey } from '../../core/run/change-run.store';
import { GivenStore } from '../../core/given/given.store';
import { RunPreviewViewModel } from '../../core/given/run-preview.view-model';
import { SdlcRunner } from '../../core/sdlc/sdlc-runner';
import { seedSpec } from '../../lib/mock';
import { KataTransport } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import { givenKey, markLabel, type KindGroup, type PresetRow } from '../../lib/given';
import { safetyRules, type StageAction } from '../../lib/sdlc';
import { MOCK_BUILD_CHANGE, MOCK_COPY_CHANGE, MOCK_COPY_FIX, MOCK_DONE_CHANGE, MOCK_NOT_LISTED, MOCK_REFUSED_CHANGE, MOCK_WORKSPACE_FOLDER } from '../../lib/sdlc-mock';
import { BuildPageViewModel } from '../build/build-page.view-model';
import { ChangePageViewModel } from './change-page.view-model';

/** Hold the lock the way Kata's own checks do, and never finish: the screen stays locked for the rest of the test. */
const holdLock = (lock: LockStore): void => void lock.runSteps('Checking', [{ label: 'Check', run: () => new Promise<string | null>(() => undefined) }]);

const PHOTOS_CHANGE = '2026-10-12-product-photo-upload';
const FRAUD = '2026-10-16-price-flag';
const REASSIGN = '2026-10-09-merchant-reassign';
const NO_PLACE = 'Could not find where this change lives: the ai-sdlc program could not run: boom';
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
/** The build the backend hosts keeps running after the engineer goes back to the change; stop it and wait for the backend to say it stopped. */
const settleBuild = async () => {
  TestBed.inject(BuildPageViewModel).cancelBuild();
  await vi.waitFor(() => {
    TestBed.tick();
    expect(TestBed.inject(BuildPageViewModel).active()).toBe(false);
  });
};
const withStage = (transport: MockTransport, name: string, stage: ChangeInfo['stage'], extra: Partial<ChangeInfo> = {}) => {
  transport.patchChange(name, { stage, ...extra });
};

/** The reassign change at plan-ready, where the plugin offers Reopen spec. */
const planReady = () => {
  const transport = new MockTransport();
  withStage(transport, REASSIGN, 'plan-ready');
  return transport;
};

afterEach(() => toastState.reset());

describe('ChangePageViewModel', () => {
  it.each([FRAUD, PHOTOS_CHANGE, REASSIGN])('offers exactly the actions the plugin lists for %s', async (name) => {
    const { vm, transport } = setup(name);
    await ready(vm);
    expect(vm.state()).toBe('ready');
    expect(vm.change()?.state.change).toBe(name);
    const answer = await transport.sdlcChangeState(MOCK_WORKSPACE_FOLDER, 'commerce', name);
    expect(vm.actions()).toEqual(answer.offer.actions.map((a) => a.action));
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
    expect(read).toHaveBeenCalledWith({ workspace: MOCK_WORKSPACE_FOLDER, system: 'commerce', change: PHOTOS_CHANGE }, 'spec');
  });

  it('a message typed and the tab opened on a change come back when its page is opened again (R13.6)', async () => {
    setup(PHOTOS_CHANGE);
    const open = () => Injector.create({ parent: TestBed.inject(Injector), providers: [ChangePageViewModel, BuildPageViewModel, RunPreviewViewModel] });
    const first = open();
    const before = first.get(ChangePageViewModel);
    await ready(before);
    await before.showDoc('intent');
    before.setMessageDraft('also cover the empty cart');
    first.destroy();
    const second = open();
    const after = second.get(ChangePageViewModel);
    await ready(after);
    await vi.waitFor(() => {
      TestBed.tick();
      expect(after.shownDoc()).toBe('intent');
    });
    expect(after.messageDraft()).toBe('also cover the empty cart');
    second.destroy();
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
    const realChanges = transport.sdlcChangeState.bind(transport);
    let reloading!: () => void;
    const started = new Promise<void>((r) => (reloading = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.spyOn(transport, 'sdlcChangeState').mockImplementation(async (m, sys, n) => {
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
    expect(vm.change()!.offer.stage).toBe('plan-ready');
    expect(vm.shownDoc()).toBe('spec');
    expect(vm.doc()).toContain('# Spec: photo upload');
  });

  it('shows the backend message and no document when the picked one cannot be read', async () => {
    const transport = new MockTransport();
    const { vm } = setup(PHOTOS_CHANGE, transport);
    await ready(vm);
    vi.spyOn(transport, 'sdlcReadDoc').mockRejectedValue('permission denied');
    await vm.showDoc('intent');
    expect(vm.shownDoc()).toBe('intent');
    expect(vm.docName()).toBe('intent.md');
    expect(vm.doc()).toBeNull();
    expect(vm.docNotice()?.text).toBe('permission denied');
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
    expect(vm.shownDoc()).toBe('spec');
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
    await vi.waitFor(() => expect(vm.change()?.state.change).toBe(FRAUD));
    expect(vm.docName()).toBe('intent.md');
  });

  describe('accepting and rejecting go through the plugin', () => {
    const ref = (change: string) => ({ workspace: 'D:/Work/acme-commerce', system: 'commerce', change });

    it('accept-spec asks the plugin to accept the spec, and the reloaded stage is plan-ready', async () => {
      const { vm, transport } = setup(PHOTOS_CHANGE);
      const accept = vi.spyOn(transport, 'sdlcAccept');
      await ready(vm);
      await vm.act('accept-spec');
      expect(accept).toHaveBeenCalledWith(ref(PHOTOS_CHANGE), 'spec');
      expect(toastText()).toContain('Accepted spec · committed');
      expect(vm.change()?.offer.stage).toBe('plan-ready');
      expect(vm.actions()).toEqual(['start-plan', 'reopen-spec', 'reopen-intent', 'rename']);
    });

    it('accept plan opens the build (R1.2)', async () => {
      const { vm, transport } = setup(REASSIGN);
      const accept = vi.spyOn(transport, 'sdlcAccept');
      await ready(vm);
      expect(vm.primary()).toBe('accept-plan');
      await vm.act('accept-plan');
      expect(accept).toHaveBeenCalledWith(ref(REASSIGN), 'plan');
      expect(toastText()).toContain('Accepted plan · committed');
      expect(vm.change()?.offer.stage).toBe('build-ready');
    });

    it('accept-intent moves a draft intent on to spec-ready', async () => {
      const { vm, transport } = setup(FRAUD);
      const accept = vi.spyOn(transport, 'sdlcAccept');
      await ready(vm);
      await vm.act('accept-intent');
      expect(accept).toHaveBeenCalledWith(ref(FRAUD), 'intent');
      expect(vm.change()?.offer.stage).toBe('spec-ready');
    });

    it.each([
      ['intent-accepted-uncommitted', 'intent'],
      ['spec-accepted-uncommitted', 'spec'],
    ] as const)('commit-acceptance at %s accepts the %s', async (stage, doc) => {
      const transport = new MockTransport();
      withStage(transport, PHOTOS_CHANGE, stage);
      const { vm } = setup(PHOTOS_CHANGE, transport);
      const accept = vi.spyOn(transport, 'sdlcAccept');
      await ready(vm);
      expect(vm.actions()[0]).toBe('commit-acceptance');
      await vm.act('commit-acceptance');
      expect(accept.mock.calls[0][1]).toBe(doc);
    });

    it('commit-acceptance on a plan accepted but not committed accepts the plan', async () => {
      const transport = new MockTransport();
      withStage(transport, REASSIGN, 'plan-accepted-uncommitted');
      const { vm } = setup(REASSIGN, transport);
      const accept = vi.spyOn(transport, 'sdlcAccept');
      await ready(vm);
      await vm.act('commit-acceptance');
      expect(accept.mock.calls[0][1]).toBe('plan');
    });

    it('a team hook that fails shows the hook and its output, and the acceptance stays committed', async () => {
      const { vm, transport } = setup(PHOTOS_CHANGE);
      vi.spyOn(transport, 'sdlcAccept').mockResolvedValue({ outcome: 'acceptedHookFailed', hook: 'docs-lint', output: 'lint says no', problems: [] });
      await ready(vm);
      await vm.act('accept-spec');
      expect(toastText()).toContain('Accepted spec and committed it, but the hook docs-lint failed.');
      expect(toastText()).toContain('lint says no');
    });

    it("an acceptance that passed with warnings says so, with the plugin's warnings (F22)", async () => {
      const { vm, transport } = setup(PHOTOS_CHANGE);
      const warning = 'after hook announce failed with exit code 1; nothing was undone';
      vi.spyOn(transport, 'sdlcAccept').mockResolvedValue({ outcome: 'accepted', warnings: [warning] });
      await ready(vm);
      await vm.act('accept-spec');
      expect(toastText()).toContain('Accepted spec · committed, with warnings from the plugin.');
      expect(toastText()).toContain(warning);
    });

    it('hooks that could not run are said, with their output', async () => {
      const { vm, transport } = setup(PHOTOS_CHANGE);
      vi.spyOn(transport, 'sdlcAccept').mockResolvedValue({ outcome: 'acceptedHookCouldNotRun', output: 'no such program' });
      await ready(vm);
      await vm.act('accept-spec');
      expect(toastText()).toContain('could not run the hooks on accepting');
      expect(toastText()).toContain('no such program');
    });

    it('shows each problem of a commit the plugin refused, with its file and line', async () => {
      const { vm, transport } = setup(PHOTOS_CHANGE);
      vi.spyOn(transport, 'sdlcAccept').mockResolvedValue({ outcome: 'notCommitted', problems: ['D:/ws/spec.md:12: a requirement has no ID'] });
      await ready(vm);
      await vm.act('accept-spec');
      expect(toastText()).toContain('The spec was not committed.');
      expect(toastText()).toContain('D:/ws/spec.md:12: a requirement has no ID');
    });

    it('reject-intent asks the plugin, says once where the record stays and goes back to the workspace', async () => {
      const { vm, transport, navigate } = setup(FRAUD);
      const reject = vi.spyOn(transport, 'sdlcReject');
      await ready(vm);
      await vm.act('reject-intent');
      expect(reject).toHaveBeenCalledTimes(1);
      expect(reject).toHaveBeenCalledWith(ref(FRAUD));
      expect(toastText()).toContain(`Rejected. Its record stays on branch \`change/${FRAUD}\`.`);
      expect(navigate).toHaveBeenCalledWith(['/sdlc']);
    });

    it('a fix is rejected from its page too', async () => {
      const transport = new MockTransport();
      withStage(transport, PHOTOS_CHANGE, 'fix-awaiting', { track: 'fix', fix_row: 6 });
      const { vm, navigate } = setup(PHOTOS_CHANGE, transport);
      const reject = vi.spyOn(transport, 'sdlcReject');
      await ready(vm);
      expect(vm.actions()).toContain('reject-fix');
      expect(vm.labelOf('reject-fix')).toBe('Reject fix');
      await vm.act('reject-fix');
      expect(reject).toHaveBeenCalledWith(ref(PHOTOS_CHANGE));
      expect(navigate).toHaveBeenCalledWith(['/sdlc']);
    });

    it.each([
      ['the plugin refuses it', { outcome: 'refused' as const, message: 'has build work' }, 'has build work'],
      ['a git hook refuses the commit', { outcome: 'notCommitted' as const, problems: ['hook says no'] }, 'hook says no'],
      ['the copy is not removed', { outcome: 'rejectedNotRemoved' as const, problems: ['notes.txt is not committed'] }, 'notes.txt is not committed'],
      ['the plugin cannot run', { outcome: 'couldNotRun' as const, message: 'node is missing' }, 'node is missing'],
    ])('a rejection where %s shows the plugin\'s words and stays on the page', async (_why, outcome, text) => {
      const { vm, transport, navigate } = setup(FRAUD);
      vi.spyOn(transport, 'sdlcReject').mockResolvedValue(outcome);
      await ready(vm);
      await vm.act('reject-intent');
      expect(toastText()).toContain(text);
      expect(navigate).not.toHaveBeenCalled();
    });
  });

  describe('runs', () => {
    const specOf = (runAgent: { mock: { calls: unknown[][] } }) => runAgent.mock.calls[0][1] as RunSpec;

    it('a revisit asks for feedback first and runs nothing until the operator confirms', async () => {
      const { vm, runAgent } = setup(REASSIGN, planReady());
      await ready(vm);
      await vm.act('reopen-spec');
      expect(vm.feedbackFor()).toBe('Reopen spec');
      expect(runAgent).not.toHaveBeenCalled();
      vm.cancelFeedback();
      expect(vm.feedbackFor()).toBeNull();
      expect(runAgent).not.toHaveBeenCalled();
    });

    it('reopen spec runs the spec skill with the confirmation and the operator feedback', async () => {
      const { vm, runAgent } = setup(REASSIGN, planReady());
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
      const { vm, runAgent, preview } = setup(REASSIGN, planReady(), 'real');
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
    await vm.runWithFeedback('Cover refunds too.');
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
      const changes = vi.spyOn(transport, 'sdlcChangeState');
      await vm.act('start-spec');
      expect(runAgent).toHaveBeenCalled();
      expect(changes).toHaveBeenCalled();
    });

    it('refuses a second task while the lock is held', async () => {
      const { vm, runAgent, transport } = setup(PHOTOS_CHANGE);
      await ready(vm);
      const decide = vi.spyOn(transport, 'sdlcAccept');
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
    const REF = { workspace: MOCK_WORKSPACE_FOLDER, system: 'commerce', change: BUILD };
    const build = () => TestBed.inject(BuildPageViewModel);

    it('Start build, Continue build and Another round open the dialog in their own mode', async () => {
      const transport = new MockTransport();
      withStage(transport, BUILD, 'build-stopped');
      const { vm } = setup(BUILD, transport);
      await ready(vm);
      expect(build().dialogMode()).toBeNull();
      await vm.act('continue-build');
      expect(build().dialogMode()).toBe('continue');
      build().cancelPreview();
      await vi.waitFor(() => expect(build().dialogMode()).toBeNull());
      await vm.act('another-round');
      await vi.waitFor(() => expect(build().dialogMode()).toBe('round'));
      expect(build().roundOffer()?.repos).toEqual(['commerce-core', 'customer-portal', 'commerce-docs']);
      build().cancelPreview();
    });

    it('Start build opens the preview of what the backend would run and starts nothing yet', async () => {
      const { vm, transport } = setup(BUILD);
      const start = vi.spyOn(transport, 'sdlcBuildStart');
      const previewed = vi.spyOn(transport, 'sdlcPreviewBuild');
      await ready(vm);
      await vm.act('start-build');
      expect(build().dialogMode()).toBe('start');
      await vi.waitFor(() => expect(previewed).toHaveBeenCalledWith(REF, 'start', null, { timeoutSecs: 7200 }));
      expect(start).not.toHaveBeenCalled();
      build().cancelPreview();
    });

    it('a confirmed Start build sends the form to the backend and shows the Build tab', async () => {
      const { vm, transport, preview } = setup(BUILD, new MockTransport(), 'real');
      const start = vi.spyOn(transport, 'sdlcBuildStart');
      await ready(vm);
      await vm.act('start-build');
      await previewReady(preview);
      preview.start();
      await vi.waitFor(() => expect(start).toHaveBeenCalledWith(REF, { timeoutSecs: 7200 }));
      await vi.waitFor(() => expect(vm.shownDoc()).toBe('build'));
      expect(build().started()).toBe(true);
      await settleBuild();
    });

    it('a refusal by the plugin lists its problems for every repository, starts nothing and leaves the tab alone (R8.1)', async () => {
      const { vm, transport, preview } = setup(BUILD, new MockTransport(), 'real');
      const problems = ['commerce-core: a build log does not pass the check', 'customer-portal: uncommitted files: a.txt'];
      vi.spyOn(transport, 'sdlcBuildStart').mockResolvedValue({ kind: 'refused', problems });
      await ready(vm);
      const tab = vm.shownDoc();
      await vm.act('start-build');
      await previewReady(preview);
      preview.start();
      await vi.waitFor(() => expect(build().refusal()).toMatchObject({ problems }));
      expect(build().started()).toBe(false);
      expect(vm.shownDoc()).toBe(tab);
      build().closeRefusal();
      expect(build().refusal()).toBeNull();
    });

    it('names the workspace, folder, system, change and every product repository of the system for the build view (R18.5)', async () => {
      const { vm, transport } = setup(BUILD);
      await ready(vm);
      const w = (await transport.sdlcWorkspaces())[0];
      expect(vm.buildContext()).toEqual({ workspaceId: w.id, folder: w.folder, system: 'commerce', change: BUILD, systemRepos: ['commerce-core', 'customer-portal', 'billing-api'] });
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
      await transport.sdlcDeclareDone({ workspace: 'f', system: 'commerce', change: BUILD });
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
      await TestBed.inject(BuildPageViewModel).startBuild({ timeoutSecs: 5400 });
      expect(TestBed.inject(BuildPageViewModel).started()).toBe(true);
      expect(vm.pills().length).toBe(4);
      expect(vm.pullLinks().length).toBe(3);
      await settleBuild();
    });

    it('lists each pull request that has an address, with its number', async () => {
      const { vm } = setup(BUILD, await finished());
      await ready(vm);
      const links = vm.pullLinks();
      expect(links.map((l) => l.repo)).toEqual(['commerce-core', 'customer-portal', 'commerce-docs']);
      expect(links.every((l) => l.url.startsWith('https://') && /^\d+$/.test(l.number ?? ''))).toBe(true);
    });

    it('has no pills and no pull request links while a skill run holds the page', async () => {
      const { vm } = setup(BUILD, await finished());
      const lock = TestBed.inject(LockStore);
      vi.spyOn(lock, 'active').mockReturnValue({ kind: 'run', title: 'Starting spec', finished: null });
      vi.spyOn(lock, 'spec').mockReturnValue({} as RunSpec);
      await ready(vm);
      expect(vm.session()).not.toBeNull();
      expect(vm.change()?.offer.stage).toBe('build-finished');
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
      vi.spyOn(transport, 'sdlcBranches').mockResolvedValue({ current: `change/${PHOTOS_CHANGE}`, others: [], default_base: 'main' });
      const { vm } = setup(PHOTOS_CHANGE, transport);
      await ready(vm);
      expect(vm.masterBranch()).toBe(`change/${PHOTOS_CHANGE}`);
      expect(vm.branchChip()).toBeNull();
    });

    describe('a change on a recorded branch (R7.1)', () => {
      const RECORDED = 'feat/PROJ-123-password-reset';
      const recorded = (current: string) => {
        const transport = new MockTransport();
        vi.spyOn(transport, 'sdlcBranches').mockResolvedValue({ current, others: [], default_base: 'main' });
        const real = transport.sdlcChangeRepos.bind(transport);
        vi.spyOn(transport, 'sdlcChangeRepos').mockImplementation(async (...args) => (await real(...args)).map((r) => ({ ...r, branch: RECORDED })));
        return transport;
      };

      it('hides the branch chip when the master repository is on the recorded branch', async () => {
        const { vm } = setup(PHOTOS_CHANGE, recorded(RECORDED));
        await ready(vm);
        expect(vm.masterBranch()).toBe(RECORDED);
        expect(vm.branchChip()).toBeNull();
        expect(vm.expectedBranch()).toBe(RECORDED);
      });

      it('names the recorded branch as expected when the master repository is on another branch', async () => {
        const { vm } = setup(PHOTOS_CHANGE, recorded('main'));
        await ready(vm);
        expect(vm.branchChip()).toBe('main');
        expect(vm.expectedBranch()).toBe(RECORDED);
      });

      it('expects change/<change> for a change with no record', async () => {
        const { vm } = setup(PHOTOS_CHANGE);
        await ready(vm);
        expect(vm.expectedBranch()).toBe(`change/${PHOTOS_CHANGE}`);
      });
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
      expect(vm.actions()).toEqual(['continue-build', 'another-round', 'reopen-spec', 'reopen-intent', 'rename']);
    });

    it('offers Reopen intent and Reopen spec once each on the build step of a full-pipeline change (R1.2)', async () => {
      const transport = new MockTransport();
      withStage(transport, BUILD, 'build-finished');
      const { vm } = setup(BUILD, transport);
      await ready(vm);
      expect(vm.actions().filter((a) => a === 'reopen-intent')).toHaveLength(1);
      expect(vm.actions().filter((a) => a === 'reopen-spec')).toHaveLength(1);
      expect(vm.barExtras().map((e) => e.action)).toEqual(['reopen-spec', 'reopen-intent', 'rename']);
    });

    it('leaves the reopen actions to the change page at build-ready, offering each once in the change\'s order (R1.2)', async () => {
      const { vm } = setup(BUILD);
      await ready(vm);
      expect(vm.change()!.offer.stage).toBe('build-ready');
      expect(TestBed.inject(BuildPageViewModel).actions()).not.toContain('reopen-intent');
      expect(vm.actions()).toEqual(['start-build', 'reopen-spec', 'reopen-intent', 'rename']);
      expect(vm.barExtras().map((e) => e.action)).toEqual(['reopen-spec', 'reopen-intent', 'rename']);
    });

    it('turns both reopen actions off at build-ready while a check of Kata holds the lock (R1.3)', async () => {
      const { vm } = setup(BUILD);
      await ready(vm);
      expect(vm.change()!.offer.stage).toBe('build-ready');
      expect(vm.disabledFor('reopen-intent')).toBe(false);
      expect(vm.disabledFor('reopen-spec')).toBe(false);
      holdLock(TestBed.inject(LockStore));
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
      holdLock(TestBed.inject(LockStore));
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
    return { ...s, givens: TestBed.inject(GivenStore), prepare: vi.spyOn(transport, 'sdlcBuildStart'), reviewStart: vi.spyOn(transport, 'sdlcReviewStart') };
  };
  /** Wait for the preview and for the backend's plan of a round, press Start run, and wait for the start to reach the backend. */
  const startPreview = async (preview: RunPreviewViewModel, started: { mock: { calls: unknown[] } }) => {
    await previewReady(preview);
    await vi.waitFor(() => expect(preview.canStart()).toBe(true));
    preview.start();
    await vi.waitFor(() => expect(started.mock.calls.length).toBeGreaterThan(0));
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
    const { vm, preview, givens, prepare } = await staged('build-ready');
    await vm.act('start-build');
    await previewReady(preview);
    preview.toggle(GITHUB, true);
    preview.toggle(dbKey(vm, 'commerce-core'), true);
    await startPreview(preview, prepare);
    // The page keeps the choices for the build, and the next build starts from them.
    expect(givens.build(KEY)!.off).toEqual(new Set([GITHUB, dbKey(vm, 'commerce-core')]));
    // and the host starts every run with them off
    expect(prepare.mock.calls[0][1]).toEqual({ timeoutSecs: 7200, off: expect.arrayContaining([GITHUB, dbKey(vm, 'commerce-core')]) });
  });

  it('cancelling the build\'s preview starts nothing and leaves the build\'s choices alone', async () => {
    const { vm, preview, prepare, givens } = await staged('build-ready');
    await vm.act('start-build');
    await previewReady(preview);
    preview.toggle(GITHUB, true);
    preview.cancel();
    await vi.waitFor(() => expect(TestBed.inject(BuildPageViewModel).dialogMode()).toBeNull());
    expect(prepare).not.toHaveBeenCalled();
    expect(givens.build(KEY)).toBeNull();
    expect(TestBed.inject(BuildPageViewModel).started()).toBe(false);
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
    const { vm, preview, prepare } = await staged('build-ready');
    await vm.act('start-build');
    await previewReady(preview);
    preview.buildForm()!.model.update((m) => ({ ...m, hours: 1, minutes: 30 }));
    expect(limit(preview)).toMatchObject({ value: '1 h 30 min' });
    await startPreview(preview, prepare);
    expect(prepare.mock.calls[0][1]).toEqual({ timeoutSecs: 5400 });
  });

  it('Start run waits while the time limit is zero', async () => {
    const { vm, preview, prepare } = await staged('build-ready');
    await vm.act('start-build');
    await previewReady(preview);
    preview.buildForm()!.model.update((m) => ({ ...m, hours: 0, minutes: 0 }));
    expect(preview.canStart()).toBe(false);
    preview.start();
    expect(preview.isOpen()).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
  });

  describe('runs started during a build open pre-set to the build\'s choices (R12.1)', () => {
    const buildOff = () => new Set([GITHUB]);

    it('continuing every stopped repository: those repositories\' next runs and every run the build then starts by itself', async () => {
      const { vm, preview, givens, prepare } = await staged('build-stopped');
      givens.setBuild(KEY, { off: buildOff() });
      await vm.act('continue-build');
      await previewReady(preview);
      expect(preview.title()).toBe('Continue build');
      expect(flat(preview.groups()).find((r) => r.item.id === GITHUB)).toMatchObject({ off: true, mark: 'build' });
      preview.toggle(GITHUB, false);
      await startPreview(preview, prepare);
      expect(givens.build(KEY)!.off.has(GITHUB)).toBe(false);
    });

    it('another round in one repository: that round and every run the build then starts by itself', async () => {
      const { vm, preview, givens, prepare } = await staged('build-finished');
      givens.setBuild(KEY, { off: buildOff() });
      await vm.act('another-round');
      await previewReady(preview);
      expect(preview.title()).toBe('Start round');
      expect(flat(preview.groups()).find((r) => r.item.id === GITHUB)).toMatchObject({ off: true, mark: 'build' });
      // Only a repository that gets an agent shows its section.
      expect(preview.sections()!.map((s) => s.title)).toEqual([]);
      preview.buildForm()!.model.update((m) => ({ ...m, notes: { ...m.notes, 'commerce-core': 'tidy up' } }));
      await vi.waitFor(() => expect(preview.sections()!.map((s) => s.title)).toEqual(['commerce-core']));
      preview.toggle(GITHUB, false);
      await startPreview(preview, prepare);
      const rounds = prepare.mock.calls[0][1].rounds!;
      expect(rounds.map((r) => r.repo)).toEqual(['commerce-core']);
      expect(rounds[0].instructions).toContain('tidy up');
      expect(givens.build(KEY)!.off.has(GITHUB)).toBe(false);
    });

    it('a review started by hand: that review only, the build\'s choices are not changed', async () => {
      const { vm, preview, givens, reviewStart } = await staged('build-finished');
      givens.setBuild(KEY, { off: buildOff() });
      await vm.act('run-review');
      await previewReady(preview);
      expect(preview.title()).toBe('Run review');
      expect(flat(preview.groups()).find((r) => r.item.id === GITHUB)).toMatchObject({ off: true, mark: 'build' });
      preview.toggle(GITHUB, false);
      await startPreview(preview, reviewStart);
      expect(givens.build(KEY)!.off).toEqual(buildOff());
    });
  });

  describe('another round offers the findings of the latest review', () => {
    const finding = (key: string, repo: string) => ({ key, repo, finding: { id: key, severity: 'high' as const, text: `${key} is wrong. Fix it.`, repo } });
    const offering = (transport: MockTransport, findings: ReturnType<typeof finding>[], groups = [{ repo: null as string | null, findings }]) => {
      const offer = { review: 1, repos: ['commerce-core', 'commerce-docs'], findings };
      vi.spyOn(transport, 'sdlcRoundOffer').mockResolvedValue([offer, { picked: findings.map((f) => f.key), assigned: {}, notes: {} }]);
      vi.spyOn(transport, 'sdlcReviewView').mockResolvedValue({ rows: { counts: [], total: findings.length, groups: [] }, groups });
    };

    it('a finding that names the master repository can be picked, and an agent starts there with it (R5.7)', async () => {
      const { vm, preview, transport, prepare } = await staged('build-finished');
      offering(transport, [finding('F1', 'commerce-docs')]);
      vi.spyOn(transport, 'sdlcRoundPlan').mockResolvedValue({ blocked: null, requests: [{ repo: 'commerce-docs', instructions: 'Fix F1.', summary: 'commerce-docs · F1' }] });
      await vm.act('another-round');
      await previewReady(preview);
      expect(TestBed.inject(BuildPageViewModel).roundOffer()!.findings.map((f) => f.repo)).toEqual(['commerce-docs']);
      await startPreview(preview, prepare);
      const rounds = prepare.mock.calls[0][1].rounds!;
      expect(rounds.map((r) => r.repo)).toEqual(['commerce-docs']);
      expect(rounds[0].instructions).toContain('F1');
    });

    it('hands the dialog the groups the backend lists for the same review (F2)', async () => {
      const { vm, preview, transport } = await staged('build-finished');
      const findings = [finding('F2', 'commerce-core'), finding('F1', 'commerce-core'), finding('F3', 'legacy-api')];
      const groups = [
        { repo: 'commerce-core', findings: [findings[0], findings[1]] },
        { repo: 'legacy-api', findings: [findings[2]] },
      ];
      offering(transport, findings, groups);
      await vm.act('another-round');
      await previewReady(preview);
      expect(TestBed.inject(BuildPageViewModel).roundGroups()).toEqual(groups);
    });
  });

  it('the stage Run review button opens the review preview and starts nothing until Start run', async () => {
    const { vm, preview, reviewStart } = await staged('build-finished');
    expect(vm.actions()).toContain('run-review');
    await vm.act('run-review');
    await previewReady(preview);
    expect(preview.title()).toBe('Run review');
    expect(preview.sections()!.map((s) => s.title)).toEqual(['Review']);
    expect(preview.safetyRules()).toEqual(safetyRules('review'));
    expect(preview.buildForm()).toBeNull();
    expect(reviewStart).not.toHaveBeenCalled();
    await startPreview(preview, reviewStart);
    expect(reviewStart).toHaveBeenCalledTimes(1);
  });
});

const link = (repo: string, over: Partial<PullRequestLink> = {}): PullRequestLink => ({ repo, url: `https://github.com/acme/${repo}/pull/7`, number: 7, source: 'plugin', state: null, lastSeen: false, seenAt: null, ...over });
const view = (over: Partial<PullRequestsView> = {}): PullRequestsView => ({ done: true, source: 'plugin', links: [], declareOffered: true, ...over });
const forever = () => new Promise<never>(() => undefined);

describe('ChangePageViewModel reads one change', () => {
  it('reads only its own change from the plugin (R4.1)', async () => {
    const transport = new MockTransport();
    const one = vi.spyOn(transport, 'sdlcChangeState');
    const everything = vi.spyOn(transport, 'sdlcState');
    const { vm } = setup(PHOTOS_CHANGE, transport);
    await ready(vm);
    expect(one).toHaveBeenCalledTimes(1);
    expect(one).toHaveBeenCalledWith(MOCK_WORKSPACE_FOLDER, 'commerce', PHOTOS_CHANGE);
    expect(everything).not.toHaveBeenCalled();
    const answer = await transport.sdlcChangeState(MOCK_WORKSPACE_FOLDER, 'commerce', PHOTOS_CHANGE);
    expect(vm.change()).toEqual(answer);
    expect(vm.docName()).toBe('spec.md');
    expect(vm.doc()).toContain('# Spec: photo upload');
    expect(vm.actions()).toEqual(answer.offer.actions.map((a) => a.action));
  });
});

describe('ChangePageViewModel shows lasting links', () => {
  const finishedBuild = (transport: MockTransport) => withStage(transport, MOCK_BUILD_CHANGE, 'build-finished');

  it('a done change shows its recorded links at once, without waiting for GitHub (R7.4)', async () => {
    const transport = new MockTransport();
    finishedBuild(transport);
    const asked = vi.spyOn(transport, 'sdlcPullRequestsView').mockImplementation((_f, _w, _s, _c, refresh) => (refresh ? forever() : Promise.resolve(view({ links: [link('commerce-core'), link('master')] }))));
    const { vm } = setup(MOCK_BUILD_CHANGE, transport);
    await ready(vm);
    expect(asked.mock.calls[0][4]).toBe(false);
    expect(vm.done()).toBe(true);
    expect(vm.pullLinks().map((l) => l.repo)).toEqual(['commerce-core', 'master']);
    expect(vm.pullLinks().map((l) => l.state)).toEqual(['checking', 'checking']);
    expect(vm.actions()).toEqual([]);
    await vi.waitFor(() => expect(asked.mock.calls.some((c) => c[4] === true)).toBe(true));
  });

  it.each([
    ['open', ['open', 'open'], [false, false]],
    ['merged', ['merged', 'open'], [false, false]],
    ['closed', ['closed', 'open'], [false, false]],
    ['GitHub could not be read for one', ['open', null], [false, true]],
  ] as const)('fills the link states in from the background read (R7.4): %s', async (_row, states, lastSeen) => {
    const transport = new MockTransport();
    finishedBuild(transport);
    const recorded = [link('commerce-core'), link('master')];
    let answer!: (v: PullRequestsView) => void;
    vi.spyOn(transport, 'sdlcPullRequestsView').mockImplementation((_f, _w, _s, _c, refresh) =>
      refresh ? new Promise<PullRequestsView>((r) => (answer = r)) : Promise.resolve(view({ links: recorded })),
    );
    const { vm } = setup(MOCK_BUILD_CHANGE, transport);
    await ready(vm);
    expect(vm.pullLinks().every((l) => l.seen === null)).toBe(true);
    await vi.waitFor(() => expect(answer).toBeDefined());
    answer(view({ links: recorded.map((l, i) => ({ ...l, state: states[i], lastSeen: lastSeen[i] })) }));
    await vi.waitFor(() => expect(vm.pullLinks().map((l) => l.state)).toEqual(states.map((s) => s ?? 'not read')));
    expect(vm.done()).toBe(true);
    expect(vm.pullLinks().map((l) => l.seen === 'last seen')).toEqual([...lastSeen]);
  });

  it('says the links were last seen, with no state, when the plugin cannot be asked now (R7.4)', async () => {
    const transport = new MockTransport();
    finishedBuild(transport);
    const calls: boolean[] = [];
    vi.spyOn(transport, 'sdlcPullRequestsView').mockImplementation((_f, _w, _s, _c, refresh) => {
      calls.push(refresh);
      return refresh ? Promise.reject(new Error('offline')) : Promise.resolve(view({ links: [link('commerce-core')] }));
    });
    const { vm } = setup(MOCK_BUILD_CHANGE, transport);
    await ready(vm);
    await vi.waitFor(() => expect(vm.pullLinks()[0].seen).toBe('last seen'));
    expect(vm.done()).toBe(true);
    expect(vm.pullLinks()[0].state).toBe('not read');
    expect(calls).toEqual([false, true]);
  });
});

describe('ChangePageViewModel shows the plugin report', () => {
  it('a task shows its commits and untasked commits are departures', async () => {
    const transport = new MockTransport();
    const { vm } = setup(MOCK_DONE_CHANGE, transport);
    await ready(vm);
    const answer = await transport.sdlcChangeState(MOCK_WORKSPACE_FOLDER, 'commerce', MOCK_DONE_CHANGE);
    const core = answer.state.tasks!['commerce-core']!;
    const build = TestBed.inject(BuildPageViewModel);
    await vi.waitFor(() => {
      TestBed.tick();
      expect(build.view().findingsArea.departures).not.toBeNull();
    });
    const shown = build.view();
    const t1 = shown.groups.find((g) => g.repo === 'commerce-core')!.tasks.find((t) => t.id === 'T1')!;
    expect(core.commits!['T1']).not.toEqual([]);
    expect(t1.commits).toEqual(core.commits!['T1']);
    expect(core.untasked).not.toEqual([]);
    expect(shown.findingsArea.departures).toEqual(core.untasked!.map((sha) => ({ repo: 'commerce-core', task: null, text: `Commit ${sha.slice(0, 7)} names no task.` })));
  });

  it("a refused action shows the plugin's message as it is", async () => {
    const transport = new MockTransport();
    const { vm } = setup(MOCK_REFUSED_CHANGE, transport);
    await ready(vm);
    const answer = await transport.sdlcChangeState(MOCK_WORKSPACE_FOLDER, 'commerce', MOCK_REFUSED_CHANGE);
    const stop = answer.state.ready.build.stop!;
    const refused = answer.offer.actions.find((a) => !a.enabled)!;
    expect(refused.reason).toBe(stop);
    const action = vm.actions().find((a) => a === refused.action);
    expect(action).toBe(refused.action);
    expect(vm.disabledFor(action!)).toBe(true);
    expect(vm.titleFor(action!)).toBe(stop);
    expect(vm.buildNotice()).toEqual({ tone: 'warning', text: stop, lines: [] });
  });
});

describe('ChangePageViewModel while another change builds (R11.6)', () => {
  const BUILDING = { workspace: MOCK_WORKSPACE_FOLDER, system: 'commerce', change: MOCK_BUILD_CHANGE };

  it('document actions are offered while another change builds', async () => {
    const { vm, transport, runAgent } = setup(PHOTOS_CHANGE);
    await ready(vm);
    expect((await transport.sdlcBuildStart(BUILDING, { timeoutSecs: 7200 })).kind).toBe('started');
    const runsBefore = await transport.sdlcBuildRuns(BUILDING);
    expect(runsBefore.length).toBeGreaterThan(0);
    expect(vm.actions().length).toBeGreaterThan(0);
    for (const action of vm.actions()) expect(vm.disabledFor(action), action).toBe(false);
    await vm.act('continue-spec');
    await vm.runWithFeedback('Cover refunds too.');
    expect(runAgent).toHaveBeenCalledTimes(1);
    await vm.act('accept-spec');
    expect(toastText()).not.toContain('Another task is already running.');
    expect(await transport.sdlcBuildRuns(BUILDING)).toEqual(runsBefore);
    await transport.sdlcBuildCancel(BUILDING, null);
  });
});

describe('ChangePageViewModel leaving a change (R11.6)', () => {
  it('leaving a change with a live document run does not cancel it', async () => {
    const transport = new MockTransport();
    const { vm, runAgent, navigate } = setup(PHOTOS_CHANGE, transport);
    runAgent.mockRestore();
    const cancel = vi.spyOn(transport, 'cancelRun');
    await ready(vm);
    void vm.act('start-spec');
    await vi.waitFor(() => expect(['running', 'awaiting']).toContain(vm.runState()));
    expect(vm.session()?.kind).toBe('run');
    await vm.toHome();
    expect(navigate).toHaveBeenCalledWith(['/sdlc']);
    TestBed.tick();
    expect(cancel).not.toHaveBeenCalled();
    expect(['running', 'awaiting']).toContain(vm.runState());
    vm.cancelLock();
    await vi.waitFor(() => expect(vm.session()?.finished).not.toBeNull());
    vm.closeSession();
  });
});

describe('ChangePageViewModel document runs of different changes (R11)', () => {
  const OTHER = { workspace: MOCK_WORKSPACE_FOLDER, system: 'commerce', change: MOCK_BUILD_CHANGE };
  const live = ['running', 'awaiting'];

  it("a spec run of change B starts while change A's spec run is live", async () => {
    const transport = new MockTransport();
    const { vm, runAgent } = setup(PHOTOS_CHANGE, transport);
    runAgent.mockRestore();
    const started = vi.spyOn(transport, 'sdlcRunChange');
    const cancel = vi.spyOn(transport, 'cancelRun');
    await ready(vm);
    // Change A's run goes through the runner, as its own page would start it.
    void TestBed.inject(SdlcRunner).run('Starting spec of A', { ...seedSpec(), name: 'sdlc-commerce-a-spec' }, { workspaceId: 'w', master: null, productRepos: [], link: null }, { ref: OTHER, kind: 'spec' });
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1));
    void vm.act('start-spec');
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(2));
    expect(started.mock.calls[0][0]).toEqual(OTHER);
    expect(started.mock.calls[1][0]).toMatchObject({ change: PHOTOS_CHANGE });
    // Change B's page shows its own run.
    await vi.waitFor(() => expect(vm.session()).not.toBeNull());
    expect(vm.session()!.finished).toBeNull();
    expect(live).toContain(vm.runState());
    expect(vm.session()!.title).not.toBe('Starting spec of A');
    expect(cancel).not.toHaveBeenCalled();
    expect(toastText()).not.toContain('Another task is already running.');
  });

  it("a second document run of the same change is refused by that change's own live run", async () => {
    const transport = new MockTransport();
    const { vm, runAgent } = setup(PHOTOS_CHANGE, transport);
    runAgent.mockRestore();
    const started = vi.spyOn(transport, 'sdlcRunChange');
    const cancel = vi.spyOn(transport, 'cancelRun');
    await ready(vm);
    void vm.act('start-spec');
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(vm.session()).not.toBeNull());
    await vm.act('start-spec');
    expect(toastText()).toContain('Another task is already running.');
    expect(started).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    expect(live).toContain(vm.runState());
  });

  it("a run the backend refuses says the backend's reason and leaves no session behind", async () => {
    const transport = new MockTransport();
    const { vm, runAgent } = setup(PHOTOS_CHANGE, transport);
    runAgent.mockRestore();
    vi.spyOn(transport, 'sdlcRunChange').mockRejectedValue(new Error('commerce-core is held by 2026-10-19-build-demo'));
    await ready(vm);
    await vm.act('start-spec');
    await vi.waitFor(() => expect(toastText()).toContain('commerce-core is held by 2026-10-19-build-demo'));
    expect(vm.session()).toBeNull();
  });
});

describe("ChangePageViewModel: the session view's Close waits on the run it shows (F30)", () => {
  /** A run of no change, as the home starts a triage, setup or context run: it takes the screen and settles on place null. */
  const homeRun = (master: string | null = null) =>
    TestBed.inject(SdlcRunner).run('Triage', { ...seedSpec(), name: 'sdlc-triage' }, { workspaceId: 'w', master, productRepos: [], link: null });
  /** Hold the engine's exit of the next run that waits on it, so its after-run work stays going until the test lets it go. */
  const holdExit = (transport: MockTransport) => {
    let exit!: (v: boolean) => void;
    const wait = vi.spyOn(transport, 'sdlcWaitRunExit').mockImplementationOnce(() => new Promise<boolean>((r) => (exit = r)));
    return { wait, exit: (v: boolean) => exit(v) };
  };

  it('a lock run (triage) shown on a change page holds Close while it settles, then lets it go', async () => {
    const transport = new MockTransport();
    const { vm, runAgent } = setup(PHOTOS_CHANGE, transport);
    runAgent.mockRestore();
    await ready(vm);
    const held = holdExit(transport);
    const done = homeRun();
    await vi.waitFor(() => expect(['running', 'awaiting']).toContain(vm.runState()));
    expect(vm.session()?.title).toBe('Triage');
    vm.cancelLock();
    await vi.waitFor(() => expect(held.wait).toHaveBeenCalled());
    expect(vm.session()?.finished).not.toBeNull();
    expect(vm.closeBlocked()).toBe(true);
    held.exit(true);
    await vi.waitFor(() => expect(vm.closeBlocked()).toBe(false));
    vm.closeSession();
    await done;
  });

  it("a change page showing its own run is not held by a home run's settling", async () => {
    const transport = new MockTransport();
    const { vm, runAgent } = setup(PHOTOS_CHANGE, transport);
    runAgent.mockRestore();
    await ready(vm);
    // This change's own run is live and on show; a home run takes the lock beside it, stops and settles.
    void vm.act('start-spec');
    await vi.waitFor(() => expect(['running', 'awaiting']).toContain(vm.runState()));
    const held = holdExit(transport);
    const home = homeRun();
    const lock = TestBed.inject(LockStore);
    await vi.waitFor(() => expect(lock.active()?.kind).toBe('run'));
    lock.cancel();
    await vi.waitFor(() => expect(held.wait).toHaveBeenCalled());
    expect(vm.session()?.title).not.toBe('Triage');
    vm.cancelLock();
    await vi.waitFor(() => expect(vm.session()?.finished).not.toBeNull());
    // This change's own leftovers hold its Close until they are decided; the home run's settling never does.
    await vi.waitFor(() => expect(vm.leftovers()).not.toBeNull());
    vm.closeLeftovers();
    expect(TestBed.inject(SdlcRunner).settling()).toBe(true);
    await vi.waitFor(() => expect(vm.closeBlocked()).toBe(false));
    vm.closeSession();
    held.exit(true);
    await vi.waitFor(() => expect(TestBed.inject(SdlcRunner).settling()).toBe(false));
    lock.close();
    await home;
  });

  it("a change page with no workspace is not held by a home run it does not show, and never shows the home's leftovers", async () => {
    const transport = new MockTransport();
    vi.spyOn(transport, 'sdlcWorkspaces').mockResolvedValue([]);
    const { vm, runAgent } = setup(PHOTOS_CHANGE, transport);
    runAgent.mockRestore();
    await ready(vm);
    expect(vm.current()).toBeNull();
    const held = holdExit(transport);
    const home = homeRun('/ws/commerce-docs');
    const lock = TestBed.inject(LockStore);
    await vi.waitFor(() => expect(lock.active()?.kind).toBe('run'));
    lock.cancel();
    await vi.waitFor(() => expect(held.wait).toHaveBeenCalled());
    // The home run's view is closed while it settles, so this page shows no run.
    lock.close();
    expect(vm.session()).toBeNull();
    expect(TestBed.inject(SdlcRunner).settling()).toBe(true);
    expect(vm.closeBlocked()).toBe(false);
    held.exit(true);
    const runner = TestBed.inject(SdlcRunner);
    await vi.waitFor(() => expect(runner.leftovers()).not.toBeNull());
    expect(vm.leftovers()).toBeNull();
    expect(vm.closeBlocked()).toBe(false);
    runner.closeLeftovers();
    await home;
  });
});

describe("ChangePageViewModel: Close waits on the settling of the run on show, tracked per run (F32)", () => {
  const OTHER = { workspace: MOCK_WORKSPACE_FOLDER, system: 'commerce', change: MOCK_BUILD_CHANGE };
  const LIVE = ['running', 'awaiting'];
  /** Let a run's after-run work finish: it ends in the task after its last transport answer. */
  const flush = () => new Promise((r) => setTimeout(r, 0));
  /** Hold the engine's exit of the next run that waits on it, so its after-run work stays going. */
  const holdExit = (transport: MockTransport) => {
    let exit!: (v: boolean) => void;
    const wait = vi.spyOn(transport, 'sdlcWaitRunExit').mockImplementationOnce(() => new Promise<boolean>((r) => (exit = r)));
    return { wait, release: () => exit(true) };
  };
  type Ctx = { vm: ChangePageViewModel; transport: MockTransport };
  type Shown = 'own' | 'lock' | 'intent' | 'none';
  type Other = 'none' | 'home' | 'other-change';

  /** This change's own spec run, cancelled; `settling` keeps its after-run work going, otherwise its leftovers are decided. */
  const ownRun = async ({ vm, transport }: Ctx, settling: boolean) => {
    void vm.act('start-spec');
    await vi.waitFor(() => expect(LIVE).toContain(vm.runState()));
    const held = settling ? holdExit(transport) : null;
    vm.cancelLock();
    await vi.waitFor(() => expect(vm.session()?.finished).not.toBeNull());
    if (held) return void (await vi.waitFor(() => expect(held.wait).toHaveBeenCalled()));
    await vi.waitFor(() => expect(vm.leftovers()).not.toBeNull());
    vm.closeLeftovers();
    await flush();
  };
  /** A run of no change (a triage) that takes the screen, cancelled; it has no master, so it leaves nothing to decide. */
  const lockRun = async ({ transport }: Ctx, settling: boolean) => {
    const lock = TestBed.inject(LockStore);
    void TestBed.inject(SdlcRunner).run('Triage', { ...seedSpec(), name: 'sdlc-triage' }, { workspaceId: 'w', master: null, productRepos: [], link: null });
    await vi.waitFor(() => expect(lock.active()?.kind).toBe('run'));
    const held = settling ? holdExit(transport) : null;
    lock.cancel();
    await vi.waitFor(() => expect(lock.active()).toMatchObject({ kind: 'run', finished: expect.anything() }));
    if (held) await vi.waitFor(() => expect(held.wait).toHaveBeenCalled());
    else await flush();
  };
  /** The full-track start of a new change that the plugin names this page's change: its intent run lives in this change's session. */
  const intentRun = async ({ vm, transport }: Ctx, settling: boolean) => {
    vi.spyOn(transport, 'sdlcStartChange').mockResolvedValue({ outcome: 'started', change: PHOTOS_CHANGE, branch: `change/${PHOTOS_CHANGE}`, copy: '/copy' });
    void TestBed.inject(SdlcRunner).newChange({ workspace: vm.current()!, master: '/ws/commerce-docs', productRepos: [] }, 'commerce', 'flag prices', 'full');
    await vi.waitFor(() => expect(LIVE).toContain(vm.runState()));
    expect(vm.session()?.title).toBe('Starting a change');
    const held = settling ? holdExit(transport) : null;
    vm.cancelLock();
    await vi.waitFor(() => expect(vm.session()?.finished).not.toBeNull());
    if (held) return void (await vi.waitFor(() => expect(held.wait).toHaveBeenCalled()));
    // Its leftovers are offered where the change was started, never on this page.
    await vi.waitFor(() => expect(TestBed.inject(SdlcRunner).leftovers()).not.toBeNull());
    await flush();
  };
  /** A run this page does not show, cancelled and held in its after-run work. */
  const otherRun = async ({ transport }: Ctx, other: Other) => {
    if (other === 'none') return;
    const held = holdExit(transport);
    const runner = TestBed.inject(SdlcRunner);
    if (other === 'home') {
      const lock = TestBed.inject(LockStore);
      void runner.run('Context', { ...seedSpec(), name: 'sdlc-context' }, { workspaceId: 'w', master: null, productRepos: [], link: null });
      await vi.waitFor(() => expect(lock.active()?.kind).toBe('run'));
      lock.cancel();
    } else {
      const runs = TestBed.inject(ChangeRunStore);
      void runner.run('Starting spec of B', { ...seedSpec(), name: 'sdlc-commerce-b-spec' }, { workspaceId: 'w', master: null, productRepos: [], link: null }, { ref: OTHER, kind: 'spec' });
      await vi.waitFor(() => expect(runs.session(changeRunKey(OTHER))?.runId).toBeTruthy());
      runs.cancel(changeRunKey(OTHER));
    }
    await vi.waitFor(() => expect(held.wait).toHaveBeenCalled());
  };

  const cases: { name: string; shown: Shown; settling: boolean; other: Other; blocked: boolean }[] = [
    { name: "the page's own change run settling", shown: 'own', settling: true, other: 'none', blocked: true },
    { name: "the page's own change run settled, a home run settling", shown: 'own', settling: false, other: 'home', blocked: false },
    { name: 'a lock run (triage) on show settling', shown: 'lock', settling: true, other: 'none', blocked: true },
    { name: "a lock run on show settled, another change's run settling", shown: 'lock', settling: false, other: 'other-change', blocked: false },
    { name: "a new change's intent run on show settling", shown: 'intent', settling: true, other: 'none', blocked: true },
    { name: "a new change's intent run on show settled, another change's run settling", shown: 'intent', settling: false, other: 'other-change', blocked: false },
    { name: "no run on show, another change's run settling", shown: 'none', settling: false, other: 'other-change', blocked: false },
  ];

  for (const c of cases) {
    it(`${c.name}: Close ${c.blocked ? 'is' : 'is not'} blocked`, async () => {
      const transport = new MockTransport();
      const { vm, runAgent } = setup(PHOTOS_CHANGE, transport);
      runAgent.mockRestore();
      await ready(vm);
      const ctx = { vm, transport };
      if (c.shown === 'own') await ownRun(ctx, c.settling);
      if (c.shown === 'lock') await lockRun(ctx, c.settling);
      if (c.shown === 'intent') await intentRun(ctx, c.settling);
      await otherRun(ctx, c.other);
      expect(vm.session() === null).toBe(c.shown === 'none');
      expect(vm.closeBlocked()).toBe(c.blocked);
    });
  }
});

describe('ChangePageViewModel: the change copy', () => {
  const COPY = 'C:/ws/.ai-sdlc/copies/2026-10-12-product-photo-upload';
  const REF = { workspace: MOCK_WORKSPACE_FOLDER, system: 'commerce', change: PHOTOS_CHANGE };

  /** The change as the plugin reports it from inside its own copy, with the backend's answers as the test says. */
  function inCopy(removal: CopyRemoval | Promise<CopyRemoval>, remove?: RemoveOutcome) {
    const transport = new MockTransport();
    const real = transport.sdlcChangeState.bind(transport);
    const state = vi.spyOn(transport, 'sdlcChangeState').mockImplementation(async (...args) => {
      const view = await real(...args);
      return { ...view, state: { ...view.state, inCopy: true, master: COPY } };
    });
    const asked = vi.spyOn(transport, 'sdlcCopyRemoval').mockReturnValue(Promise.resolve(removal));
    vi.spyOn(transport, 'sdlcCopyBranch').mockResolvedValue(`change/${PHOTOS_CHANGE}`);
    const removed = vi.spyOn(transport, 'sdlcRemoveCopy').mockResolvedValue(remove ?? { outcome: 'removed', kept: [] });
    const opened = vi.spyOn(transport, 'sdlcOpenCopyFolder').mockResolvedValue();
    return { transport, state, asked, removed, opened, real };
  }
  const removalReady = (vm: ChangePageViewModel, offered: boolean) => vi.waitFor(() => expect(vm.removalOffered()).toBe(offered));

  describe('removal is offered only on Offer and Keep names the files', () => {
    it.each<[string, CopyRemoval, boolean, string[]]>([
      ['Offer', { outcome: 'offer' }, true, []],
      ['Keep', { outcome: 'keep', uncommitted: ['src/a.ts', 'notes.txt'] }, false, ['src/a.ts', 'notes.txt']],
      ['NotOffered', { outcome: 'notOffered' }, false, []],
    ])('%s', async (_name, answer, offered, files) => {
      const { vm } = setup(PHOTOS_CHANGE, inCopy(answer).transport);
      await ready(vm);
      await vi.waitFor(() => expect([vm.removalOffered(), vm.keepFiles()]).toEqual([offered, files]));
      expect(vm.copy()).not.toBeNull();
    });
  });

  it('knows the copy folder and, once the backend answers, the branch it holds', async () => {
    const { vm, transport } = setup(PHOTOS_CHANGE, inCopy({ outcome: 'notOffered' }).transport);
    await ready(vm);
    await vi.waitFor(() => expect(vm.copy()).toEqual({ folder: COPY, branch: `change/${PHOTOS_CHANGE}` }));
    expect(transport.sdlcCopyBranch).toHaveBeenCalledWith(REF);
  });

  it('a change that is not in a copy has no copy line and asks nothing about removal', async () => {
    const transport = new MockTransport();
    const asked = vi.spyOn(transport, 'sdlcCopyRemoval');
    const { vm } = setup(PHOTOS_CHANGE, transport);
    await ready(vm);
    expect(vm.copy()).toBeNull();
    expect(vm.removalOffered()).toBe(false);
    expect(asked).not.toHaveBeenCalled();
  });

  it('the page is ready before the slow removal answer arrives, and shows no offer until it does', async () => {
    let answer!: (r: CopyRemoval) => void;
    const slow = new Promise<CopyRemoval>((resolve) => (answer = resolve));
    const { vm } = setup(PHOTOS_CHANGE, inCopy(slow).transport);
    await ready(vm);
    expect(vm.state()).toBe('ready');
    expect(vm.removalOffered()).toBe(false);
    answer({ outcome: 'offer' });
    await removalReady(vm, true);
  });

  it('marks the change opened when its page opens', async () => {
    const transport = new MockTransport();
    const mark = vi.spyOn(transport, 'sdlcMarkOpened');
    const { vm } = setup(PHOTOS_CHANGE, transport);
    await ready(vm);
    await vi.waitFor(() => expect(mark).toHaveBeenCalledWith(REF));
  });

  it('Open folder opens the change copy folder through the backend', async () => {
    const { transport, opened } = inCopy({ outcome: 'notOffered' });
    const { vm } = setup(PHOTOS_CHANGE, transport);
    await ready(vm);
    await vm.openCopyFolder();
    expect(opened).toHaveBeenCalledWith(REF);
  });

  it('a folder the backend would not open says why', async () => {
    const { transport, opened } = inCopy({ outcome: 'notOffered' });
    opened.mockRejectedValue(new Error('this change is not in a copy'));
    const { vm } = setup(PHOTOS_CHANGE, transport);
    await ready(vm);
    await vm.openCopyFolder();
    expect(toastText()).toContain('this change is not in a copy');
  });

  // R15.3, row 1: nothing uncommitted, the engineer confirms.
  it('confirming the removal removes the copy, the copy line goes and the branches kept are shown', async () => {
    const kept = [`change/${PHOTOS_CHANGE} (the plugin keeps the branch in the master repository)`];
    const { transport, state, real, removed } = inCopy({ outcome: 'offer' }, { outcome: 'removed', kept });
    const { vm } = setup(PHOTOS_CHANGE, transport);
    await ready(vm);
    await removalReady(vm, true);
    vm.askRemoveCopy();
    expect(vm.removeAsked()).toBe(true);
    expect(removed).not.toHaveBeenCalled();
    // Once the copy is gone the plugin reports the master again.
    state.mockImplementation(real);
    await vm.confirmRemoveCopy();
    expect(removed).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledWith(REF);
    expect(vm.removeAsked()).toBe(false);
    await vi.waitFor(() => expect(vm.copy()).toBeNull());
    expect(vm.removalOffered()).toBe(false);
    expect(vm.copyNote()?.lines).toEqual(kept);
    expect(vm.copyNote()?.text).toContain('removed');
  });

  // R15.3, row 2: nothing uncommitted, the engineer declines.
  it('declining the removal keeps the copy and the offer stays', async () => {
    const { transport, removed } = inCopy({ outcome: 'offer' });
    const { vm } = setup(PHOTOS_CHANGE, transport);
    await ready(vm);
    await removalReady(vm, true);
    vm.askRemoveCopy();
    vm.declineRemoveCopy();
    expect(vm.removeAsked()).toBe(false);
    expect(removed).not.toHaveBeenCalled();
    expect(vm.copy()).not.toBeNull();
    expect(vm.removalOffered()).toBe(true);
  });

  // R15.3, row 3: uncommitted files, the engineer looks at the copy.
  it('a copy with uncommitted files is not offered for removal and the files are named', async () => {
    const { vm } = setup(PHOTOS_CHANGE, inCopy({ outcome: 'keep', uncommitted: ['notes.txt'] }).transport);
    await ready(vm);
    await vi.waitFor(() => expect(vm.keepFiles()).toEqual(['notes.txt']));
    expect(vm.removalOffered()).toBe(false);
    vm.askRemoveCopy();
    expect(vm.removeAsked()).toBe(false);
  });

  // R15.2: work appears in the copy between the offer and the confirmation.
  it('work that appeared in the copy after the offer keeps it and names the file', async () => {
    const { transport } = inCopy({ outcome: 'offer' }, { outcome: 'keep', uncommitted: ['src/new.ts'] });
    const { vm } = setup(PHOTOS_CHANGE, transport);
    await ready(vm);
    await removalReady(vm, true);
    vm.askRemoveCopy();
    await vm.confirmRemoveCopy();
    expect(vm.copy()).not.toBeNull();
    expect(vm.removalOffered()).toBe(false);
    expect(vm.keepFiles()).toEqual(['src/new.ts']);
    expect(vm.copyNote()?.lines).toEqual(['src/new.ts']);
  });

  it("a removal the plugin refuses shows the plugin's problems as they are and keeps the copy", async () => {
    const { transport } = inCopy({ outcome: 'offer' }, { outcome: 'refused', problems: ['the branch is checked out', 'run ai-sdlc doctor'] });
    const { vm } = setup(PHOTOS_CHANGE, transport);
    await ready(vm);
    await removalReady(vm, true);
    vm.askRemoveCopy();
    await vm.confirmRemoveCopy();
    expect(vm.copy()).not.toBeNull();
    expect(vm.copyNote()?.lines).toEqual(['the branch is checked out', 'run ai-sdlc doctor']);
  });

  it('a removal that could not run says so and keeps the copy', async () => {
    const { transport } = inCopy({ outcome: 'offer' }, { outcome: 'couldNotRun', message: 'node was not found' });
    const { vm } = setup(PHOTOS_CHANGE, transport);
    await ready(vm);
    await removalReady(vm, true);
    vm.askRemoveCopy();
    await vm.confirmRemoveCopy();
    expect(vm.copy()).not.toBeNull();
    expect(vm.copyNote()?.text).toContain('node was not found');
  });
});

describe('ChangePageViewModel: where the change lives', () => {
  const copyRef = (change: string) => ({ workspace: MOCK_WORKSPACE_FOLDER, system: 'commerce', change });

  it('switching_tabs_reads_from_the_change_copy', async () => {
    const transport = new MockTransport();
    const read = vi.spyOn(transport, 'sdlcReadDoc');
    const { vm } = setup(MOCK_COPY_CHANGE, transport);
    await ready(vm);
    expect(vm.state()).toBe('ready');
    await vm.showDoc('intent');
    expect(vm.doc()).toContain('The copy holds this intent.');
    await vm.showDoc('plan');
    expect(vm.doc()).toContain('The copy holds this plan.');
    expect(read).toHaveBeenCalledWith(copyRef(MOCK_COPY_CHANGE), 'plan');
  });

  it('full_pipeline_from_a_fix_reads_the_fix_intent_in_its_copy', async () => {
    const transport = new MockTransport();
    const read = vi.spyOn(transport, 'sdlcReadDoc');
    const { vm } = setup(MOCK_COPY_FIX, transport);
    await ready(vm);
    await vm.act('full-pipeline-instead');
    expect(read).toHaveBeenCalledWith(copyRef(MOCK_COPY_FIX), 'intent');
    expect(vm.pipelineOpen()).toBe(true);
    expect(vm.pipelineIdea()).toContain('The fix intent is in the copy.');
  });

  it('opens a change with one call that carries the change reference, and asks for its view no other way', async () => {
    const transport = new MockTransport();
    const open = vi.spyOn(transport, 'sdlcOpenChange');
    const state = vi.spyOn(transport, 'sdlcChangeState');
    const { vm } = setup(MOCK_COPY_CHANGE, transport);
    await ready(vm);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]).toEqual(copyRef(MOCK_COPY_CHANGE));
    expect(state).toHaveBeenCalledTimes(1);
  });

  it('shows the backend message and no document when the change cannot be placed', async () => {
    const transport = new MockTransport();
    vi.spyOn(transport, 'sdlcOpenChange').mockRejectedValue(new Error(NO_PLACE));
    const { vm } = setup(MOCK_COPY_CHANGE, transport);
    await ready(vm);
    expect(vm.state()).toBe('not-found');
    expect(vm.resolutionError()).toBe(NO_PLACE);
    expect(vm.doc()).toBeNull();
    expect(toastText()).not.toContain('Could not read the change');
  });

  it('tab_switch_after_copy_removed_shows_the_backend_message', async () => {
    const transport = new MockTransport();
    const { vm } = setup(MOCK_COPY_CHANGE, transport);
    await ready(vm);
    await vm.showDoc('intent');
    expect(vm.doc()).toContain('The copy holds this intent.');
    vi.spyOn(transport, 'sdlcReadDoc').mockRejectedValue(new Error(MOCK_NOT_LISTED));
    await vm.showDoc('plan');
    expect(vm.shownDoc()).toBe('plan');
    expect(vm.doc()).toBeNull();
    expect(vm.docNotice()).toEqual({ tone: 'warning', text: MOCK_NOT_LISTED, lines: [] });
    vi.spyOn(transport, 'sdlcReadDoc').mockRestore();
    await vm.showDoc('intent');
    expect(vm.resolutionError()).toBeNull();
    expect(vm.doc()).toContain('The copy holds this intent.');
  });
});
