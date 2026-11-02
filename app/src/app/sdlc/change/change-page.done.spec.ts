import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { render } from '../../../testing/render';
import type { ChangeInfo } from '../../lib/sdlc-mock-types';
import type { DeclareView } from '@bindings/DeclareView';
import type { RepoCheckView } from '@bindings/RepoCheckView';
import type { PullRequestLink } from '@bindings/PullRequestLink';
import { toastState } from '@spartan-ng/brain/sonner';
import { BehaviorSubject, of } from 'rxjs';
import { LockStore } from '../../core/lock/lock.store';
import { SdlcRunner } from '../../core/sdlc/sdlc-runner';
import { RunPreviewViewModel } from '../../core/given/run-preview.view-model';
import { ProgressStore } from '../../core/progress/progress.store';
import { KataTransport } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import type { StageAction } from '../../lib/sdlc';
import { MOCK_BUILD_CHANGE, MOCK_DONE_CHANGE } from '../../lib/sdlc-mock';
import { BuildPageViewModel } from '../build/build-page.view-model';
import { ChangePage } from './change-page';
import { ChangePageViewModel } from './change-page.view-model';

/** Hold the lock the way Kata's own checks do, and never finish: the screen stays locked for the rest of the test. */
const holdLock = (lock: LockStore): void => void lock.runSteps('Checking', [{ label: 'Check', run: () => new Promise<string | null>(() => undefined) }]);

const BUILD = MOCK_BUILD_CHANGE;
const RUN = `sdlc-commerce-${BUILD}-review-1`;
const REPOS = ['commerce-core', 'customer-portal'];
const DEPARTURE = { task: 'T2', repo: 'customer-portal', planText: 'Add the photo picker to the product form', departure: 'Reused the existing file picker.' };
const toastText = () => toastState.toasts().map((t) => String(t.title)).join(' | ');

function setup(transport: MockTransport) {
  const params = new BehaviorSubject(convertToParamMap({ system: 'commerce', change: BUILD }));
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
  transport.patchChange(name, { stage });
};

/** A finished build whose review ran against the current heads and whose repositories have nothing uncommitted. */
async function finished(tweak: (t: MockTransport) => void = () => undefined) {
  const transport = new MockTransport();
  withStage(transport, BUILD, 'build-finished');
  vi.spyOn(transport, 'sdlcDiffFiles').mockResolvedValue({ files: [], loc: [] });
  const status = transport.sdlcBuildStatus.bind(transport);
  vi.spyOn(transport, 'sdlcBuildStatus').mockImplementation(async (m, s, c) => ({ ...(await status(m, s, c)), departures: [DEPARTURE] }));
  vi.spyOn(transport, 'listRuns').mockResolvedValue([{ id: RUN, kata: 'k', started_at: 1, isolation: 'none', steered: false, exit: 0 }]);
  tweak(transport);
  const s = setup(transport);
  await ready(s.vm);
  const heads = await transport.sdlcBuildHeads('', 'commerce-docs', 'commerce', ['commerce-docs', ...REPOS], BUILD);
  await transport.sdlcLinkRun({ workspace_id: s.vm.current()!.id, system: 'commerce', change: BUILD, stage: 'review', run_id: RUN, started_at: 1790000000, heads });
  const lock = TestBed.inject(LockStore);
  return { ...s, lock, steps: vi.spyOn(lock, 'runSteps') };
}

afterEach(() => toastState.reset());

describe('declaring done', () => {
  it('declare done reads the checks the plugin recorded once, for the change, and the touched repositories and the master are listed (R11.1)', async () => {
    const { vm, transport, steps } = await finished();
    const read = vi.spyOn(transport, 'sdlcChecksView');
    await vm.act('declare-done');
    expect(steps).toHaveBeenCalledWith('Declaring done', expect.any(Array));
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith({ workspace: expect.any(String), system: 'commerce', change: BUILD });
    const report = vm.doneReport()!;
    expect(report.repos.map((r) => r.repo)).toEqual(['commerce-docs', ...REPOS]);
  });

  it("the done dialog shows each repository's checks as the plugin recorded them and Kata runs none (R5.1)", async () => {
    const failed: RepoCheckView = { repo: 'commerce-core', view: { kind: 'failedStop', id: 'unit', output: 'assertion failed' }, summary: 'unit failed. The build stopped here.' };
    const { vm, transport } = await finished((t) => vi.spyOn(t, 'sdlcChecksView').mockResolvedValue([failed]));
    await vm.act('declare-done');
    const report = vm.doneReport()!;
    expect(report.repos.find((r) => r.repo === 'commerce-core')!.view).toEqual(failed);
    expect(report.repos.find((r) => r.repo === 'customer-portal')!.view).toBeNull();
    expect(transport).not.toHaveProperty('sdlcRunChecks');
  });

  it('declare done is refused while a run is going or edits are uncommitted (R11.4)', async () => {
    const running = await finished();
    holdLock(running.lock);
    expect(running.lock.active()).not.toBeNull();
    await running.vm.act('declare-done');
    expect(toastText()).toContain('Another task is already running.');
    // The only steps run is the one holding the lock; declaring done started none.
    expect(running.steps).toHaveBeenCalledTimes(1);
    expect(running.steps).not.toHaveBeenCalledWith('Declaring done', expect.any(Array));
    expect(running.vm.doneReport()).toBeNull();
  });

  it('is not offered before the build has finished (R11.4)', async () => {
    const { vm } = setup(new MockTransport());
    const steps = vi.spyOn(TestBed.inject(LockStore), 'runSteps');
    await ready(vm);
    await vm.act('declare-done');
    expect(steps).not.toHaveBeenCalled();
  });

  it("done dialog lists departures with the plan's text before confirm (R9.2)", async () => {
    const { vm } = await finished();
    await vm.act('declare-done');
    expect(vm.doneReport()!.departures).toEqual([DEPARTURE]);
  });

  it('Run review starts the review only, through the backend', async () => {
    const { vm, transport } = await finished();
    const prepare = vi.spyOn(transport, 'sdlcReviewStart');
    await vm.act('declare-done');
    await vm.doneRunReview();
    // The review goes through its preview first (R1.1); Start run hands the build over.
    const preview = TestBed.inject(RunPreviewViewModel);
    await vi.waitFor(() => expect(preview.isOpen() && !preview.busy()).toBe(true));
    expect(prepare).not.toHaveBeenCalled();
    preview.start();
    await vi.waitFor(() => expect(prepare).toHaveBeenCalled());
    expect(vm.doneReport()).toBeNull();
  });

  it("the toolbar's Run review starts the review, the same as the done dialog's", async () => {
    const { vm, transport } = await finished();
    const prepare = vi.spyOn(transport, 'sdlcReviewStart');
    await vm.act('run-review');
    // The review goes through its preview first (R1.1); Start run hands the build over.
    const preview = TestBed.inject(RunPreviewViewModel);
    await vi.waitFor(() => expect(preview.isOpen() && !preview.busy()).toBe(true));
    expect(prepare).not.toHaveBeenCalled();
    preview.start();
    await vi.waitFor(() => expect(prepare).toHaveBeenCalled());
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
    await vi.waitFor(() => expect(TestBed.inject(BuildPageViewModel).dialogMode()).toBe('round'));
  });

  it('Cancel closes the dialog and asks the plugin nothing', async () => {
    const { vm, transport } = await finished();
    const publish = vi.spyOn(transport, 'sdlcDeclareDone');
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
    reviews: [{ number: 1, reviewed_at: '2026-10-19', commits: { 'commerce-docs': '1111111', 'commerce-core': '2222222', 'customer-portal': '3333333' }, findings: [{ id: 'F1', severity: 'medium', file: 'src/upload.ts', line: 10, text: FINDING }] }],
  } as unknown as Awaited<ReturnType<MockTransport['sdlcReviewRecord']>>;

  afterEach(() => vi.restoreAllMocks());

  async function mountPage(change: string, transport: MockTransport) {
    const out = await render(ChangePage, {}, [
      provideRouter([]),
      { provide: KataTransport, useValue: transport },
      { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ system: 'commerce', change })), snapshot: { queryParamMap: convertToParamMap({}) } } },
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
    vi.spyOn(transport, 'listRuns').mockResolvedValue([{ id: RUN, kata: 'k', started_at: 1, isolation: 'none', steered: false, exit: 0 }]);
    const heads = await transport.sdlcBuildHeads('', 'commerce-docs', 'commerce', ['commerce-docs', ...REPOS], BUILD);
    await transport.sdlcLinkRun({ workspace_id: 'acme-commerce', system: 'commerce', change: BUILD, stage: 'review', run_id: RUN, started_at: 1790000000, heads });
    const publish = vi.spyOn(transport, 'sdlcDeclareDone');
    const { container, fixture } = await mountPage(BUILD, transport);
    const vm = fixture.debugElement.injector.get(ChangePageViewModel);

    button(page(container), 'Declare done')!.click();
    await vi.waitFor(() => expect(vm.doneReport()).not.toBeNull(), { timeout: 10000 });
    const report = vm.doneReport()!;
    expect(report.departures).toEqual([DEPARTURE]);
    expect(report.repos.map((r) => r.repo)).toEqual(['commerce-docs', ...REPOS]);
    await settle();
    const dialog = document.body.querySelector('app-done-dialog [role="dialog"], [role="dialog"]')!;
    expect(text(dialog.querySelector('[hlmDialogTitle]')!)).toBe('Declare the change done');
    expect(text(dialog)).toContain(DEPARTURE.departure);
    for (const repo of REPOS) expect(text(dialog)).toContain(repo);

    button(dialog, 'Open pull requests')!.click();
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1), { timeout: 10000 });
    await vi.waitFor(() => expect(vm.declareView()).not.toBeNull(), { timeout: 10000 });
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
    // Finished tasks fold per repository; the folds say how many are done, and opening them lists every task.
    const folds = Array.from(p.querySelectorAll<HTMLButtonElement>('[data-fold]'));
    expect(folds.length).toBeGreaterThan(0);
    for (const f of folds) f.click();
    await settle();
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

  const PRS: PullRequestLink[] = [
    { repo: 'commerce-docs', url: 'https://github.com/acme/commerce-docs/pull/11', number: 11, source: 'plugin', state: 'open', lastSeen: false, seenAt: null },
    { repo: 'commerce-core', url: 'https://github.com/acme/commerce-core/pull/12', number: 12, source: 'plugin', state: 'open', lastSeen: false, seenAt: null },
    { repo: 'customer-portal', url: 'https://github.com/acme/customer-portal/pull/13', number: 13, source: 'plugin', state: 'open', lastSeen: false, seenAt: null },
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
    if (place === 'dialog') vm.declareView.set({ kind: 'done', pullRequests: PRS.map(({ repo, url }, i) => ({ repo, url, number: 11 + i, source: 'plugin' as const })) });
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

describe('lasting links after a publish or a round', () => {
  const saved = (repo: string, over: Partial<PullRequestLink> = {}): PullRequestLink => ({ repo, url: `https://github.com/acme/${repo}/pull/7`, number: 7, source: 'plugin', state: 'open', lastSeen: false, seenAt: null, ...over });

  it('keeps the opened link and offers declare done after a part-way failure (R8.3)', async () => {
    const { vm, transport } = await finished();
    const real = transport.sdlcPullRequestsView.bind(transport);
    let published = false;
    const doneView = vi.spyOn(transport, 'sdlcPullRequestsView').mockImplementation(async (...args) =>
      published ? { done: false, source: 'plugin', links: [saved('commerce-core')], declareOffered: true } : real(...args),
    );
    const publish = vi.spyOn(transport, 'sdlcDeclareDone').mockImplementation(async () => {
      published = true;
      return { kind: 'partial', pushed: ['commerce-core', 'customer-portal'], opened: [{ repo: 'commerce-core', url: 'https://github.com/acme/commerce-core/pull/7', number: 7, source: 'plugin' }], failed: ['opening the pull request in customer-portal failed: push refused'] };
    });
    await vm.act('declare-done');
    await vm.confirmDone();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(doneView.mock.calls.length).toBeGreaterThan(1);
    expect(vm.done()).toBe(false);
    expect(vm.pullLinks().map((l) => l.repo)).toEqual(['commerce-core']);
    expect(vm.declareView()?.kind).toBe('partial');
    expect(vm.actions()).toContain('declare-done');
  });

  it('a change an earlier version declared done shows as done with its links and is not offered declaring done again (R8.1)', async () => {
    const transport = new MockTransport();
    withStage(transport, BUILD, 'build-finished');
    const earlier = (repo: string) => saved(repo, { source: 'legacy', lastSeen: true, seenAt: 1790000000, state: 'merged' });
    const asked = vi.spyOn(transport, 'sdlcPullRequestsView').mockResolvedValue({
      done: true,
      source: 'legacy',
      links: [earlier('commerce-core'), earlier('customer-portal')],
      declareOffered: false,
    });
    const { vm } = setup(transport);
    await ready(vm);
    expect(vm.done()).toBe(true);
    expect(vm.pullLinks().map((l) => [l.repo, l.state])).toEqual([['commerce-core', 'merged'], ['customer-portal', 'merged']]);
    expect(vm.pullLinks().every((l) => l.seen?.startsWith('last seen '))).toBe(true);
    expect(vm.linksNote()).toBe('from the earlier declaration');
    expect(vm.actions()).not.toContain('declare-done');
    // The plugin does not know these pull requests: GitHub is never asked about them.
    expect(asked.mock.calls.every((c) => c[4] === false)).toBe(true);
  });
});

describe('a branch name, after a rename', () => {
  const NEW_NAME = 'feat/PROJ-123-password-reset';

  it('the report names the branch the repositories have (R10.1)', async () => {
    const { vm } = await finished();
    await vm.act('declare-done');
    expect(vm.doneReport()!.branch).toBe(`change/${BUILD}`);
  });

  it('a rename lists the pull requests opened from the old name, to close by hand (R2.3)', async () => {
    const { vm, transport } = await finished();
    const old = { repo: 'customer-portal', url: 'https://github.com/acme/customer-portal/pull/3', number: 3, source: 'plugin' as const };
    vi.spyOn(transport, 'sdlcRenameBranch').mockResolvedValue({ outcome: 'renamed', from: 'feat/PROJ-123-reset', to: NEW_NAME, repos: ['master'], oldPullRequests: [old] });
    const renamed = vm.renameBranch('feat/PROJ-123-reset');
    await vi.waitFor(() => expect(TestBed.inject(SdlcRunner).nameRequest()).not.toBeNull());
    await TestBed.inject(SdlcRunner).confirmName(NEW_NAME);
    expect(await renamed).toBe(NEW_NAME);
    expect(vm.prLeftBehind()).toEqual([{ repo: 'customer-portal', url: old.url, branch: 'feat/PROJ-123-reset' }]);
  });
});

describe("declaring done is the plugin's step", () => {
  const ASKED = { workspace: expect.any(String), system: 'commerce', change: BUILD };

  it('confirming runs the plugin once for the change and shows its pull requests, the master last, and the change as done (R7.1 passes)', async () => {
    const { vm, transport } = await finished();
    const declare = vi.spyOn(transport, 'sdlcDeclareDone');
    await vm.act('declare-done');
    await vm.confirmDone();
    expect(declare).toHaveBeenCalledTimes(1);
    expect(declare).toHaveBeenCalledWith(ASKED);
    const view = vm.declareView();
    expect(view?.kind).toBe('done');
    expect(view?.kind === 'done' && view.pullRequests.map((p) => p.repo)).toEqual([...REPOS, 'commerce-docs']);
    expect(vm.done()).toBe(true);
    vm.closeDeclareView();
    expect(vm.declareView()).toBeNull();
  });

  it.each([
    ['refuses, listing what is not ready', { kind: 'notReady', problems: ['customer-portal has uncommitted files: a.rs'] }],
    ['fails part way', { kind: 'partial', pushed: ['commerce-core'], opened: [], failed: ['opening the pull request in commerce-core failed: boom'] }],
    ['cannot run on this machine', { kind: 'couldNotRun', message: 'ai-sdlc needs Node.js 22.18 or later' }],
  ] satisfies [string, DeclareView][])('the plugin %s: the engineer sees exactly that answer (R7.1)', async (_row, view) => {
    const { vm, transport } = await finished((t) => vi.spyOn(t, 'sdlcDeclareDone').mockResolvedValue(view));
    await vm.act('declare-done');
    await vm.confirmDone();
    expect(vm.declareView()).toEqual(view);
    expect(vm.done()).toBe(false);
    expect(transport.sdlcDeclareDone).toHaveBeenCalledTimes(1);
  });

  it('declaring done again after a part-way failure asks the plugin again, which carries on (R7.1 fails)', async () => {
    const partial: DeclareView = { kind: 'partial', pushed: ['commerce-core'], opened: [], failed: ['opening the pull request in commerce-core failed: boom'] };
    const { vm, transport } = await finished();
    const declare = vi.spyOn(transport, 'sdlcDeclareDone').mockResolvedValueOnce(partial);
    await vm.act('declare-done');
    await vm.confirmDone();
    expect(vm.declareView()).toEqual(partial);
    await vm.declareAgain();
    expect(declare).toHaveBeenCalledTimes(2);
    expect(vm.declareView()?.kind).toBe('done');
  });

  it('a high finding asks for no tick box and does not hold the plugin: whether it is refused is its answer (R7.2)', async () => {
    const { vm, transport } = await finished();
    const heads = await transport.sdlcBuildHeads('', 'commerce-docs', 'commerce', ['commerce-docs', ...REPOS], BUILD);
    const commits = Object.fromEntries(Object.entries(heads).map(([repo, sha]) => [repo, sha.slice(0, 7)]));
    const finding = { id: 'F1', severity: 'high' as const, file: 'src/a.ts', line: 4, text: 'The limit is not enforced on retry.' };
    vi.spyOn(transport, 'sdlcReviewRecord').mockResolvedValue({ layout: 2, problems: [], master_moved: [], reviews: [{ number: 1, reviewed_at: '2026-10-22', commits, findings: [finding] }] });
    const declare = vi.spyOn(transport, 'sdlcDeclareDone');
    await vm.act('declare-done');
    expect(vm).not.toHaveProperty('doneAcknowledged');
    await vm.confirmDone();
    expect(declare).toHaveBeenCalledTimes(1);
  });

  it('each step the plugin reports becomes the lock\'s progress line, named by what it is (R7.3)', async () => {
    const { vm } = await finished();
    const progress = TestBed.inject(ProgressStore);
    const begin = vi.spyOn(progress, 'begin');
    await vm.act('declare-done');
    await vm.confirmDone();
    const lines = begin.mock.calls.filter((c) => c[2] === 'lock').map((c) => [c[0], c[1]]);
    expect(lines).toEqual([
      ['running-checks', 'Declaring done: the plugin is verifying the change'],
      ...[...REPOS, 'commerce-docs'].flatMap((r) => [['pushing', `Pushing ${r}`], ['opening-prs', `Opening a pull request in ${r}`]]),
    ]);
    expect(progress.view('lock')()).toBeNull();
  });

  it('a call that fails outright clears the progress line before it raises its error (R7.1)', async () => {
    const { vm, transport } = await finished();
    const progress = TestBed.inject(ProgressStore);
    vi.spyOn(transport, 'sdlcDeclareDone').mockImplementation(async () => {
      progress.begin('pushing', 'Pushing commerce-core', 'lock');
      throw new Error('the backend is gone');
    });
    const fail = vi.spyOn(progress, 'fail');
    await vm.act('declare-done');
    await vm.confirmDone();
    expect(fail).toHaveBeenCalledWith('lock');
    expect(progress.view('lock')()).toBeNull();
    expect(toastText()).toContain('the backend is gone');
  });

  it('what Kata used to check itself is not asked any more (R7.1)', async () => {
    const { vm, transport } = await finished();
    for (const gone of ['sdlcTouchedRepos', 'sdlcGhSignedIn', 'sdlcGhOrigins', 'sdlcCommitOffenders', 'sdlcPublish']) expect(transport).not.toHaveProperty(gone);
    await vm.act('declare-done');
    expect(vm.doneReport()!.repos.map((r) => r.repo)).toEqual(['commerce-docs', ...REPOS]);
  });
});
