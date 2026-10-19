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
    expect(vm.runCounts()).toEqual({ intent: 1, spec: 2, plan: 0 });
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

    it('reopen intent starts an intent run whose task says the reopen was already confirmed', async () => {
      const { vm, runAgent } = setup(FNOL);
      await ready(vm);
      await vm.act('reopen-intent');
      expect(runAgent).toHaveBeenCalledTimes(1);
      expect(specOf(runAgent).task).toContain('already confirmed reopening');
      expect(specOf(runAgent).name).toBe(`sdlc-claims-${FNOL}-intent`);
    });

    it('continue spec runs the spec skill on this change', async () => {
      const { vm, runAgent } = setup(FNOL);
      await ready(vm);
      await vm.act('continue-spec');
      expect(specOf(runAgent).name).toBe(`sdlc-claims-${FNOL}-spec`);
      expect(specOf(runAgent).task).toContain(FNOL);
    });

    it('re-run plan states the replace was already confirmed', async () => {
      const { vm, runAgent } = setup(REASSIGN);
      await ready(vm);
      await vm.act('rerun-plan');
      expect(specOf(runAgent).task).toContain('already confirmed replacing the existing plan');
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
      vi.spyOn(TestBed.inject(LockStore), 'active').mockReturnValue({ kind: 'run', title: 'x' });
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
});
