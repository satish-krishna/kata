import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { render } from '../../../testing/render';
import type { ChangeInfo } from '@bindings/ChangeInfo';
import type { PrLink } from '@bindings/PrLink';
import { toastState } from '@spartan-ng/brain/sonner';
import { BehaviorSubject, of } from 'rxjs';
import { LockStore } from '../../core/lock/lock.store';
import { RunPreviewViewModel } from '../../core/given/run-preview.view-model';
import { ProgressStore } from '../../core/progress/progress.store';
import { KataTransport } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import type { StageAction } from '../../lib/sdlc';
import { canConfirm } from '../../lib/sdlc-done';
import { MOCK_BUILD_CHANGE, MOCK_DONE_CHANGE } from '../../lib/sdlc-mock';
import { BuildPageViewModel } from '../build/build-page.view-model';
import { ChangePage } from './change-page';
import { ChangePageViewModel } from './change-page.view-model';

const BUILD = MOCK_BUILD_CHANGE;
const RUN = `sdlc-claims-${BUILD}-review-1`;
const REPOS = ['claims-core', 'customer-portal'];
const DEPARTURE = { task: 'T2', repo: 'customer-portal', planText: 'Add the photo picker to the report form', departure: 'Reused the existing file picker.' };
const toastText = () => toastState.toasts().map((t) => String(t.title)).join(' | ');

function setup(transport: MockTransport) {
  const params = new BehaviorSubject(convertToParamMap({ system: 'claims', change: BUILD }));
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
  vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  return { vm: TestBed.inject(ChangePageViewModel), transport };
}
const ready = async (vm: ChangePageViewModel) => {
  await vi.waitFor(() => {
    TestBed.tick();
    expect(vm.state()).not.toBe('loading');
  });
};
const withStage = (transport: MockTransport, name: string, stage: ChangeInfo['stage']) => {
  const real = transport.sdlcChanges.bind(transport);
  vi.spyOn(transport, 'sdlcChanges').mockImplementation(async (m, s) => (await real(m, s)).map((c) => (c.change === name ? { ...c, stage } : c)));
};

/** A finished build whose review ran against the current heads and whose repositories have nothing uncommitted. */
async function finished(tweak: (t: MockTransport) => void = () => undefined) {
  const transport = new MockTransport();
  withStage(transport, BUILD, 'build-finished');
  vi.spyOn(transport, 'sdlcDiffFiles').mockResolvedValue({ files: [], loc: [] });
  const status = transport.sdlcBuildStatus.bind(transport);
  vi.spyOn(transport, 'sdlcBuildStatus').mockImplementation(async (m, s, c) => ({ ...(await status(m, s, c)), departures: [DEPARTURE] }));
  vi.spyOn(transport, 'listRuns').mockResolvedValue([{ id: RUN, kata: 'k', started_at: 1, isolation: 'none', exit: 0 }]);
  tweak(transport);
  const s = setup(transport);
  await ready(s.vm);
  const heads = await transport.sdlcBuildHeads('', ['claims-intent', ...REPOS], BUILD);
  await transport.sdlcLinkRun({ workspace_id: s.vm.current()!.id, system: 'claims', change: BUILD, stage: 'review', run_id: RUN, started_at: 1790000000, heads });
  const lock = TestBed.inject(LockStore);
  return { ...s, lock, steps: vi.spyOn(lock, 'runSteps') };
}

afterEach(() => toastState.reset());

describe('declaring done', () => {
  it('declare done runs checks for every touched repository and the master (R11.1)', async () => {
    const { vm, transport, steps } = await finished();
    const load = vi.spyOn(transport, 'sdlcChecksLoad');
    const run = vi.spyOn(transport, 'sdlcRunChecks');
    await vm.act('declare-done');
    expect(steps).toHaveBeenCalledWith('Declaring done', expect.any(Array));
    expect(load).toHaveBeenCalledTimes(1);
    expect(run.mock.calls.map((c) => c[3].repo)).toEqual(['claims-intent', ...REPOS]);
    const report = vm.doneReport()!;
    expect(report.repos.map((r) => r.repo)).toEqual(['claims-intent', ...REPOS]);
    expect(report.repos.every((r) => r.result !== null)).toBe(true);
    expect(canConfirm(report)).toBe(true);
    expect(report.account).toBe('demo-user');
  });

  it('a failed check blocks confirm and publishes nothing (R11.2)', async () => {
    const { vm, transport } = await finished();
    const failed = { name: 'cargo test', argv: ['cargo', 'test'], outcome: { kind: 'Failed' as const, exit: 101 }, tail: 'assertion failed' };
    vi.spyOn(transport, 'sdlcRunChecks').mockImplementation(async (_f, _m, _s, repo) => ({ repo: repo.repo, none: false, results: repo.repo === 'claims-core' ? [failed] : [] }));
    const publish = vi.spyOn(transport, 'sdlcPublish');
    await vm.act('declare-done');
    const report = vm.doneReport()!;
    expect(canConfirm(report)).toBe(false);
    expect(report.repos.find((r) => r.repo === 'claims-core')!.result!.results[0].tail).toBe('assertion failed');
    expect(publish).not.toHaveBeenCalled();
  });

  it('declare done is refused while a run is going or edits are uncommitted (R11.4)', async () => {
    const running = await finished();
    expect(running.lock.beginBuild('Build')).toBe(true);
    await running.vm.act('declare-done');
    expect(toastText()).toContain('Another task is already running.');
    expect(running.steps).not.toHaveBeenCalled();
    expect(running.vm.doneReport()).toBeNull();
  });

  it('refuses while a touched repository has uncommitted edits and names it (R11.4)', async () => {
    const { vm, transport, steps } = await finished();
    vi.spyOn(transport, 'sdlcDiffFiles').mockImplementation(async (path, part) => ({
      files: path.endsWith('customer-portal') && part === 'uncommitted' ? [{ path: 'a.rs', oldPath: null, status: 'modified', binary: false, added: 1, removed: 0, uncommitted: true }] : [],
      loc: [],
    }));
    await vm.act('declare-done');
    expect(toastText()).toContain('Commit or discard the uncommitted edits in customer-portal before declaring done.');
    expect(steps).not.toHaveBeenCalled();
    expect(vm.doneReport()).toBeNull();
  });

  it('is not offered before the build has finished (R11.4)', async () => {
    const { vm } = setup(new MockTransport());
    const steps = vi.spyOn(TestBed.inject(LockStore), 'runSteps');
    await ready(vm);
    await vm.act('declare-done');
    expect(steps).not.toHaveBeenCalled();
  });

  it('an offending commit blocks confirm (R11.5)', async () => {
    const { vm } = await finished((t) => vi.spyOn(t, 'sdlcCommitOffenders').mockResolvedValue([{ repo: 'claims-core', hash: 'abc1234def', subject: 'fix stuff' }]));
    await vm.act('declare-done');
    expect(vm.doneReport()!.offenders).toEqual([{ repo: 'claims-core', hash: 'abc1234def', subject: 'fix stuff' }]);
    expect(canConfirm(vm.doneReport()!)).toBe(false);
  });

  it.each([
    ['sdlcGhSignedIn', 'Not signed in to github.com. Run gh auth login, then declare done again.'],
    ['sdlcGhOrigins', 'customer-portal has no GitHub remote'],
  ] as const)('a repository that is not ready blocks done with the reason, and nothing after it runs (R12.1): %s', async (method, reason) => {
    const { vm, transport } = await finished((t) => vi.spyOn(t, method).mockRejectedValue(new Error(reason)));
    const run = vi.spyOn(transport, 'sdlcRunChecks');
    const offenders = vi.spyOn(transport, 'sdlcCommitOffenders');
    const publish = vi.spyOn(transport, 'sdlcPublish');
    await vm.act('declare-done');
    const report = vm.doneReport()!;
    expect(report.notReady).toBe(reason);
    expect(canConfirm(report)).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(offenders).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("done dialog lists departures with the plan's text before confirm (R9.2)", async () => {
    const { vm } = await finished();
    await vm.act('declare-done');
    expect(vm.doneReport()!.departures).toEqual([DEPARTURE]);
  });

  it('a bad checks file blocks done and says where (R16.2)', async () => {
    const message = '/home/demo/.kata/checks/claims.toml:4:1: a check has no time limit';
    const { vm, transport } = await finished((t) => vi.spyOn(t, 'sdlcChecksLoad').mockRejectedValue(new Error(message)));
    const run = vi.spyOn(transport, 'sdlcRunChecks');
    await vm.act('declare-done');
    const report = vm.doneReport()!;
    expect(run).not.toHaveBeenCalled();
    expect(report.checksError).toBe(message);
    expect(report.checksPath).toContain('claims.toml');
    expect(canConfirm(report)).toBe(false);
  });

  it("done dialog lists each repository's checks and the file path (R16.3)", async () => {
    const { vm } = await finished();
    await vm.act('declare-done');
    const report = vm.doneReport()!;
    expect(report.repos.find((r) => r.repo === 'claims-core')!.checks.map((c) => c.name)).toEqual(['cargo test']);
    expect(report.repos.find((r) => r.repo === 'customer-portal')!.checks).toEqual([]);
    expect(report.checksPath).toBe('C:/Users/demo/.kata/checks/claims.toml');
    expect(report.repos[0].base).toBe('main');
  });

  it('done dialog shows the findings most serious first before confirm (R20.1)', async () => {
    const { vm } = await finished();
    await vm.act('declare-done');
    const review = vm.doneReport()!.review;
    expect('findings' in review && review.findings.length).toBe(2);
    expect('findings' in review && review.findings[0].text).toContain('upload limit is duplicated');
  });

  it('with a review document the done dialog reads its latest review against the heads, not the run exit code (R14.2)', async () => {
    const { vm, transport } = await finished((t) => {
      vi.spyOn(t, 'listRuns').mockResolvedValue([{ id: RUN, kata: 'k', started_at: 1, isolation: 'none', exit: 1 }]);
    });
    const heads = await transport.sdlcBuildHeads('', ['claims-intent', ...REPOS], BUILD);
    const commits = Object.fromEntries(Object.entries(heads).map(([repo, sha]) => [repo, sha.slice(0, 7)]));
    const finding = { id: 'F1', severity: 'high' as const, file: 'src/a.ts', line: 4, text: 'The limit is not enforced on retry.' };
    vi.spyOn(transport, 'sdlcReviewRecord').mockResolvedValue({
      layout: 2,
      problems: [],
      master_moved: [],
      reviews: [{ number: 1, reviewed_at: '2026-10-22', commits, findings: [finding] }],
    });
    await vm.act('declare-done');
    const review = vm.doneReport()!.review;
    expect(review).toEqual({ at: '2026-10-22', findings: [finding] });
    // The review is current, so the one thing that still holds the pull requests is its high-severity finding.
    expect(canConfirm(vm.doneReport()!)).toBe(false);
    expect(canConfirm(vm.doneReport()!, true)).toBe(true);
  });

  it('a review run that committed under plugin/ is not current when the change page is opened again (F17)', async () => {
    const { vm, transport } = await finished();
    const heads = await transport.sdlcBuildHeads('', ['claims-intent', ...REPOS], BUILD);
    const commits = Object.fromEntries(Object.entries(heads).map(([repo, sha]) => [repo, sha.slice(0, 7)]));
    const finding = { id: 'F1', severity: 'high' as const, file: 'src/a.ts', line: 4, text: 'The limit is not enforced on retry.' };
    // The backend reports what the master committed since the head the review recorded; a fresh view model asks again and gets the same answer.
    vi.spyOn(transport, 'sdlcReviewRecord').mockResolvedValue({
      layout: 2,
      problems: [],
      reviews: [{ number: 1, reviewed_at: '2026-10-22', commits, findings: [finding] }],
      master_moved: ['plugin/format/check.mjs'],
    });
    await vm.act('declare-done');
    expect(vm.doneReport()!.review).toEqual({ missing: 'stale' });
    expect(canConfirm(vm.doneReport()!)).toBe(false);
  });

  it('open findings do not block Open pull requests, and confirming publishes (R20.2)', async () => {
    const { vm, transport } = await finished();
    const publish = vi.spyOn(transport, 'sdlcPublish');
    await vm.act('declare-done');
    expect(canConfirm(vm.doneReport()!)).toBe(true);
    await vm.confirmDone();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][5].map((r) => r.repo)).toEqual(['claims-intent', ...REPOS]);
    expect(vm.doneReport()).toBeNull();
    expect(vm.prList()!.map((r) => r.outcome.kind)).toEqual(['opened', 'opened', 'opened']);
  });

  it('a high-severity finding holds the pull requests until it is acknowledged, and a new report asks again (R20.4)', async () => {
    const { vm, transport } = await finished();
    const publish = vi.spyOn(transport, 'sdlcPublish');
    const withHigh = () => vm.doneReport.update((r) => ({ ...r!, review: { at: 1, findings: [{ severity: 'high' as const, text: 'x' }] } }));
    await vm.act('declare-done');
    withHigh();
    await vm.confirmDone();
    expect(publish).not.toHaveBeenCalled();
    expect(vm.doneReport()).not.toBeNull();

    vm.doneAcknowledged.set(true);
    vm.cancelDone();
    await vm.act('declare-done');
    withHigh();
    expect(vm.doneAcknowledged()).toBe(false);
    await vm.confirmDone();
    expect(publish).not.toHaveBeenCalled();

    vm.doneAcknowledged.set(true);
    await vm.confirmDone();
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('a failed pull request lists why, and Retry publishes again (R13.2)', async () => {
    const { vm, transport, steps } = await finished();
    const real = transport.sdlcPublish.bind(transport);
    const publish = vi.spyOn(transport, 'sdlcPublish').mockImplementationOnce(async (f, w, m, s, c, repos) => {
      const out = await real(f, w, m, s, c, repos);
      return out.map((r) => (r.repo === 'customer-portal' ? { repo: r.repo, outcome: { kind: 'failed' as const, error: 'gh: HTTP 502' } } : r));
    });
    await vm.act('declare-done');
    await vm.confirmDone();
    expect(vm.prList()!.find((r) => r.repo === 'customer-portal')!.outcome).toEqual({ kind: 'failed', error: 'gh: HTTP 502' });
    await vm.retryPublish();
    expect(publish).toHaveBeenCalledTimes(2);
    expect(steps.mock.calls.filter((c) => c[0] === 'Opening pull requests').length).toBe(2);
    expect(vm.prList()!.every((r) => r.outcome.kind === 'opened')).toBe(true);
    vm.closePrList();
    expect(vm.prList()).toBeNull();
  });

  it.each([
    ['none', (t: MockTransport) => vi.spyOn(t, 'sdlcRunLinks').mockResolvedValue([])],
    ['unfinished', (t: MockTransport) => vi.spyOn(t, 'listRuns').mockResolvedValue([{ id: RUN, kata: 'k', started_at: 1, isolation: 'none', exit: 1 }])],
    ['stale', (t: MockTransport) => vi.spyOn(t, 'sdlcBuildHeads').mockResolvedValue({ 'claims-core': 'ffffffff', 'customer-portal': 'eeeeeee' })],
  ] as const)('done needs a finished review of the current heads (R20.3): %s', async (missing, tweak) => {
    const { vm, transport } = await finished();
    tweak(transport);
    await vm.act('declare-done');
    expect(vm.doneReport()!.review).toEqual({ missing });
    expect(canConfirm(vm.doneReport()!)).toBe(false);
  });

  it('done compares the master repository head as well as the product repositories (R20.3)', async () => {
    const { vm, transport } = await finished();
    const heads = vi.spyOn(transport, 'sdlcBuildHeads');
    await vm.act('declare-done');
    expect(heads).toHaveBeenCalledWith(expect.anything(), ['claims-intent', ...REPOS], BUILD);
    expect(vm.doneReport()!.review).toMatchObject({ findings: expect.anything() });
  });

  it('Run review prepares a build with no round, which runs the review only', async () => {
    const { vm, transport } = await finished();
    const prepare = vi.spyOn(transport, 'sdlcBuildPrepare');
    await vm.act('declare-done');
    await vm.doneRunReview();
    // The review goes through its preview first (R1.1); Start run hands the build over.
    const preview = TestBed.inject(RunPreviewViewModel);
    await vi.waitFor(() => expect(preview.isOpen() && !preview.busy()).toBe(true));
    expect(prepare).not.toHaveBeenCalled();
    preview.start();
    await vi.waitFor(() => expect(TestBed.inject(BuildPageViewModel).current()).not.toBeNull());
    expect(vm.doneReport()).toBeNull();
    expect(prepare).toHaveBeenCalled();
    expect(TestBed.inject(BuildPageViewModel).current()).not.toBeNull();
    expect(TestBed.inject(BuildPageViewModel).current()!.round).toBeNull();
  });

  it("the toolbar's Run review starts the review-only build, the same as the done dialog's", async () => {
    const { vm, transport } = await finished();
    const prepare = vi.spyOn(transport, 'sdlcBuildPrepare');
    await vm.act('run-review');
    // The review goes through its preview first (R1.1); Start run hands the build over.
    const preview = TestBed.inject(RunPreviewViewModel);
    await vi.waitFor(() => expect(preview.isOpen() && !preview.busy()).toBe(true));
    expect(prepare).not.toHaveBeenCalled();
    preview.start();
    await vi.waitFor(() => expect(TestBed.inject(BuildPageViewModel).current()).not.toBeNull());
    expect(prepare).toHaveBeenCalled();
    expect(TestBed.inject(BuildPageViewModel).current()!.round).toBeNull();
  });

  it('an action with nothing behind it says so instead of doing nothing', async () => {
    const { vm } = await finished();
    toastState.reset();
    await vm.act('no-such-action' as StageAction);
    expect(toastText()).toBe('Nothing runs for no-such-action.');
  });

  it('Another round closes the dialog and opens the round form', async () => {
    const { vm } = await finished();
    await vm.act('declare-done');
    vm.doneRound();
    expect(vm.doneReport()).toBeNull();
    expect(vm.buildMode()).toBe('round');
  });

  it('Cancel closes the dialog and publishes nothing', async () => {
    const { vm, transport } = await finished();
    const publish = vi.spyOn(transport, 'sdlcPublish');
    await vm.act('declare-done');
    vm.cancelDone();
    expect(vm.doneReport()).toBeNull();
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('declaring done from the build page', () => {
  const text = (e: Element) => e.textContent!.replace(/\s+/g, ' ').trim();
  const button = (root: ParentNode, label: string) => Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((b) => text(b) === label);
  const page = (c: HTMLElement) => c.querySelector('app-build-page')!;
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      TestBed.tick();
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  const FINDING = 'The refusal message has no test.';
  const REVIEW = {
    layout: 2,
    problems: [],
    master_moved: [],
    reviews: [{ number: 1, reviewed_at: '2026-10-19', commits: { 'claims-intent': '1111111', 'claims-core': '2222222', 'customer-portal': '3333333' }, findings: [{ id: 'F1', severity: 'medium', file: 'src/upload.ts', line: 10, text: FINDING }] }],
  } as unknown as Awaited<ReturnType<MockTransport['sdlcReviewRecord']>>;

  afterEach(() => vi.restoreAllMocks());

  async function mountPage(change: string, transport: MockTransport) {
    const out = await render(ChangePage, {}, [
      provideRouter([]),
      { provide: KataTransport, useValue: transport },
      { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ system: 'claims', change })), snapshot: { queryParamMap: convertToParamMap({}) } } },
    ]);
    await settle();
    return { ...out, transport };
  }

  it('declaring done from the build page confirms and opens the pull requests', async () => {
    const transport = new MockTransport();
    withStage(transport, BUILD, 'build-finished');
    vi.spyOn(transport, 'sdlcDiffFiles').mockResolvedValue({ files: [], loc: [] });
    vi.spyOn(transport, 'sdlcReviewRecord').mockResolvedValue(REVIEW);
    const status = transport.sdlcBuildStatus.bind(transport);
    vi.spyOn(transport, 'sdlcBuildStatus').mockImplementation(async (m, s, c) => {
      const got = await status(m, s, c);
      return { ...got, repos: got.repos.map((r) => ({ ...r, firstUnfinished: null, state: { kind: 'done' as const }, finished: r.tasks })), tasks: got.tasks.map((t) => ({ ...t, row: { task: t.id, repo: t.repo, commits: [`${t.id.toLowerCase()}c0ffee`], departure: null } })), departures: [DEPARTURE] };
    });
    vi.spyOn(transport, 'listRuns').mockResolvedValue([{ id: RUN, kata: 'k', started_at: 1, isolation: 'none', exit: 0 }]);
    const heads = await transport.sdlcBuildHeads('', ['claims-intent', ...REPOS], BUILD);
    await transport.sdlcLinkRun({ workspace_id: 'acme-claims', system: 'claims', change: BUILD, stage: 'review', run_id: RUN, started_at: 1790000000, heads });
    const publish = vi.spyOn(transport, 'sdlcPublish');
    const { container, fixture } = await mountPage(BUILD, transport);
    const vm = fixture.debugElement.injector.get(ChangePageViewModel);

    button(page(container), 'Declare done')!.click();
    await vi.waitFor(() => expect(vm.doneReport()).not.toBeNull(), { timeout: 10000 });
    const report = vm.doneReport()!;
    expect(report.departures).toEqual([DEPARTURE]);
    expect(report.review).toMatchObject({ findings: [expect.objectContaining({ text: FINDING })] });
    expect(report.repos.map((r) => r.repo)).toEqual(['claims-intent', ...REPOS]);
    expect(report.repos.every((r) => r.result !== null)).toBe(true);
    await settle();
    const dialog = document.body.querySelector('app-done-dialog [role="dialog"], [role="dialog"]')!;
    expect(text(dialog.querySelector('[hlmDialogTitle]')!)).toBe('Declare the change done');
    expect(text(dialog)).toContain(DEPARTURE.departure);
    expect(text(dialog)).toContain(FINDING);
    for (const repo of REPOS) expect(text(dialog)).toContain(repo);

    button(dialog, 'Open pull requests')!.click();
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1), { timeout: 10000 });
    await vi.waitFor(() => expect(vm.prList()).not.toBeNull(), { timeout: 10000 });
    await settle();
    expect(text(document.body.querySelector('[role="dialog"] [hlmDialogTitle]')!)).toBe('Pull requests');
    expect(page(container)).not.toBeNull();
    expect(container.querySelector('app-build-view')).toBeNull();
    await vi.waitFor(() => expect(container.querySelector('header [data-testid="pr-menu"]')).not.toBeNull(), { timeout: 10000 });
  }, 30000);

  it('a done change shows every task done, the findings, the pull request links and no declare done', async () => {
    const transport = new MockTransport();
    vi.spyOn(transport, 'sdlcReviewRecord').mockResolvedValue(REVIEW);
    const { container } = await mountPage(MOCK_DONE_CHANGE, transport);
    const p = page(container);
    expect(p).not.toBeNull();
    const tasks = Array.from(p.querySelectorAll('[data-task]'));
    expect(tasks.length).toBe(3);
    expect(tasks.every((t) => text(t).includes('Done'))).toBe(true);
    expect(text(p.querySelector('app-findings-list')!)).toContain(FINDING);
    expect(p.querySelector('app-changes-view')).not.toBeNull();
    expect(container.querySelector('header [data-testid="pr-menu"]')!.textContent).toContain('3 PRs');
    expect(button(p, 'Declare done')).toBeUndefined();
    // The bar also holds the mode switcher and Reset layout; only the stage actions are meant here.
    expect(Array.from(p.querySelectorAll('[data-bar] button')).filter((b) => b.closest('app-segmented') === null).map(text).filter((t) => t !== 'Reset layout')).toEqual([]);
  });

  const PRS = [
    { repo: 'claims-intent', url: 'https://github.com/acme/claims-intent/pull/11' },
    { repo: 'claims-core', url: 'https://github.com/acme/claims-core/pull/12' },
    { repo: 'customer-portal', url: 'https://github.com/acme/customer-portal/pull/13' },
  ];
  const click = (a: Element) => {
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(ev);
    return ev;
  };

  it.each([
    ['toolbar, one pull request', 'toolbar', 1, 0],
    ['toolbar menu, several', 'menu', 3, 1],
    ['pull requests dialog', 'dialog', 3, 0],
  ] as const)('clicking a pull request link opens it in the browser (R1.1): %s', async (_place, place, shown, index) => {
    const transport = new MockTransport();
    const open = vi.spyOn(transport, 'openUrl').mockResolvedValue();
    const { container, fixture } = await mountPage(MOCK_DONE_CHANGE, transport);
    const vm = fixture.debugElement.injector.get(ChangePageViewModel);
    vm.pullRequests.set(PRS.slice(0, shown));
    if (place === 'dialog') vm.prList.set(PRS.map(({ repo, url }) => ({ repo, outcome: { kind: 'opened' as const, url } })));
    await settle();

    let link: Element;
    if (place === 'toolbar') {
      link = container.querySelector('header nav[aria-label="Pull requests"] a')!;
    } else if (place === 'menu') {
      (container.querySelector('header [data-testid="pr-menu"]') as HTMLButtonElement).click();
      await settle();
      link = document.body.querySelectorAll('[data-testid="pr-list"] a')[index];
    } else {
      link = document.body.querySelectorAll('[role="dialog"] a')[index];
    }
    expect(link).toBeTruthy();

    const ev = click(link);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(PRS[index].url);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('a pull request link that fails to open shows an error toast naming the address and the cause', async () => {
    const transport = new MockTransport();
    const open = vi.spyOn(transport, 'openUrl').mockRejectedValue(new Error('no browser'));
    const { container, fixture } = await mountPage(MOCK_DONE_CHANGE, transport);
    const vm = fixture.debugElement.injector.get(ChangePageViewModel);
    vm.pullRequests.set(PRS.slice(0, 1));
    await settle();

    const link = container.querySelector('header nav[aria-label="Pull requests"] a')!;
    expect(link).toBeTruthy();
    click(link);

    await vi.waitFor(() => expect(toastState.toasts().map((t) => String(t.title))).toContain(`Could not open ${PRS[0].url}: no browser`));
    expect(open).toHaveBeenCalledWith(PRS[0].url);
  });
});

describe('declaring done reports progress', () => {
  it('names the repository whose checks run, the branch being pushed and the pull request being opened (R7.1)', async () => {
    const { vm } = await finished();
    const progress = TestBed.inject(ProgressStore);
    const begin = vi.spyOn(progress, 'begin');
    const end = vi.spyOn(progress, 'end');
    await vm.act('declare-done');
    const checks = begin.mock.calls.filter((c) => c[0] === 'running-checks');
    expect(checks.map((c) => c[1])).toEqual(['claims-intent', ...REPOS].map((r) => `Running the checks in ${r}`));
    expect(checks.every((c) => c[2] === 'lock')).toBe(true);
    await vm.confirmDone();
    const pushes = begin.mock.calls.filter((c) => c[0] === 'pushing').map((c) => c[1]);
    expect(pushes).toEqual(expect.arrayContaining(REPOS.map((r) => `Pushing change/${BUILD} in ${r}`)));
    const opens = begin.mock.calls.filter((c) => c[0] === 'opening-prs').map((c) => c[1]);
    expect(opens).toEqual(expect.arrayContaining(REPOS.map((r) => `Opening a pull request in ${r}`)));
    expect(end).toHaveBeenCalledWith('lock');
    expect(progress.view('lock')()).toBeNull();
  });

  it('a failed publish clears the progress line before it raises its error (R7.3)', async () => {
    const { vm, transport } = await finished();
    const progress = TestBed.inject(ProgressStore);
    await vm.act('declare-done');
    vi.spyOn(transport, 'sdlcPublish').mockImplementation(async () => {
      progress.begin('pushing', 'Pushing change/x in claims-core', 'lock');
      throw new Error('push refused');
    });
    const fail = vi.spyOn(progress, 'fail');
    await vm.confirmDone();
    expect(fail).toHaveBeenCalledWith('lock');
    expect(progress.view('lock')()).toBeNull();
    expect(toastText()).toContain('push refused');
  });
});

describe('lasting links after a publish or a round', () => {
  const saved = (repo: string, over: Partial<PrLink> = {}): PrLink => ({ repo, url: `https://github.com/acme/${repo}/pull/7`, state: 'open', seenAt: 1790000000, ...over });

  it('keeps the opened link and offers declare done after a partial publish (R8.3)', async () => {
    const { vm, transport } = await finished();
    const real = transport.sdlcDoneView.bind(transport);
    let published = false;
    const doneView = vi.spyOn(transport, 'sdlcDoneView').mockImplementation(async (...args) =>
      published ? { done: false, links: [saved('claims-core')], linksFrom: 'opened', offerDeclare: true, prCheckFailed: false } : real(...args),
    );
    const publish = vi.spyOn(transport, 'sdlcPublish').mockImplementation(async () => {
      published = true;
      return [
        { repo: 'claims-core', outcome: { kind: 'opened' as const, url: 'https://github.com/acme/claims-core/pull/7' } },
        { repo: 'customer-portal', outcome: { kind: 'failed' as const, error: 'push refused' } },
      ];
    });
    await vm.act('declare-done');
    await vm.confirmDone();
    expect(publish.mock.calls[0][1]).toBe(vm.current()!.id);
    expect(doneView.mock.calls.length).toBeGreaterThan(1);
    expect(vm.done()).toBe(false);
    expect(vm.pullLinks().map((l) => l.repo)).toEqual(['claims-core']);
    expect(vm.prList()?.length).toBe(2);
    expect(vm.actions()).toContain('declare-done');
  });

  it('a round after done shows build finished with the earlier links (T10 row 2)', async () => {
    const transport = new MockTransport();
    withStage(transport, BUILD, 'build-finished');
    vi.spyOn(transport, 'sdlcDoneView').mockResolvedValue({
      done: false,
      links: [saved('claims-core'), saved('customer-portal')],
      linksFrom: 'earlierDeclaration',
      offerDeclare: true,
      prCheckFailed: false,
    });
    vi.spyOn(transport, 'sdlcRefreshPrStates').mockImplementation(() => new Promise<never>(() => undefined));
    const { vm } = setup(transport);
    await ready(vm);
    expect(vm.done()).toBe(false);
    expect(vm.change()!.stage).toBe('build-finished');
    expect(vm.pullLinks().map((l) => l.repo)).toEqual(['claims-core', 'customer-portal']);
    expect(vm.linksNote()).toBe('from the earlier declaration');
    expect(vm.actions()).toContain('declare-done');
  });
});
