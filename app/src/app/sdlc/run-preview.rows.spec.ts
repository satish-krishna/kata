import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import type { ChangeInfo } from '@bindings/ChangeInfo';
import { BehaviorSubject } from 'rxjs';
import { RunPreviewViewModel } from '../core/given/run-preview.view-model';
import { LockStore } from '../core/lock/lock.store';
import { SdlcRunner } from '../core/sdlc/sdlc-runner';
import { KataTransport } from '../core/transport/kata-transport';
import { MockTransport } from '../core/transport/mock-transport';
import { MOCK_BUILD_CHANGE, MOCK_MASTER, MOCK_WORKSPACE_FOLDER } from '../lib/sdlc-mock';
import { WorkbenchViewModel } from '../workbench/workbench.view-model';
import { BuildPageViewModel, type BuildContext } from './build/build-page.view-model';
import { ChangePageViewModel } from './change/change-page.view-model';
import { SdlcHomeViewModel } from './home/sdlc-home.view-model';

const PHOTOS_CHANGE = '2026-10-12-product-photo-upload';
const BUILD = MOCK_BUILD_CHANGE;

/** One way to start a run: how to ask for it, how to tell it has started, and the preview in front of it. */
type Scenario = {
  transport: MockTransport;
  preview: RunPreviewViewModel;
  /** Ask for the run, as the engineer does; it settles when the run is on its way. */
  go: () => Promise<unknown>;
  /** The run (or the build handoff) has started. */
  started: () => boolean;
  /** Anything the engineer fills in before pressing Start run. */
  fill?: () => void;
};

const previewReady = (preview: RunPreviewViewModel) => vi.waitFor(() => expect(preview.isOpen() && !preview.busy()).toBe(true));

async function workbench(): Promise<Scenario> {
  const transport = new MockTransport();
  TestBed.configureTestingModule({
    providers: [WorkbenchViewModel, RunPreviewViewModel, { provide: KataTransport, useValue: transport }, provideRouter([])],
  });
  const vm = TestBed.inject(WorkbenchViewModel);
  const runSpec = vi.spyOn(transport, 'runSpec');
  await vm.init(false);
  return { transport, preview: vm.preview, go: () => vm.run(), started: () => runSpec.mock.calls.length > 0 };
}

async function home(start: (vm: SdlcHomeViewModel) => Promise<unknown>): Promise<Scenario> {
  const transport = new MockTransport();
  TestBed.configureTestingModule({
    providers: [SdlcHomeViewModel, RunPreviewViewModel, { provide: KataTransport, useValue: transport }, provideRouter([])],
  });
  vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  const runAgent = vi.spyOn(TestBed.inject(LockStore), 'runAgent').mockResolvedValue('success');
  const vm = TestBed.inject(SdlcHomeViewModel);
  await vm.init();
  return { transport, preview: TestBed.inject(RunPreviewViewModel), go: () => start(vm), started: () => runAgent.mock.calls.length > 0 };
}

async function changePage(change: string, stage: ChangeInfo['stage'] | null, start: (vm: ChangePageViewModel) => Promise<unknown>, kind: 'run' | 'build', fill?: (s: Scenario) => void): Promise<Scenario> {
  const transport = new MockTransport();
  if (stage) {
    const real = transport.sdlcReadChange.bind(transport);
    vi.spyOn(transport, 'sdlcReadChange').mockImplementation(async (m, s, n) => [await real(m, s, n)].map((c) => (c.change === change ? { ...c, stage } : c))[0]);
  }
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      ChangePageViewModel,
      BuildPageViewModel,
      RunPreviewViewModel,
      { provide: KataTransport, useValue: transport },
      { provide: ActivatedRoute, useValue: { paramMap: new BehaviorSubject(convertToParamMap({ system: 'commerce', change })).asObservable() } },
    ],
  });
  vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  const runAgent = vi.spyOn(TestBed.inject(LockStore), 'runAgent').mockResolvedValue('success');
  const prepare = vi.spyOn(transport, 'sdlcBuildPrepare');
  const vm = TestBed.inject(ChangePageViewModel);
  await vi.waitFor(() => {
    TestBed.tick();
    expect(vm.state()).toBe('ready');
  });
  const scenario: Scenario = {
    transport,
    preview: TestBed.inject(RunPreviewViewModel),
    go: () => start(vm),
    started: () => (kind === 'run' ? runAgent.mock.calls.length > 0 : prepare.mock.calls.length > 0 && TestBed.inject(BuildPageViewModel).current() !== null),
  };
  if (fill) scenario.fill = () => fill(scenario);
  return scenario;
}

/** A build whose two repositories stopped at the time limit, so Continue is offered on commerce-core. */
async function continuing(): Promise<Scenario> {
  const transport = new MockTransport();
  TestBed.configureTestingModule({ providers: [provideRouter([]), BuildPageViewModel, RunPreviewViewModel, { provide: KataTransport, useValue: transport }] });
  const vm = TestBed.inject(BuildPageViewModel);
  const runner = TestBed.inject(SdlcRunner);
  let continued = false;
  const run = vi.spyOn(runner, 'runInRepo').mockImplementation(async (target, _spec, link) => {
    if (run.mock.calls.length <= 2) {
      link.onRun?.(`fake-${target.repo}`);
      return { exit: 124, error: null };
    }
    continued = true;
    link.onRun?.(`fake-${target.repo}-again`);
    return { exit: 0, error: null };
  });
  const out = await transport.sdlcBuildPrepare(MOCK_WORKSPACE_FOLDER, MOCK_MASTER, 'commerce', BUILD, false, null, 'start');
  if (out.kind !== 'ready') throw new Error('the mock build did not prepare');
  const ctx: BuildContext = { workspaceId: 'acme-commerce', folder: MOCK_WORKSPACE_FOLDER, system: 'commerce', change: BUILD, systemRepos: [] };
  await vm.start({ start: out.start, timeoutSecs: 5400, round: null, checksDir: await transport.sdlcChecksDir() }, ctx);
  await vi.waitFor(() => {
    vm.select('commerce-core');
    expect(vm.view().groups.find((g) => g.repo === 'commerce-core')?.action).toBe('continue');
  });
  return { transport, preview: TestBed.inject(RunPreviewViewModel), go: () => vm.continueRun(), started: () => continued };
}

const ROWS: [string, string, () => Promise<Scenario>][] = [
  ['run mode', 'a run of the job they composed', workbench],
  ['AI-SDLC mode', 'first-time setup', () => home((vm) => vm.addSystem())],
  ['AI-SDLC mode', 'a context run', () => home((vm) => vm.runContext('customer-portal'))],
  [
    'AI-SDLC mode',
    'an intent run',
    () =>
      changePage(PHOTOS_CHANGE, null, async (vm) => {
        await vm.act('continue-intent');
        await vm.runWithFeedback('');
      }, 'run'),
  ],
  ['AI-SDLC mode', 'a spec run', () => changePage(PHOTOS_CHANGE, null, (vm) => vm.act('start-spec'), 'run')],
  ['AI-SDLC mode', 'a plan run', () => changePage(PHOTOS_CHANGE, null, (vm) => vm.act('start-plan'), 'run')],
  ['AI-SDLC mode', 'a build', () => changePage(BUILD, 'build-ready', (vm) => vm.act('start-build'), 'build')],
  [
    'AI-SDLC mode',
    'another round',
    () =>
      changePage(BUILD, 'build-finished', (vm) => vm.act('another-round'), 'build', (s) =>
        s.preview.buildForm()!.model.update((m) => ({ ...m, instructions: 'tidy up', repo: 'commerce-core' })),
      ),
  ],
  ['AI-SDLC mode', 'a review started by hand', () => changePage(BUILD, 'build-finished', (vm) => vm.act('run-review'), 'build')],
  ['AI-SDLC mode', 'continuing a stopped repository', continuing],
];

describe('every Workbench run start opens the preview first (R1.1)', () => {
  it.each(ROWS)('%s: %s', async (_mode, _step, make) => {
    const s = await make();
    const previewRun = vi.spyOn(s.transport, 'previewRun');
    const going = s.go();
    await previewReady(s.preview);
    // The preview resolved what the run will be given, and the run has not started.
    expect(previewRun).toHaveBeenCalled();
    expect(s.started()).toBe(false);
    s.fill?.();
    s.preview.start();
    await vi.waitFor(() => expect(s.started()).toBe(true));
    await going;
    // Cancelling is covered by the screens' own specs; here the order is what counts.
    expect(s.preview.isOpen()).toBe(false);
  });

  it.each(ROWS)('%s: %s - cancelling the preview starts nothing', async (_mode, _step, make) => {
    const s = await make();
    const going = s.go();
    await previewReady(s.preview);
    s.preview.cancel();
    await going;
    expect(s.started()).toBe(false);
    expect(s.preview.isOpen()).toBe(false);
  });
});
