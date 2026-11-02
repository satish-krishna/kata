import type { BuildStatus } from '@bindings/BuildStatus';
import type { CopyRemoval } from '@bindings/CopyRemoval';
import type { RemoveOutcome } from '@bindings/RemoveOutcome';
import type { ChangeInfo } from '../../lib/sdlc-mock-types';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, Router, convertToParamMap, provideRouter, type Routes } from '@angular/router';
import { of } from 'rxjs';
import { render } from '../../../testing/render';
import { RunPreviewViewModel } from '../../core/given/run-preview.view-model';
import { LockStore } from '../../core/lock/lock.store';
import { RunStore } from '../../core/run/run.store';
import { KataTransport } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import { diagrams } from '../../lib/mermaid';
import { MOCK_BUILD_CHANGE } from '../../lib/sdlc-mock';
import { BuildPage } from '../build/build-page';
import { BuildPageViewModel } from '../build/build-page.view-model';
import { ChangePage } from './change-page';

/** Every document run opens the preview first; confirm it once its rows have resolved. */
const confirmPreview = async (label = 'Start run') => {
  const start = () => Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === label);
  await vi.waitFor(() => expect(start() && !start()!.disabled).toBe(true));
  start()!.click();
};
const settle = async () => {
  for (let i = 0; i < 4; i++) {
    TestBed.tick();
    await new Promise((r) => setTimeout(r, 0));
  }
};
const PHOTOS_CHANGE = '2026-10-12-product-photo-upload';
const labels = (c: HTMLElement) => Array.from(c.querySelectorAll('button')).map((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim());

async function mount(change = PHOTOS_CHANGE, transport = new MockTransport(), routes: Routes = []) {
  const out = await render(ChangePage, {}, [
    provideRouter(routes),
    { provide: KataTransport, useValue: transport },
    { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ system: 'commerce', change })), snapshot: { queryParamMap: convertToParamMap({}) } } },
  ]);
  await settle();
  return { ...out, transport };
}

describe('ChangePage', () => {
  // The PHOTOS_CHANGE spec has a Mermaid diagram. A cold import of Mermaid under full-suite load blocks the
  // first mount's settle for seconds, past the 5s test timeout; these tests don't look at diagrams.
  let draw: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    draw = vi.spyOn(diagrams, 'render').mockResolvedValue('<svg></svg>');
  });
  afterEach(() => draw.mockRestore());

  it('shows the breadcrumb, the branch, the stage pills and the stage document', async () => {
    const { container } = await mount();
    expect(container.querySelector('nav')!.textContent).toContain(PHOTOS_CHANGE);
    expect(container.textContent).toContain('acme-commerce');
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
    await vi.waitFor(() => expect(container.querySelector('app-doc-layout h1')?.textContent).toBe('Photo upload on the product form'));
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
    transport.patchChange('2026-10-09-merchant-reassign', { stage: 'plan-ready' as const });
    const { container } = await mount('2026-10-09-merchant-reassign', transport);
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

  it('crosses the seam: clicking Accept spec calls sdlcAccept and the stepper moves on', async () => {
    const { container, transport } = await mount();
    const decide = vi.spyOn(transport, 'sdlcAccept');
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

    const tab = (c: HTMLElement, start: string) => Array.from(c.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((t) => t.textContent!.trim().startsWith(start))!;

    it('the plan tab lists the tasks from sdlcBuildStatus in the Tasks view', async () => {
      const { container, transport } = await mount(MOCK_BUILD_CHANGE);
      tab(container, 'Plan').click();
      await settle();
      const status = await transport.sdlcBuildStatus('', 'commerce', MOCK_BUILD_CHANGE);
      const nav = container.querySelector('nav[aria-label="Tasks"]')!;
      expect(nav).not.toBeNull();
      expect(nav.querySelectorAll('button').length).toBe(status.tasks.length);
      expect(container.querySelector('app-build-log-table')).toBeNull();
    });

    it('crosses the seam: clicking the Build pill shows what changed in the build panel', async () => {
      const { container } = await mount(MOCK_BUILD_CHANGE);
      const tile = tab(container, 'Build');
      expect(tile.disabled).toBe(false);
      tab(container, 'Plan').click();
      await settle();
      expect(container.querySelector('app-changes-view')).toBeNull();
      tile.click();
      await settle();
      expect(tile.getAttribute('aria-selected')).toBe('true');
      expect(container.querySelector('app-changes-view')).not.toBeNull();
      expect(container.querySelector('app-changes-view [data-repo]')).not.toBeNull();
      vi.restoreAllMocks();
    });

    it('keeps the build page on show once a build is started, never the session view or the build view', async () => {
      const { container, fixture } = await mount(MOCK_BUILD_CHANGE);
      expect(container.querySelector('app-build-view')).toBeNull();
      await fixture.debugElement.injector.get(BuildPageViewModel).startBuild({ timeoutSecs: 5400 });
      await settle();
      expect(container.querySelector('app-build-page')).not.toBeNull();
      expect(container.querySelector('app-build-view')).toBeNull();
      expect(container.querySelector('app-sdlc-session')).toBeNull();
    });

    it('shows no task list on a change without tasks', async () => {
      const { container } = await mount();
      expect(container.querySelector('nav[aria-label="Tasks"]')).toBeNull();
    });

    it('crosses the seam: clicking the rendered Start build opens the preview of the build, and Start run starts the build through the backend', async () => {
      const { container, transport } = await mount(MOCK_BUILD_CHANGE);
      const prepare = vi.spyOn(transport, 'sdlcBuildStart');
      Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent!.trim() === 'Start build')!.click();
      await settle();
      const dialog = document.body.querySelector('[role="dialog"]')!;
      expect(dialog).not.toBeNull();
      expect(text(dialog.querySelector('[hlmDialogTitle]')!)).toBe('Start build');
      expect(prepare).not.toHaveBeenCalled();
      await confirmPreview();
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    });

    it('a refused build opens the refusal dialog', async () => {
      const { container, transport } = await mount(MOCK_BUILD_CHANGE);
      vi.spyOn(transport, 'sdlcBuildStart').mockResolvedValue({ kind: 'refused', problems: ['The AI-SDLC mode needs ai-sdlc 1.1.0 or later; this machine has 0.7.9.', 'customer-portal: uncommitted files: a.txt'] });
      Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent!.trim() === 'Start build')!.click();
      await settle();
      await confirmPreview();
      await vi.waitFor(() => expect(document.body.textContent).toContain('The build did not start'));
      expect(document.body.textContent).toContain('The AI-SDLC mode needs ai-sdlc 1.1.0 or later; this machine has 0.7.9.');
      expect(document.body.textContent).toContain('customer-portal: uncommitted files: a.txt');
    });

  });

  describe('plan tab banners', () => {
    const REASSIGN = '2026-10-09-merchant-reassign';
    const staged = (stage: ChangeInfo['stage'], out_of_date: ChangeInfo['out_of_date'] = null) => {
      const transport = new MockTransport();
      transport.patchChange(REASSIGN, { stage, out_of_date });
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
      transport.patchChange(REASSIGN, { stage, out_of_date: null, plan: { exists: true, committed: true, status: 'superseded', head_status: 'draft' } });
      const { container } = await mount(REASSIGN, transport);
      expect(banner(container)).toBe(text);
      expect(labels(container)).toContain(action);
      expect(labels(container)).not.toContain('Start build');
    });

    it('a change without a plan has no reopened banner at intent-awaiting', async () => {
      const transport = new MockTransport();
      transport.patchChange(REASSIGN, { stage: 'intent-awaiting', plan: { exists: false, committed: false, status: null, head_status: null } });
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
    transport.patchChange(MOCK_BUILD_CHANGE, { stage: 'build-finished' as const });
    return allBuilt(transport);
  };
  const openAll = async (transport: MockTransport) => {
    await transport.sdlcDeclareDone({ workspace: 'f', system: 'commerce', change: MOCK_BUILD_CHANGE });
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
    vi.spyOn(transport, 'sdlcPullRequestsView').mockRejectedValue(new Error('the recorded pull requests could not be read'));
    const { container } = await mount(MOCK_BUILD_CHANGE, transport);
    expect(container.textContent).toContain('Build · finished, not yet done');
    expect(container.querySelector('[data-testid="pr-note"]')!.textContent).toContain('Could not check pull requests');
    expect(container.querySelector('header a')).toBeNull();
  });
});

/** The build log of a finished change: every task has its row and every repository is done, as the page requires of a stage past the build. */
function allBuilt(transport: MockTransport, edit: (status: BuildStatus) => BuildStatus = (status) => status) {
  const status = transport.sdlcBuildStatus.bind(transport);
  vi.spyOn(transport, 'sdlcBuildStatus').mockImplementation(async (m, s, c) => {
    const got = await status(m, s, c);
    return edit({
      ...got,
      repos: got.repos.map((r) => ({ ...r, firstUnfinished: null, state: { kind: 'done' as const }, finished: r.tasks })),
      tasks: got.tasks.map((t) => ({ ...t, row: { task: t.id, repo: t.repo, commits: [`${t.id.toLowerCase()}c0ffee`], departure: null } })),
    });
  });
  return transport;
}

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
    reviews: [{ number: 1, reviewed_at: '2026-10-19', commits: { 'commerce-docs': '1111111', 'commerce-core': '2222222', 'customer-portal': '3333333' }, findings: [{ id: 'F1', severity: 'medium', file: 'src/upload.ts', line: 10, text: 'The refusal message has no test.' }] }],
  } as unknown as Awaited<ReturnType<MockTransport['sdlcReviewRecord']>>;

  let draw: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    draw = vi.spyOn(diagrams, 'render').mockResolvedValue('<svg></svg>');
  });
  afterEach(() => {
    draw.mockRestore();
    vi.restoreAllMocks();
  });

  const staged = (stage: ChangeInfo['stage'], transport = new MockTransport()) => {
    transport.patchChange(MOCK_BUILD_CHANGE, { stage });
    return transport;
  };
  /** A finished build: every task has its build log row, as the page requires of a stage past the build. */
  const finished = (edit?: (status: BuildStatus) => BuildStatus) => {
    const transport = allBuilt(staged('build-finished'), edit);
    vi.spyOn(transport, 'sdlcReviewRecord').mockResolvedValue(REVIEW);
    return transport;
  };
  /** Stop the build the test started and wait until the backend says it has stopped. */
  const stopBuild = async (fixture: { debugElement: { injector: { get: <T>(t: new (...a: never[]) => T) => T } } }) => {
    fixture.debugElement.injector.get(BuildPageViewModel).cancelBuild();
    await vi.waitFor(
      () => {
        TestBed.tick();
        expect(fixture.debugElement.injector.get(BuildPageViewModel).active()).toBe(false);
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
    // The mock's accept-plan moves the change on to build-ready, replacing the stage patched here.
    transport.patchChange(MOCK_BUILD_CHANGE, { stage: 'plan-awaiting' });
    const { container } = await mount(MOCK_BUILD_CHANGE, transport);
    expect(page(container)).toBeNull();
    expect(pill(container, 'Build').disabled).toBe(true);
    button(container, 'Accept plan')!.click();
    await vi.waitFor(() => expect(page(container)).not.toBeNull());
    await settle();
    expect(pill(container, 'Build').disabled).toBe(false);
    expect(pill(container, 'Build').getAttribute('aria-selected')).toBe('true');
    expect(Array.from(page(container).querySelectorAll('[data-heading] .k-bp__name')).map(text)).toEqual(expect.arrayContaining(['commerce-core', 'customer-portal']));
    expect(area(container, 'tasks')!.querySelectorAll('[data-task]').length).toBe(3);
    // Nothing has run yet, so the activity area is in the grid with nothing to show; the changed files are.
    expect(area(container, 'activity')!.querySelector('app-observe-pane')).toBeNull();
    expect(text(area(container, 'activity')!)).toContain('The activity shows here once the build runs.');
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
    const { container } = await mount(MOCK_BUILD_CHANGE, stage === 'build-finished' ? finished() : staged(stage));
    expect(pill(container, 'Build').getAttribute('aria-selected')).toBe('true');
    expect(page(container)).not.toBeNull();
    expect(container.querySelector('app-doc-layout')).toBeNull();
    expect(container.querySelector('[data-testid="strip"]')).toBeNull();
  });

  it('the Build tab ties changed files to their tasks and narrows them to a picked task', async () => {
    const { container, fixture } = await mount(MOCK_BUILD_CHANGE, finished());
    const files = () => area(container, 'files')!;
    const inRepo = (repo: string, path: string) => files().querySelector(`[aria-label="Files changed in ${repo}"] [data-file="${path}"]`);
    const heads = () => Array.from(files().querySelectorAll<HTMLElement>('app-repo-file-list [data-repo]'));
    await vi.waitFor(() => expect(heads().length).toBeGreaterThan(1), { timeout: TOKEN });
    const core = heads().find((h) => text(h).startsWith('commerce-core'))!;
    if (core.getAttribute('aria-expanded') !== 'true') core.click();
    await vi.waitFor(() => expect(inRepo('commerce-core', 'src/attachments.rs')).not.toBeNull(), { timeout: TOKEN });
    // Unpicked, a file shows the task whose commit changed it.
    await vi.waitFor(() => expect(inRepo('commerce-core', 'src/attachments.rs')!.querySelector('[data-tasks]')?.textContent?.trim()).toBe('T1'), { timeout: TOKEN });
    fixture.debugElement.injector.get(BuildPageViewModel).choose({ kind: 'task', task: 'T1' });
    await vi.waitFor(
      () => {
        TestBed.tick();
        expect(heads()).toHaveLength(1);
      },
      { timeout: TOKEN },
    );
    expect(text(heads()[0])).toContain('commerce-core');
    expect(files().querySelector('[data-file="src/limits.rs"]')).toBeNull();
  });

  it('continuing a stopped repository opens its preview and runs on the same page', async () => {
    const { container, fixture, transport } = await mount(MOCK_BUILD_CHANGE);
    await startBuild(container);
    const heading = () => Array.from(page(container).querySelectorAll('[data-heading]')).find((h) => text(h.querySelector('.k-bp__name')!) === 'commerce-core')!;
    await vi.waitFor(() => expect(button(heading(), 'Cancel')).toBeDefined(), { timeout: TOKEN });
    button(heading(), 'Cancel')!.click();
    await vi.waitFor(() => expect(button(page(container), 'Continue commerce-core')).toBeDefined(), { timeout: TOKEN });
    const resume = vi.spyOn(transport, 'sdlcBuildContinue');
    button(page(container), 'Continue commerce-core')!.click();
    await settle();
    expect(text(document.body.querySelector('[role="dialog"] [hlmDialogTitle]')!)).toBe('Continue commerce-core');
    await confirmPreview();
    await vi.waitFor(() => expect(resume).toHaveBeenCalledWith(expect.objectContaining({ change: MOCK_BUILD_CHANGE }), 'commerce-core', expect.any(Array)), { timeout: TOKEN });
    expect(page(container)).not.toBeNull();
    expect(container.querySelector('app-build-view')).toBeNull();
    await stopBuild(fixture);
  }, 30000);

  it('reads the change again once the build ends, so its stage, its pill and Declare done follow the build', async () => {
    const { container, fixture, transport } = await mount(MOCK_BUILD_CHANGE);
    await startBuild(container);
    await vi.waitFor(
      () => {
        TestBed.tick();
        expect(fixture.debugElement.injector.get(BuildPageViewModel).active()).toBe(true);
      },
      { timeout: TOKEN },
    );
    const changes = vi.spyOn(transport, 'sdlcChangeState');
    await stopBuild(fixture);
    await vi.waitFor(
      () => {
        TestBed.tick();
        expect(changes).toHaveBeenCalled();
      },
      { timeout: TOKEN },
    );
    expect(page(container)).not.toBeNull();
  }, 30000);

  it('a round runs and is watched on the same page', async () => {
    const { container, fixture, transport } = await mount(MOCK_BUILD_CHANGE, finished());
    const prepare = vi.spyOn(transport, 'sdlcBuildStart');
    button(page(container), 'Another round')!.click();
    await settle();
    const dialog = () => document.body.querySelector('[role="dialog"]')!;
    expect(text(dialog().querySelector('[hlmDialogTitle]')!)).toBe('Start round');
    const preview = fixture.debugElement.injector.get(RunPreviewViewModel);
    await vi.waitFor(() => expect(preview.buildForm()).not.toBeNull());
    preview.buildForm()!.model.update((m) => ({ ...m, picked: [], notes: { ...m.notes, 'commerce-core': 'tidy up' } }));
    await confirmPreview('Start 1 agent');
    await vi.waitFor(() => expect(prepare).toHaveBeenCalled(), { timeout: TOKEN });
    expect(prepare.mock.calls[0][1].rounds!.map((r) => r.repo)).toEqual(['commerce-core']);
    await vi.waitFor(() => expect(page(container).querySelector('[data-session] app-observe-pane')).not.toBeNull(), { timeout: TOKEN });
    expect(page(container)).not.toBeNull();
    expect(container.querySelector('app-build-view')).toBeNull();
    await stopBuild(fixture);
  });

  it('R6.1: a build run in one repository offers the message box, and sending reaches that run', async () => {
    const { container, fixture, transport } = await mount(MOCK_BUILD_CHANGE);
    await startBuild(container);
    const send = vi.spyOn(transport, 'sendMessage');
    const input = () => page(container).querySelector<HTMLInputElement>('[data-session] app-message-box [data-message-input]');
    // The scripted build is running before its first question; the box is enabled only then.
    await vi.waitFor(
      () => {
        TestBed.tick();
        expect(input() !== null && !input()!.disabled).toBe(true);
      },
      { timeout: TOKEN },
    );
    const runId = input()!.closest('[data-session]')!.getAttribute('data-session')!;
    input()!.value = 'skip the refactor';
    input()!.dispatchEvent(new Event('input'));
    TestBed.tick();
    page(container).querySelector<HTMLButtonElement>('[data-session] [data-message-send]')!.click();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(runId, expect.any(String), 'skip the refactor');
    await stopBuild(fixture);
  }, TOKEN);

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
      const answer = vi.spyOn(TestBed.inject(RunStore), 'submitAnswer');
      pageOf(fixture).answer.emit({ runId: 'r1', id: 'q1', answers: [['Reuse it']] });
      expect(answer).toHaveBeenCalledWith('r1', 'q1', [['Reuse it']]);
      await stopBuild(fixture);
    }, TOKEN);

    it('approve or refuse an action', async () => {
      const { container, fixture } = await mount(MOCK_BUILD_CHANGE);
      await startUntilAsked(container);
      alone(container);
      const decide = vi.spyOn(TestBed.inject(RunStore), 'submitDecision');
      pageOf(fixture).decide.emit({ runId: 'r1', id: 'p1', allow: false, message: 'not that' });
      expect(decide).toHaveBeenCalledWith('r1', 'p1', false, 'not that');
      await stopBuild(fixture);
    }, TOKEN);

    it('answer a question through the observe pane inside the page', async () => {
      const { container, fixture, transport } = await mount(MOCK_BUILD_CHANGE);
      await startUntilAsked(container);
      const submit = vi.spyOn(transport, 'submitAnswer');
      const session = page(container).querySelector('[data-session]:has(.k-ask:not(.k-ask--answered))')!;
      const runId = session.getAttribute('data-session')!;
      const choice = Array.from(session.querySelectorAll<HTMLInputElement>('.k-ask:not(.k-ask--answered) input')).find((i) => i.value === 'Reuse it')!;
      choice.click();
      await settle();
      Array.from(session.querySelectorAll<HTMLButtonElement>('.k-ask button')).find((b) => text(b).startsWith('Send answer'))!.click();
      await vi.waitFor(() => expect(submit).toHaveBeenCalledWith(runId, 'q1', [['Reuse it']]), { timeout: TOKEN });
      await stopBuild(fixture);
    }, TOKEN);

    it('approve or refuse an action through the observe pane inside the page', async () => {
      const { container, fixture, transport } = await mount(MOCK_BUILD_CHANGE);
      await startUntilAsked(container);
      const session = page(container).querySelector('[data-session]:has(.k-ask:not(.k-ask--answered))')!;
      const runId = session.getAttribute('data-session')!;
      const decide = vi.spyOn(transport, 'submitDecision');
      transport['emit'](runId, { type: 'permission.requested', id: 'p1', tool: 'Bash', input_summary: 'git push' });
      await vi.waitFor(
        () => {
          TestBed.tick();
          expect(session.querySelector('app-permission-panel')).not.toBeNull();
        },
        { timeout: TOKEN },
      );
      const reason = session.querySelector<HTMLTextAreaElement>('app-permission-panel textarea')!;
      reason.value = 'not that';
      reason.dispatchEvent(new Event('input'));
      await settle();
      Array.from(session.querySelectorAll<HTMLButtonElement>('app-permission-panel button')).find((b) => text(b) === 'Deny')!.click();
      await vi.waitFor(() => expect(decide).toHaveBeenCalledWith(runId, 'p1', false, 'not that'), { timeout: TOKEN });
      await stopBuild(fixture);
    }, TOKEN);

    it('cancel the build', async () => {
      const { container, fixture } = await mount(MOCK_BUILD_CHANGE);
      await startUntilAsked(container);
      alone(container);
      button(page(container), 'Cancel build')!.click();
      await vi.waitFor(() => expect(fixture.debugElement.injector.get(BuildPageViewModel).active()).toBe(false), { timeout: TOKEN });
      await settle();
      expect(text(page(container).querySelector('[data-stage]')!)).toContain('The build was cancelled.');
      expect(fixture.debugElement.injector.get(BuildPageViewModel).stage()).toBe('cancelled');
    }, TOKEN);

    it('cancel one repository', async () => {
      const { container, fixture } = await mount(MOCK_BUILD_CHANGE);
      await startUntilAsked(container);
      alone(container);
      const heading = Array.from(page(container).querySelectorAll('[data-heading]')).find((h) => text(h.querySelector('.k-bp__name')!) === 'commerce-core')!;
      button(heading, 'Cancel')!.click();
      await vi.waitFor(() => expect(button(page(container), 'Continue commerce-core')).toBeDefined(), { timeout: TOKEN });
      await stopBuild(fixture);
    }, TOKEN);

    it('continue a repository', async () => {
      const { container, fixture } = await mount(MOCK_BUILD_CHANGE);
      await startUntilAsked(container);
      const heading = Array.from(page(container).querySelectorAll('[data-heading]')).find((h) => text(h.querySelector('.k-bp__name')!) === 'commerce-core')!;
      button(heading, 'Cancel')!.click();
      await vi.waitFor(() => expect(button(page(container), 'Continue commerce-core')).toBeDefined(), { timeout: TOKEN });
      button(page(container), 'Continue commerce-core')!.click();
      await settle();
      expect(text(document.body.querySelector('[role="dialog"] [hlmDialogTitle]')!)).toBe('Continue commerce-core');
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
      const transport = finished((got) => ({
        ...got,
        tasks: got.tasks.map((t) => (t.id === 'T2' ? { ...t, row: { task: 'T2', repo: t.repo, commits: ['abc1234'], departure: 'Reused the existing file picker.' } } : t)),
      }));
      const { container } = await mount(MOCK_BUILD_CHANGE, transport);
      alone(container);
      // The row only says departed; the text shows above the activity once the task is picked.
      for (const f of Array.from(page(container).querySelectorAll<HTMLButtonElement>('[data-fold]'))) f.click();
      await settle();
      expect(text(page(container).querySelector('[data-departure]')!)).toBe('departed');
      Array.from(page(container).querySelectorAll<HTMLButtonElement>('[data-task]')).find((t) => text(t).startsWith('T2'))!.click();
      await settle();
      expect(text(page(container).querySelector('[data-pick-departure]')!)).toContain('Reused the existing file picker.');
    });

    it('declare done', async () => {
      const { container } = await mount(MOCK_BUILD_CHANGE, finished());
      alone(container);
      expect(button(page(container), 'Declare done')).toBeDefined();
    });

    it('see the pull requests that opened', async () => {
      const transport = finished();
      await transport.sdlcDeclareDone({ workspace: 'f', system: 'commerce', change: MOCK_BUILD_CHANGE });
      const { container } = await mount(MOCK_BUILD_CHANGE, transport);
      alone(container);
      expect(container.querySelector('header nav[aria-label="Pull requests"]')).not.toBeNull();
      expect(container.querySelector('header [data-testid="pr-menu"]')!.textContent).toContain('3 PRs');
      expect(button(page(container), 'Declare done')).toBeUndefined();
    });
  });
});

describe('ChangePage way back', () => {
  const BACK = 'button[aria-label="Back to the changes list"]';
  const back = (c: HTMLElement) => c.querySelector<HTMLButtonElement>(BACK);
  const text = (e: Element) => e.textContent!.replace(/\s+/g, ' ').trim();
  const routes: Routes = [{ path: 'sdlc', children: [] }];
  const staged = (stage: ChangeInfo['stage'], transport = new MockTransport()) => {
    transport.patchChange(MOCK_BUILD_CHANGE, { stage });
    return transport;
  };
  const doneTransport = async () => {
    const transport = allBuilt(staged('build-finished'));
    await transport.sdlcDeclareDone({ workspace: 'f', system: 'commerce', change: MOCK_BUILD_CHANGE });
    return transport;
  };

  let draw: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    draw = vi.spyOn(diagrams, 'render').mockResolvedValue('<svg></svg>');
  });
  afterEach(() => {
    draw.mockRestore();
    vi.restoreAllMocks();
  });

  const stages: [string, () => Promise<MockTransport>][] = [
    ['intent', async () => staged('intent-awaiting')],
    ['spec', async () => staged('spec-awaiting')],
    ['plan', async () => staged('plan-awaiting')],
    ['build', async () => staged('build-ready')],
    ['done', doneTransport],
    ['closed', async () => staged('rejected')],
  ];

  it.each(stages)('the way back from every stage lands on the workspace\'s changes list (%s)', async (_name, make) => {
    const { container } = await mount(MOCK_BUILD_CHANGE, await make(), routes);
    const router = TestBed.inject(Router);
    expect(router.url).not.toBe('/sdlc');
    const link = back(container)!;
    expect(text(link)).toBe('Changes');
    expect(link.disabled).toBe(false);
    link.click();
    await vi.waitFor(() => expect(router.url).toBe('/sdlc'));
  });

  it('the way back from a change that could not be found', async () => {
    const { container } = await mount('2026-01-01-nope', new MockTransport(), routes);
    expect(container.textContent).toContain('Change not found');
    const router = TestBed.inject(Router);
    back(container)!.click();
    await vi.waitFor(() => expect(router.url).toBe('/sdlc'));
  });

  it('the way back is shown while the change is being read', async () => {
    const transport = new MockTransport();
    vi.spyOn(transport, 'sdlcChangeState').mockReturnValue(new Promise(() => undefined));
    // The progress line shows once a read has run for 400 ms.
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const { container, fixture } = await mount(PHOTOS_CHANGE, transport, routes);
    vi.advanceTimersByTime(500);
    TestBed.tick();
    fixture.detectChanges();
    vi.useRealTimers();
    expect(container.textContent).toContain('Reading the change');
    expect(back(container)).not.toBeNull();
  });


  const say = (root: ParentNode, words: string) => {
    const input = root.querySelector<HTMLInputElement>('app-message-box [data-message-input]')!;
    input.value = words;
    input.dispatchEvent(new Event('input'));
    TestBed.tick();
    root.querySelector<HTMLButtonElement>('app-message-box [data-message-send]')!.click();
  };
  /** The box is offered and enabled: the scripted run is running, not yet paused on its question. */
  const boxReady = (root: ParentNode) => {
    TestBed.tick();
    const input = root.querySelector<HTMLInputElement>('app-message-box [data-message-input]');
    expect(input !== null && !input.disabled).toBe(true);
  };

  it('R6.1: an intent, spec or plan run that is running offers the message box, and sending reaches that run', async () => {
    const { container, transport } = await mount(PHOTOS_CHANGE);
    const send = vi.spyOn(transport, 'sendMessage');
    const started = vi.spyOn(transport, 'runSpec');
    Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => text(b) === 'Continue spec')!.click();
    await settle();
    Array.from(document.body.querySelector('[role="dialog"]')!.querySelectorAll<HTMLButtonElement>('button')).find((b) => text(b) === 'Run')!.click();
    await confirmPreview();
    await vi.waitFor(() => boxReady(container.querySelector('app-sdlc-session')!));
    say(container.querySelector('app-sdlc-session')!, 'keep it small');
    const runId = await started.mock.results[0].value;
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(runId, expect.any(String), 'keep it small');
    TestBed.inject(LockStore).cancel();
  });

  it('R6.1: a fix run that is running offers the message box, and sending reaches that run', async () => {
    const transport = new MockTransport();
    transport.patchChange(PHOTOS_CHANGE, { stage: 'fix-awaiting' as const, track: 'fix' as const });
    const ready = await transport.sdlcPluginReadiness(null);
    vi.spyOn(transport, 'sdlcPluginReadiness').mockResolvedValue(ready.kind === 'ready' ? ready : ready);
    const { container } = await mount(PHOTOS_CHANGE, transport);
    const send = vi.spyOn(transport, 'sendMessage');
    const started = vi.spyOn(transport, 'runSpec');
    Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => text(b) === 'Accept fix')!.click();
    await settle();
    await confirmPreview();
    await vi.waitFor(() => boxReady(container.querySelector('app-sdlc-session')!));
    say(container.querySelector('app-sdlc-session')!, 'the flag is set in import');
    const runId = await started.mock.results[0].value;
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(runId, expect.any(String), 'the flag is set in import');
    TestBed.inject(LockStore).cancel();
  });
  it('the way back stays enabled while a run is in progress (R11.6)', async () => {
    const { container } = await mount(PHOTOS_CHANGE, new MockTransport(), routes);
    expect(back(container)!.disabled).toBe(false);
    Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => text(b) === 'Continue spec')!.click();
    await settle();
    Array.from(document.body.querySelector('[role="dialog"]')!.querySelectorAll<HTMLButtonElement>('button')).find((b) => text(b) === 'Run')!.click();
    await confirmPreview();
    await vi.waitFor(() => expect(container.querySelector('app-sdlc-session')).not.toBeNull());
    expect(back(container)).not.toBeNull();
    expect(back(container)!.disabled).toBe(false);
    const session = container.querySelector('app-sdlc-session')!;
    const find = (label: string) => Array.from(session.querySelectorAll<HTMLButtonElement>('button')).find((b) => text(b) === label);
    find('Cancel')!.click();
    await vi.waitFor(() => {
      TestBed.tick();
      expect(find('Close')).toBeDefined();
    });
    expect(back(container)!.disabled).toBe(false);
    // Cancelling leaves the scripted run's files behind: settle the leftovers dialog so the session can close.
    await vi.waitFor(() => expect(document.body.querySelector('[role="dialog"]')).not.toBeNull());
    Array.from(document.body.querySelector('[role="dialog"]')!.querySelectorAll<HTMLButtonElement>('button')).find((b) => text(b) === 'Close')!.click();
    await vi.waitFor(() => expect(find('Close')!.disabled).toBe(false));
    find('Close')!.click();
    await vi.waitFor(() => {
      TestBed.tick();
      expect(container.querySelector('app-sdlc-session')).toBeNull();
      expect(back(container)!.disabled).toBe(false);
    });
  });
});

describe('ChangePage: the change copy', () => {
  const COPY = 'C:/ws/.ai-sdlc/copies/2026-10-12-product-photo-upload';
  const BRANCH = `change/${PHOTOS_CHANGE}`;
  let draw: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    draw = vi.spyOn(diagrams, 'render').mockResolvedValue('<svg></svg>');
  });
  afterEach(() => draw.mockRestore());

  /** The change as the plugin reports it from inside its own copy; the backend answers as the test says. */
  function inCopy(removal: CopyRemoval, remove: RemoveOutcome = { outcome: 'removed', kept: [] }) {
    const transport = new MockTransport();
    const real = transport.sdlcChangeState.bind(transport);
    const state = vi.spyOn(transport, 'sdlcChangeState').mockImplementation(async (...args) => {
      const view = await real(...args);
      return { ...view, state: { ...view.state, inCopy: true, master: COPY } };
    });
    vi.spyOn(transport, 'sdlcCopyRemoval').mockResolvedValue(removal);
    vi.spyOn(transport, 'sdlcCopyBranch').mockResolvedValue(BRANCH);
    const removed = vi.spyOn(transport, 'sdlcRemoveCopy').mockResolvedValue(remove);
    const opened = vi.spyOn(transport, 'sdlcOpenCopyFolder').mockResolvedValue();
    return { transport, state, real, removed, opened };
  }
  const line = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-testid="copy-line"]');
  const buttonIn = (root: ParentNode, label: string) => Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === label);
  const alert = () => document.body.querySelector('[role="alertdialog"]');

  // R17.1
  it('the copy line shows the folder, the branch and Open folder', async () => {
    const { transport, opened } = inCopy({ outcome: 'notOffered' });
    const { container } = await mount(PHOTOS_CHANGE, transport);
    await vi.waitFor(() => expect(line(container)?.textContent).toContain(BRANCH));
    const copy = line(container)!;
    expect(copy.textContent).toContain(COPY);
    expect(copy.textContent).toContain(`on ${BRANCH}`);
    expect(copy.querySelector('.k-mono')?.textContent).toContain(COPY);
    const open = buttonIn(copy, 'Open folder')!;
    expect(open).toBeDefined();
    open.click();
    await vi.waitFor(() => expect(opened).toHaveBeenCalledTimes(1));
  });

  it('a change that is not in a copy has no copy line', async () => {
    const { container } = await mount();
    expect(line(container)).toBeNull();
    expect(container.textContent).not.toContain('Open folder');
  });

  // R17.2
  it('the copy line says the checkout cannot switch to the branch', async () => {
    const { transport } = inCopy({ outcome: 'notOffered' });
    const { container } = await mount(PHOTOS_CHANGE, transport);
    await vi.waitFor(() => expect(line(container)).not.toBeNull());
    expect(line(container)!.textContent).toContain(
      "This branch is held by this change's own copy, so your own checkout cannot switch to it while the copy exists.",
    );
  });

  it('offers no removal when the backend does not offer it', async () => {
    const { transport } = inCopy({ outcome: 'notOffered' });
    const { container } = await mount(PHOTOS_CHANGE, transport);
    await vi.waitFor(() => expect(line(container)).not.toBeNull());
    await settle();
    expect(buttonIn(container, 'Remove this copy')).toBeUndefined();
  });

  it('offers Remove this copy when the backend offers it, and asks first', async () => {
    const offered = inCopy({ outcome: 'offer' });
    const { container } = await mount(PHOTOS_CHANGE, offered.transport);
    await vi.waitFor(() => expect(buttonIn(container, 'Remove this copy')).toBeDefined());
    buttonIn(container, 'Remove this copy')!.click();
    await vi.waitFor(() => expect(alert()).not.toBeNull());
    expect(offered.removed).not.toHaveBeenCalled();
    expect(alert()!.textContent).toContain(COPY);
  });

  it('confirming removes the copy: the copy line goes and the branches kept are shown', async () => {
    const kept = [`${BRANCH}: kept in the master repository`];
    const { transport, state, real, removed } = inCopy({ outcome: 'offer' }, { outcome: 'removed', kept });
    const { container } = await mount(PHOTOS_CHANGE, transport);
    await vi.waitFor(() => expect(buttonIn(container, 'Remove this copy')).toBeDefined());
    buttonIn(container, 'Remove this copy')!.click();
    await vi.waitFor(() => expect(alert()).not.toBeNull());
    state.mockImplementation(real);
    buttonIn(alert()!, 'Remove copy')!.click();
    await vi.waitFor(() => expect(line(container)).toBeNull());
    expect(removed).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="copy-note"]')!.textContent).toContain(kept[0]);
    expect(buttonIn(container, 'Remove this copy')).toBeUndefined();
  });

  it('declining keeps the copy and leaves the offer on the page', async () => {
    const { transport, removed } = inCopy({ outcome: 'offer' });
    const { container } = await mount(PHOTOS_CHANGE, transport);
    await vi.waitFor(() => expect(buttonIn(container, 'Remove this copy')).toBeDefined());
    buttonIn(container, 'Remove this copy')!.click();
    await vi.waitFor(() => expect(alert()).not.toBeNull());
    buttonIn(alert()!, 'Cancel')!.click();
    await vi.waitFor(() => expect(alert()).toBeNull());
    expect(removed).not.toHaveBeenCalled();
    expect(line(container)).not.toBeNull();
    expect(buttonIn(container, 'Remove this copy')).toBeDefined();
  });

  it('a copy with uncommitted files offers no removal and names the files', async () => {
    const { transport } = inCopy({ outcome: 'keep', uncommitted: ['src/a.ts', 'notes.txt'] });
    const { container } = await mount(PHOTOS_CHANGE, transport);
    await vi.waitFor(() => expect(line(container)?.textContent).toContain('notes.txt'));
    expect(line(container)!.textContent).toContain('src/a.ts');
    expect(buttonIn(container, 'Remove this copy')).toBeUndefined();
  });

  it('work that appeared after the offer keeps the copy and names the file', async () => {
    const { transport } = inCopy({ outcome: 'offer' }, { outcome: 'keep', uncommitted: ['src/new.ts'] });
    const { container } = await mount(PHOTOS_CHANGE, transport);
    await vi.waitFor(() => expect(buttonIn(container, 'Remove this copy')).toBeDefined());
    buttonIn(container, 'Remove this copy')!.click();
    await vi.waitFor(() => expect(alert()).not.toBeNull());
    buttonIn(alert()!, 'Remove copy')!.click();
    await vi.waitFor(() => expect(line(container)?.textContent).toContain('src/new.ts'));
    expect(line(container)).not.toBeNull();
    expect(buttonIn(container, 'Remove this copy')).toBeUndefined();
  });

  it("a refusal shows the plugin's problems as they are", async () => {
    const { transport } = inCopy({ outcome: 'offer' }, { outcome: 'refused', problems: ['the branch is checked out', 'run ai-sdlc doctor'] });
    const { container } = await mount(PHOTOS_CHANGE, transport);
    await vi.waitFor(() => expect(buttonIn(container, 'Remove this copy')).toBeDefined());
    buttonIn(container, 'Remove this copy')!.click();
    await vi.waitFor(() => expect(alert()).not.toBeNull());
    buttonIn(alert()!, 'Remove copy')!.click();
    await vi.waitFor(() => expect(container.querySelector('[data-testid="copy-note"]')).not.toBeNull());
    const note = container.querySelector('[data-testid="copy-note"]')!.textContent!;
    expect(note).toContain('the branch is checked out');
    expect(note).toContain('run ai-sdlc doctor');
    expect(line(container)).not.toBeNull();
  });

  it('a removal that could not run says why', async () => {
    const { transport } = inCopy({ outcome: 'offer' }, { outcome: 'couldNotRun', message: 'node was not found' });
    const { container } = await mount(PHOTOS_CHANGE, transport);
    await vi.waitFor(() => expect(buttonIn(container, 'Remove this copy')).toBeDefined());
    buttonIn(container, 'Remove this copy')!.click();
    await vi.waitFor(() => expect(alert()).not.toBeNull());
    buttonIn(alert()!, 'Remove copy')!.click();
    await vi.waitFor(() => expect(container.querySelector('[data-testid="copy-note"]')?.textContent).toContain('node was not found'));
  });
});
