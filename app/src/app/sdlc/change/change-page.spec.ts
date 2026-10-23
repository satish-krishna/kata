import type { ChangeInfo } from '@bindings/ChangeInfo';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { render } from '../../../testing/render';
import { RunPreviewViewModel } from '../../core/given/run-preview.view-model';
import { LockStore } from '../../core/lock/lock.store';
import { SdlcRunner } from '../../core/sdlc/sdlc-runner';
import { KataTransport } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import { diagrams } from '../../lib/mermaid';
import { MOCK_BUILD_CHANGE } from '../../lib/sdlc-mock';
import { monaco } from '../../ui/diff-editor/monaco.loader';
import { BuildPage } from '../build/build-page';
import { BuildPageViewModel } from '../build/build-page.view-model';
import { ChangePage } from './change-page';
import { ChangePageViewModel } from './change-page.view-model';

/** Every document run opens the preview first; confirm it once its rows have resolved. */
const confirmPreview = async () => {
  const start = () => Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === 'Start run');
  await vi.waitFor(() => expect(start() && !start()!.disabled).toBe(true));
  start()!.click();
};
const settle = async () => {
  for (let i = 0; i < 4; i++) {
    TestBed.tick();
    await new Promise((r) => setTimeout(r, 0));
  }
};
const FNOL = '2026-10-12-fnol-photo-upload';
const labels = (c: HTMLElement) => Array.from(c.querySelectorAll('button')).map((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim());

async function mount(change = FNOL, transport = new MockTransport()) {
  const out = await render(ChangePage, {}, [
    provideRouter([]),
    { provide: KataTransport, useValue: transport },
    { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ system: 'claims', change })), snapshot: { queryParamMap: convertToParamMap({}) } } },
  ]);
  await settle();
  return { ...out, transport };
}

describe('ChangePage', () => {
  // The FNOL spec has a Mermaid diagram. A cold import of Mermaid under full-suite load blocks the
  // first mount's settle for seconds, past the 5s test timeout; these tests don't look at diagrams.
  let draw: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    draw = vi.spyOn(diagrams, 'render').mockResolvedValue('<svg></svg>');
  });
  afterEach(() => draw.mockRestore());

  it('shows the breadcrumb, the branch, the stage pills and the stage document', async () => {
    const { container } = await mount();
    expect(container.querySelector('nav')!.textContent).toContain(FNOL);
    expect(container.textContent).toContain('acme-claims');
    expect(container.querySelector('[data-testid="branch"]')!.textContent!.trim()).toBe('main');
    expect(container.querySelectorAll('header [aria-current="step"]').length).toBe(1);
    expect(container.textContent).toContain('Spec · awaiting acceptance');
    expect(container.querySelector('app-doc-layout h1')!.textContent).toBe('Spec: photo upload');
    expect(container.querySelector('[data-testid="strip"]')!.textContent).toContain('Draft');
  });

  it('crosses the seam: clicking the Intent pill shows the accepted intent in its tab panel', async () => {
    const { container } = await mount();
    const tab = (name: string) =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((t) => t.textContent!.trim().startsWith(name))!;
    expect(tab('Plan').disabled).toBe(true);
    tab('Intent').click();
    await vi.waitFor(() => expect(container.querySelector('app-doc-layout h1')?.textContent).toBe('Photo upload at first notice of loss'));
    expect(tab('Intent').getAttribute('aria-selected')).toBe('true');
    const panel = container.querySelector('[role="tabpanel"]:not([hidden])')!;
    expect(panel.getAttribute('aria-labelledby')).toBe(tab('Intent').id);
    expect(container.querySelector('[data-testid="strip"] .k-strip__file')!.textContent).toBe('intent.md');
    expect(tab('Spec').getAttribute('aria-current')).toBe('step');
  });

  it('crosses the seam: Reopen spec opens the feedback box, and Run starts a spec run carrying the corrections', async () => {
    const transport = new MockTransport();
    const run = vi.spyOn(transport, 'runSpec').mockResolvedValue('1');
    // A plan awaiting acceptance no longer offers Reopen spec; a plan that is ready to start does.
    const real = transport.sdlcChanges.bind(transport);
    vi.spyOn(transport, 'sdlcChanges').mockImplementation(async (m, s) =>
      (await real(m, s)).map((c) => (c.change === '2026-10-09-adjuster-reassign' ? { ...c, stage: 'plan-ready' as const } : c)),
    );
    const { container } = await mount('2026-10-09-adjuster-reassign', transport);
    Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent!.trim() === 'Reopen spec')!.click();
    await settle();
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Reopen spec');
    expect(run).not.toHaveBeenCalled();
    const box = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
    box.value = 'R2: team leads can reassign too.';
    box.dispatchEvent(new Event('input'));
    await settle();
    Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent!.trim() === 'Run')!.click();
    await confirmPreview();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run.mock.calls[0][0].task).toContain('Operator feedback:\nR2: team leads can reassign too.');
  });

  it('offers the toolbar actions for the stage', async () => {
    const { container } = await mount();
    const all = labels(container);
    expect(all).toEqual(expect.arrayContaining(['Continue spec', 'Accept spec', 'Reopen intent']));
    expect(all).not.toContain('Start plan');
  });

  it('crosses the seam: clicking Accept spec calls sdlcDecide and the stepper moves on', async () => {
    const { container, transport } = await mount();
    const decide = vi.spyOn(transport, 'sdlcDecide');
    Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent!.trim() === 'Accept spec')!.click();
    await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    await settle();
    expect(container.textContent).toContain('Plan · ready to start');
    expect(labels(container)).toContain('Start plan');
  });

  it('names a change that does not exist and offers the way back', async () => {
    const { container } = await mount('2026-01-01-nope');
    expect(container.textContent).toContain('Change not found');
    expect(labels(container)).toContain('Back to the workspace');
  });

  it('mounts the lock overlay and the leftover dialog like the home screen', async () => {
    const { container } = await mount();
    expect(container.querySelector('app-lock-overlay')).not.toBeNull();
    expect(container.querySelector('app-leftover-dialog')).not.toBeNull();
  });

  describe('the build', () => {
    const text = (e: Element) => e.textContent!.replace(/\s+/g, ' ').trim();

    it('the plan tab lists the tasks from sdlcBuildStatus in the Tasks view', async () => {
      const { container, transport } = await mount(MOCK_BUILD_CHANGE);
      const status = await transport.sdlcBuildStatus('', 'claims', MOCK_BUILD_CHANGE);
      const nav = container.querySelector('nav[aria-label="Tasks"]')!;
      expect(nav).not.toBeNull();
      expect(nav.querySelectorAll('button').length).toBe(status.tasks.length);
      expect(container.querySelector('app-build-log-table')).toBeNull();
    });

    it('crosses the seam: clicking the Build pill shows what changed in the build panel', async () => {
      vi.spyOn(monaco, 'load').mockReturnValue(new Promise(() => undefined));
      const { container } = await mount(MOCK_BUILD_CHANGE);
      const tile = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((t) => t.textContent!.trim().startsWith('Build'))!;
      expect(tile.disabled).toBe(false);
      expect(container.querySelector('app-changes-view')).toBeNull();
      tile.click();
      await settle();
      expect(tile.getAttribute('aria-selected')).toBe('true');
      expect(container.querySelector('app-changes-view')).not.toBeNull();
      expect(container.querySelector('app-changes-view [data-repo]')).not.toBeNull();
      vi.restoreAllMocks();
    });

    it('shows the build view in place of the session view once a build is prepared, and the session view otherwise', async () => {
      const { container, fixture } = await mount(MOCK_BUILD_CHANGE);
      expect(container.querySelector('app-build-view')).toBeNull();
      const vm = fixture.debugElement.injector.get(ChangePageViewModel);
      await vm.submitBuild({ timeoutSecs: 5400, instructions: null, repo: null });
      await settle();
      expect(container.querySelector('app-build-view')).not.toBeNull();
      expect(container.querySelector('app-sdlc-session')).toBeNull();
      expect(container.querySelector('main.k-change')).toBeNull();
    });

    it('shows no task list on a change without tasks', async () => {
      const { container } = await mount();
      expect(container.querySelector('nav[aria-label="Tasks"]')).toBeNull();
    });

    it('crosses the seam: clicking the rendered Start build opens the preview of the build, and Start run prepares the build', async () => {
      const { container, transport } = await mount(MOCK_BUILD_CHANGE);
      const prepare = vi.spyOn(transport, 'sdlcBuildPrepare');
      Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent!.trim() === 'Start build')!.click();
      await settle();
      const dialog = document.body.querySelector('[role="dialog"]')!;
      expect(dialog).not.toBeNull();
      expect(text(dialog.querySelector('[hlmDialogTitle]')!)).toBe('Start build');
      expect(prepare).not.toHaveBeenCalled();
      await confirmPreview();
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
      expect(prepare.mock.calls[0][4]).toBe(false);
    });

    it('a refused build opens the refusal dialog', async () => {
      const { container, transport } = await mount(MOCK_BUILD_CHANGE);
      vi.spyOn(transport, 'sdlcPluginReadiness').mockResolvedValue({ kind: 'tooOld', have: '0.7.9', need: '0.9.0' });
      Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent!.trim() === 'Start build')!.click();
      await settle();
      await confirmPreview();
      await vi.waitFor(() => expect(document.body.textContent).toContain('The build did not start'));
      expect(document.body.textContent).toContain('Update the ai-sdlc plugin to 0.9.0 or later');
    });

    it('leftovers open the confirm dialog titled and listing each repository and file', async () => {
      const { container, transport } = await mount(MOCK_BUILD_CHANGE);
      vi.spyOn(transport, 'sdlcBuildPrepare').mockResolvedValueOnce({ kind: 'needsConfirm', leftovers: [{ repo: 'claims-core', files: ['src/new.rs'] }] });
      Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent!.trim() === 'Start build')!.click();
      await settle();
      await confirmPreview();
      await vi.waitFor(() => expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull());
      const confirm = document.body.querySelector('[role="alertdialog"]')!;
      expect(text(confirm)).toContain('Continue on top of leftovers?');
      expect(Array.from(confirm.querySelectorAll('li')).map((li) => text(li))).toEqual(['claims-core: src/new.rs']);
    });
  });

  describe('plan tab banners', () => {
    const REASSIGN = '2026-10-09-adjuster-reassign';
    const staged = (stage: ChangeInfo['stage'], out_of_date: ChangeInfo['out_of_date'] = null) => {
      const transport = new MockTransport();
      const real = transport.sdlcChanges.bind(transport);
      vi.spyOn(transport, 'sdlcChanges').mockImplementation(async (m, s) =>
        (await real(m, s)).map((c) => (c.change === REASSIGN ? { ...c, stage, out_of_date } : c)),
      );
      return transport;
    };
    const banner = (c: HTMLElement) => c.querySelector('[data-testid="plan-banner"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? null;

    it('accept plan is the primary action at plan-awaiting', async () => {
      const { container } = await mount(REASSIGN);
      expect(labels(container)).toContain('Accept plan');
      expect(banner(container)).toBeNull();
    });

    it('a superseded plan shows its banner and only Re-run plan (R1.3)', async () => {
      const { container } = await mount(REASSIGN, staged('plan-superseded'));
      expect(banner(container)).toBe('The intent was reopened after this plan was written. Rewrite the plan before building.');
      const all = labels(container);
      expect(all).toContain('Re-run plan');
      expect(all).not.toContain('Start build');
      expect(all).not.toContain('Accept plan');
    });

    it.each([
      ['plan-pin', 'This plan was not written from the spec accepted now. Rewrite the plan before building.', 'Re-run plan'],
      ['spec-pin', 'This spec was not written from the intent accepted now. Rewrite the spec, then the plan.', 'Reopen spec'],
    ] as const)('out-of-date plan and spec banners and actions (R1.4) %s', async (cause, text, action) => {
      const { container } = await mount(REASSIGN, staged('plan-out-of-date', cause));
      expect(banner(container)).toBe(text);
      expect(labels(container)).toContain(action);
      expect(labels(container)).not.toContain(action === 'Re-run plan' ? 'Reopen spec' : 'Re-run plan');
      expect(labels(container)).not.toContain('Start build');
    });

    it.each([
      ['intent-reopened', 'The intent was reopened.'],
      ['spec-reopened', 'The spec was reopened.'],
    ] as const)('a reopened intent or spec is named and blocks the build (R1.5) %s', async (cause, text) => {
      const { container } = await mount(REASSIGN, staged('plan-out-of-date', cause));
      expect(banner(container)).toBe(text);
      expect(labels(container)).not.toContain('Start build');
      expect(labels(container)).not.toContain('Continue build');
    });

    it.each([
      ['intent-awaiting', 'The intent was reopened.', 'Accept intent'],
      ['intent-in-progress', 'The intent was reopened.', 'Continue intent'],
      ['spec-awaiting', 'The spec was reopened.', 'Accept spec'],
    ] as const)('a reopened document of a change with a plan is named beside its own actions (R1.5) %s', async (stage, text, action) => {
      const { container } = await mount(REASSIGN, staged(stage));
      expect(banner(container)).toBe(text);
      expect(labels(container)).toContain(action);
      expect(labels(container)).not.toContain('Start build');
      expect(labels(container)).not.toContain('Continue build');
    });

    it.each([
      ['intent-awaiting', 'The intent was reopened. The plan must be rewritten first.', 'Accept intent'],
      ['intent-in-progress', 'The intent was reopened. The plan must be rewritten first.', 'Continue intent'],
      ['spec-awaiting', 'The spec was reopened. The plan must be rewritten first.', 'Accept spec'],
    ] as const)('a reopened document over a superseded plan also says the plan must be rewritten first (R1.3) %s', async (stage, text, action) => {
      const transport = new MockTransport();
      const real = transport.sdlcChanges.bind(transport);
      vi.spyOn(transport, 'sdlcChanges').mockImplementation(async (m, s) =>
        (await real(m, s)).map((c) =>
          c.change === REASSIGN ? { ...c, stage, out_of_date: null, plan: { ...c.plan, exists: true, status: 'superseded' } } : c,
        ),
      );
      const { container } = await mount(REASSIGN, transport);
      expect(banner(container)).toBe(text);
      expect(labels(container)).toContain(action);
      expect(labels(container)).not.toContain('Start build');
    });

    it('a change without a plan has no reopened banner at intent-awaiting', async () => {
      const transport = new MockTransport();
      const real = transport.sdlcChanges.bind(transport);
      vi.spyOn(transport, 'sdlcChanges').mockImplementation(async (m, s) =>
        (await real(m, s)).map((c) =>
          c.change === REASSIGN ? { ...c, stage: 'intent-awaiting' as const, plan: { ...c.plan, exists: false } } : c,
        ),
      );
      const { container } = await mount(REASSIGN, transport);
      expect(banner(container)).toBeNull();
    });
  });
});

describe('ChangePage after the pull requests', () => {
  let draw: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    draw = vi.spyOn(diagrams, 'render').mockResolvedValue('<svg></svg>');
  });
  afterEach(() => draw.mockRestore());

  const finishedTransport = () => {
    const transport = new MockTransport();
    const real = transport.sdlcChanges.bind(transport);
    vi.spyOn(transport, 'sdlcChanges').mockImplementation(async (m, s) =>
      (await real(m, s)).map((c) => (c.change === MOCK_BUILD_CHANGE ? { ...c, stage: 'build-finished' as const } : c)),
    );
    return transport;
  };
  const openAll = async (transport: MockTransport) => {
    await transport.sdlcPublish('f', 'claims-intent', 'claims', MOCK_BUILD_CHANGE, await transport.sdlcTouchedRepos('f', 'claims-intent', 'claims', MOCK_BUILD_CHANGE));
  };

  it('change page shows Done when every pull request is open (R14.1)', async () => {
    const transport = finishedTransport();
    await openAll(transport);
    const { container } = await mount(MOCK_BUILD_CHANGE, transport);
    expect(container.querySelector('header')!.textContent).toContain('Build · done');
    expect(container.textContent).not.toContain('Build · finished, not yet done');
    expect(labels(container)).not.toContain('Declare done');
    expect(labels(container)).not.toContain('Another round');
    expect(container.querySelector('nav[aria-label="Pull requests"]')).not.toBeNull();
    expect(container.querySelector('header [data-testid="pr-menu"]')!.textContent).toContain('3 PRs');
  });

  it('an unfinished set of pull requests keeps the finished label and its action', async () => {
    const { container } = await mount(MOCK_BUILD_CHANGE, finishedTransport());
    expect(container.textContent).toContain('Build · finished, not yet done');
    expect(labels(container)).toContain('Declare done');
    expect(container.querySelector('header a')).toBeNull();
  });

  it('unreachable GitHub keeps the finished label with a note', async () => {
    const transport = finishedTransport();
    await openAll(transport);
    vi.spyOn(transport, 'sdlcPullRequests').mockRejectedValue(new Error('GitHub could not be reached. Try again later.'));
    const { container } = await mount(MOCK_BUILD_CHANGE, transport);
    expect(container.textContent).toContain('Build · finished, not yet done');
    expect(container.querySelector('[data-testid="pr-note"]')!.textContent).toContain('Could not check pull requests');
    expect(container.querySelector('header a')).toBeNull();
  });
});

describe('ChangePage build page', () => {
  const text = (e: Element) => e.textContent!.replace(/\s+/g, ' ').trim();
  const button = (root: ParentNode, label: string) => Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((b) => text(b) === label);
  const page = (c: HTMLElement) => c.querySelector('app-build-page')!;
  const pill = (c: HTMLElement, start: string) => Array.from(c.querySelectorAll<HTMLButtonElement>('header [role="tab"]')).find((t) => text(t).startsWith(start))!;
  const area = (c: HTMLElement, name: string) => page(c).querySelector(`[data-area="${name}"]`);
  const TOKEN = 20000;
  const REVIEW = {
    layout: 2,
    problems: [],
    master_moved: [],
    reviews: [{ number: 1, reviewed_at: '2026-10-19', commits: {}, findings: [{ id: 'F1', severity: 'medium', file: 'src/upload.ts', line: 10, text: 'The refusal message has no test.' }] }],
  } as unknown as Awaited<ReturnType<MockTransport['sdlcReviewRecord']>>;

  let draw: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    draw = vi.spyOn(diagrams, 'render').mockResolvedValue('<svg></svg>');
    vi.spyOn(monaco, 'load').mockReturnValue(new Promise(() => undefined));
  });
  afterEach(() => {
    draw.mockRestore();
    vi.restoreAllMocks();
  });

  const staged = (stage: ChangeInfo['stage'], transport = new MockTransport()) => {
    const real = transport.sdlcChanges.bind(transport);
    vi.spyOn(transport, 'sdlcChanges').mockImplementation(async (m, s) => (await real(m, s)).map((c) => (c.change === MOCK_BUILD_CHANGE ? { ...c, stage } : c)));
    return transport;
  };
  const finished = () => {
    const transport = staged('build-finished');
    vi.spyOn(transport, 'sdlcReviewRecord').mockResolvedValue(REVIEW);
    return transport;
  };
  /** Stop the build the test started and wait until the page has given the lock back. */
  const stopBuild = async (fixture: { debugElement: { injector: { get: <T>(t: new (...a: never[]) => T) => T } } }) => {
    fixture.debugElement.injector.get(BuildPageViewModel).cancelBuild();
    await vi.waitFor(
      () => {
        TestBed.tick();
        expect(TestBed.inject(LockStore).active()).toBeNull();
      },
      { timeout: TOKEN },
    );
  };
  const startBuild = async (c: HTMLElement) => {
    button(page(c), 'Start build')!.click();
    await settle();
    await confirmPreview();
  };

  it('accepting the plan offers the Build tab with tasks, activity and changed files', async () => {
    const transport = new MockTransport();
    const real = transport.sdlcChanges.bind(transport);
    const decide = transport.sdlcDecide.bind(transport);
    let accepted = false;
    vi.spyOn(transport, 'sdlcChanges').mockImplementation(async (m, s) =>
      (await real(m, s)).map((c) => (c.change === MOCK_BUILD_CHANGE && !accepted ? { ...c, stage: 'plan-awaiting' as const } : c)),
    );
    vi.spyOn(transport, 'sdlcDecide').mockImplementation(async (m, s, c, d, confirmed) => {
      accepted = true;
      return decide(m, s, c, d, confirmed);
    });
    const { container } = await mount(MOCK_BUILD_CHANGE, transport);
    expect(page(container)).toBeNull();
    expect(pill(container, 'Build').disabled).toBe(true);
    button(container, 'Accept plan')!.click();
    await vi.waitFor(() => expect(page(container)).not.toBeNull());
    await settle();
    expect(pill(container, 'Build').disabled).toBe(false);
    expect(pill(container, 'Build').getAttribute('aria-selected')).toBe('true');
    expect(Array.from(page(container).querySelectorAll('[data-heading] .k-bp__name')).map(text)).toEqual(expect.arrayContaining(['claims-core', 'customer-portal']));
    expect(area(container, 'tasks')!.querySelectorAll('[data-task]').length).toBe(3);
    expect(area(container, 'activity')).not.toBeNull();
    expect(area(container, 'files')!.querySelector('app-changes-view')).not.toBeNull();
  });

  it('before acceptance the tasks stay on the plan and there is no Build tab', async () => {
    const { container } = await mount(MOCK_BUILD_CHANGE, staged('plan-awaiting'));
    expect(container.querySelector('nav[aria-label="Tasks"]')).not.toBeNull();
    expect(page(container)).toBeNull();
    expect(pill(container, 'Build').disabled).toBe(true);
    expect(text(pill(container, 'Build'))).toBe('Build · locked');
    pill(container, 'Build').click();
    await settle();
    expect(page(container)).toBeNull();
    expect(container.querySelector('nav[aria-label="Tasks"]')).not.toBeNull();
  });

  it.each(['build-ready', 'build-stopped', 'build-finished'] as const)('a change in the build stage opens on its Build tab (%s)', async (stage) => {
    const { container } = await mount(MOCK_BUILD_CHANGE, staged(stage));
    expect(pill(container, 'Build').getAttribute('aria-selected')).toBe('true');
    expect(page(container)).not.toBeNull();
    expect(container.querySelector('app-doc-layout')).toBeNull();
    expect(container.querySelector('[data-testid="strip"]')).toBeNull();
  });

  it('continuing a stopped repository confirms the leftovers and runs on the same page', async () => {
    const { container, fixture, transport } = await mount(MOCK_BUILD_CHANGE);
    const runner = TestBed.inject(SdlcRunner);
    const real = runner.runInRepo.bind(runner);
    const run = vi.spyOn(runner, 'runInRepo').mockImplementation(async (target, spec, link) => {
      if (run.mock.calls.length <= 2) {
        link.onRun?.(`fake-${target.repo}`);
        return { exit: 124, error: null };
      }
      return real(target, spec, link);
    });
    await startBuild(container);
    await vi.waitFor(() => expect(button(page(container), 'Continue claims-core')).toBeDefined(), { timeout: TOKEN });
    const prepare = vi.spyOn(transport, 'sdlcBuildPrepare');
    prepare.mockResolvedValueOnce({ kind: 'needsConfirm', leftovers: [{ repo: 'claims-core', files: ['src/new.rs'] }] });
    button(page(container), 'Continue claims-core')!.click();
    await settle();
    await confirmPreview();
    await vi.waitFor(() => expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull(), { timeout: TOKEN });
    const confirm = document.body.querySelector('[role="alertdialog"]')!;
    expect(text(confirm)).toContain('Continue on top of leftovers?');
    expect(Array.from(confirm.querySelectorAll('li')).map(text)).toEqual(['claims-core: src/new.rs']);
    expect(run).toHaveBeenCalledTimes(2);
    button(confirm, 'Continue')!.click();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3), { timeout: TOKEN });
    expect(prepare.mock.calls.at(-1)![4]).toBe(true);
    expect(page(container)).not.toBeNull();
    expect(container.querySelector('app-build-view')).toBeNull();
    await stopBuild(fixture);
  });

  it('a round runs and is watched on the same page', async () => {
    const { container, fixture, transport } = await mount(MOCK_BUILD_CHANGE, finished());
    const prepare = vi.spyOn(transport, 'sdlcBuildPrepare');
    const runSpec = vi.spyOn(transport, 'runSpec');
    button(page(container), 'Another round')!.click();
    await settle();
    const dialog = () => document.body.querySelector('[role="dialog"]')!;
    expect(text(dialog().querySelector('[hlmDialogTitle]')!)).toBe('Start round');
    const preview = fixture.debugElement.injector.get(RunPreviewViewModel);
    await vi.waitFor(() => expect(preview.buildForm()).not.toBeNull());
    preview.buildForm()!.model.update((m) => ({ ...m, instructions: 'tidy up', repo: 'claims-core' }));
    await confirmPreview();
    await vi.waitFor(() => expect(runSpec).toHaveBeenCalled(), { timeout: TOKEN });
    expect(prepare.mock.calls[0][6]).toBe('round');
    await vi.waitFor(() => expect(page(container).querySelector('[data-session] app-observe-pane')).not.toBeNull(), { timeout: TOKEN });
    expect(page(container)).not.toBeNull();
    expect(container.querySelector('app-build-view')).toBeNull();
    await stopBuild(fixture);
  });

  describe('each of today’s build actions is on the build page', () => {
    /** The page component, to drive its outputs the way the template does. */
    const pageOf = (fixture: ComponentFixture<ChangePage>) => fixture.debugElement.query(By.directive(BuildPage)).componentInstance as BuildPage;
    const alone = (c: HTMLElement) => {
      expect(page(c)).not.toBeNull();
      expect(c.querySelector('app-build-view')).toBeNull();
      expect(c.querySelectorAll('app-changes-view').length).toBeLessThanOrEqual(1);
      if (c.querySelector('app-changes-view')) expect(page(c).querySelector('app-changes-view')).not.toBeNull();
    };
    const startUntilAsked = async (c: HTMLElement) => {
      await startBuild(c);
      await vi.waitFor(() => expect(page(c).querySelector('.k-ask:not(.k-ask--answered)')).not.toBeNull(), { timeout: TOKEN });
    };

    it('answer a question', async () => {
      const { container, fixture } = await mount(MOCK_BUILD_CHANGE);
      await startUntilAsked(container);
      alone(container);
      const lock = TestBed.inject(LockStore);
      const answer = vi.spyOn(lock, 'answer');
      pageOf(fixture).answer.emit({ runId: 'r1', id: 'q1', answers: [['Reuse it']] });
      expect(answer).toHaveBeenCalledWith('r1', 'q1', [['Reuse it']]);
      await stopBuild(fixture);
    }, TOKEN);

    it('approve or refuse an action', async () => {
      const { container, fixture } = await mount(MOCK_BUILD_CHANGE);
      await startUntilAsked(container);
      alone(container);
      const decide = vi.spyOn(TestBed.inject(LockStore), 'decide');
      pageOf(fixture).decide.emit({ runId: 'r1', id: 'p1', allow: false, message: 'not that' });
      expect(decide).toHaveBeenCalledWith('r1', 'p1', false, 'not that');
      await stopBuild(fixture);
    }, TOKEN);

    it('cancel the build', async () => {
      const { container, fixture } = await mount(MOCK_BUILD_CHANGE);
      await startUntilAsked(container);
      alone(container);
      button(page(container), 'Cancel build')!.click();
      await vi.waitFor(() => expect(TestBed.inject(LockStore).active()).toBeNull(), { timeout: TOKEN });
      await settle();
      expect(text(page(container).querySelector('[data-stage]')!)).toContain('The build was cancelled.');
      expect(fixture.debugElement.injector.get(BuildPageViewModel).stage()).toBe('cancelled');
    }, TOKEN);

    it('cancel one repository', async () => {
      const { container, fixture } = await mount(MOCK_BUILD_CHANGE);
      await startUntilAsked(container);
      alone(container);
      const heading = Array.from(page(container).querySelectorAll('[data-heading]')).find((h) => text(h.querySelector('.k-bp__name')!) === 'claims-core')!;
      button(heading, 'Cancel')!.click();
      await vi.waitFor(() => expect(button(page(container), 'Continue claims-core')).toBeDefined(), { timeout: TOKEN });
      await stopBuild(fixture);
    }, TOKEN);

    it('continue a repository', async () => {
      const { container, fixture } = await mount(MOCK_BUILD_CHANGE);
      await startUntilAsked(container);
      const heading = Array.from(page(container).querySelectorAll('[data-heading]')).find((h) => text(h.querySelector('.k-bp__name')!) === 'claims-core')!;
      button(heading, 'Cancel')!.click();
      await vi.waitFor(() => expect(button(page(container), 'Continue claims-core')).toBeDefined(), { timeout: TOKEN });
      button(page(container), 'Continue claims-core')!.click();
      await settle();
      expect(text(document.body.querySelector('[role="dialog"] [hlmDialogTitle]')!)).toBe('Continue claims-core');
      alone(container);
      await stopBuild(fixture);
    }, TOKEN);

    it('ask for another round', async () => {
      const { container } = await mount(MOCK_BUILD_CHANGE, finished());
      alone(container);
      button(page(container), 'Another round')!.click();
      await settle();
      expect(text(document.body.querySelector('[role="dialog"] [hlmDialogTitle]')!)).toBe('Start round');
    });

    it('run the review again', async () => {
      const { container } = await mount(MOCK_BUILD_CHANGE, finished());
      alone(container);
      button(page(container), 'Run review')!.click();
      await settle();
      expect(text(document.body.querySelector('[role="dialog"] [hlmDialogTitle]')!)).toBe('Run review');
    });

    it('read the review', async () => {
      const { container } = await mount(MOCK_BUILD_CHANGE, finished());
      alone(container);
      page(container).querySelector<HTMLButtonElement>('[data-review]')!.click();
      await settle();
      expect(page(container).querySelector('app-findings-list')).not.toBeNull();
      expect(text(page(container).querySelector('app-findings-list')!)).toContain('The refusal message has no test.');
    });

    it.each([
      ['view the whole change', 'Whole change'],
      ['view only committed work', 'Committed'],
      ['view only uncommitted work', 'Uncommitted'],
    ])('%s', async (_row, label) => {
      const { container } = await mount(MOCK_BUILD_CHANGE, finished());
      alone(container);
      const radio = Array.from(page(container).querySelectorAll<HTMLButtonElement>('app-changes-view [role="radio"]')).find((r) => text(r) === label)!;
      radio.click();
      await settle();
      expect(radio.getAttribute('aria-checked')).toBe('true');
    });

    it('see departures from the plan', async () => {
      const transport = finished();
      const status = transport.sdlcBuildStatus.bind(transport);
      vi.spyOn(transport, 'sdlcBuildStatus').mockImplementation(async (m, s, c) => {
        const got = await status(m, s, c);
        return { ...got, tasks: got.tasks.map((t) => (t.id === 'T2' ? { ...t, row: { task: 'T2', repo: t.repo, commits: ['abc1234'], departure: 'Reused the existing file picker.' } } : t)) };
      });
      const { container } = await mount(MOCK_BUILD_CHANGE, transport);
      alone(container);
      expect(text(page(container).querySelector('[data-departure]')!)).toContain('Reused the existing file picker.');
    });

    it('declare done', async () => {
      const { container } = await mount(MOCK_BUILD_CHANGE, finished());
      alone(container);
      expect(button(page(container), 'Declare done')).toBeDefined();
    });

    it('see the pull requests that opened', async () => {
      const transport = finished();
      await transport.sdlcPublish('f', 'claims-intent', 'claims', MOCK_BUILD_CHANGE, await transport.sdlcTouchedRepos('f', 'claims-intent', 'claims', MOCK_BUILD_CHANGE));
      const { container } = await mount(MOCK_BUILD_CHANGE, transport);
      alone(container);
      expect(container.querySelector('header nav[aria-label="Pull requests"]')).not.toBeNull();
      expect(container.querySelector('header [data-testid="pr-menu"]')!.textContent).toContain('3 PRs');
      expect(button(page(container), 'Declare done')).toBeUndefined();
    });
  });
});
