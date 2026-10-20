import type { ChangeInfo } from '@bindings/ChangeInfo';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { render } from '../../../testing/render';
import { KataTransport } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import { diagrams } from '../../lib/mermaid';
import { MOCK_BUILD_CHANGE } from '../../lib/sdlc-mock';
import { monaco } from '../../ui/diff-editor/monaco.loader';
import { ChangePage } from './change-page';
import { ChangePageViewModel } from './change-page.view-model';

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

  it('shows the breadcrumb, the branch, the stepper and the stage document', async () => {
    const { container } = await mount();
    expect(container.querySelector('nav')!.textContent).toContain(FNOL);
    expect(container.textContent).toContain('acme-claims');
    expect(container.querySelector('[data-testid="branch"]')!.textContent!.trim()).toBe('main');
    expect(container.querySelectorAll('app-stage-stepper [aria-current="step"]').length).toBe(1);
    expect(container.textContent).toContain('Spec · awaiting acceptance');
    expect(container.querySelector('app-doc-view h1')!.textContent).toBe('Spec: photo upload');
    expect(container.querySelector('.k-doc__front')!.textContent!.trim()).toBe('status: draft');
  });

  it('crosses the seam: clicking the Intent tile shows the accepted intent in its tab panel', async () => {
    const { container } = await mount();
    const tab = (name: string) =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((t) => t.querySelector('.k-step__name')!.textContent!.trim() === name)!;
    expect(tab('Plan').disabled).toBe(true);
    tab('Intent').click();
    await vi.waitFor(() => expect(container.querySelector('app-doc-view h1')?.textContent).toBe('Photo upload at first notice of loss'));
    expect(tab('Intent').getAttribute('aria-selected')).toBe('true');
    const panel = container.querySelector('[role="tabpanel"]:not([hidden])')!;
    expect(panel.getAttribute('aria-labelledby')).toBe(tab('Intent').id);
    expect(panel.querySelector('.k-doc__name')!.textContent).toBe('intent.md');
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
    const click = (label: string) => Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find((b) => b.textContent!.trim() === label)!.click();

    it('the plan tab renders the build log from sdlcBuildStatus', async () => {
      const { container, transport } = await mount(MOCK_BUILD_CHANGE);
      const status = await transport.sdlcBuildStatus('', 'claims', MOCK_BUILD_CHANGE);
      const table = container.querySelector('app-build-log-table')!;
      expect(table).not.toBeNull();
      expect(text(table.querySelector('h2')!)).toBe('Build log');
      expect(table.querySelectorAll('tbody tr').length).toBe(status.tasks.length);
    });

    it('crosses the seam: clicking the Build tile shows what changed in the build panel', async () => {
      vi.spyOn(monaco, 'load').mockReturnValue(new Promise(() => undefined));
      const { container } = await mount(MOCK_BUILD_CHANGE);
      const tile = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((t) => t.querySelector('.k-step__name')!.textContent!.trim() === 'Build')!;
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

    it('shows no build log on a change without tasks', async () => {
      const { container } = await mount();
      expect(container.querySelector('app-build-log-table')).toBeNull();
    });

    it('crosses the seam: clicking the rendered Start build opens the dialog, and Start build prepares the build', async () => {
      const { container, transport } = await mount(MOCK_BUILD_CHANGE);
      const prepare = vi.spyOn(transport, 'sdlcBuildPrepare');
      Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent!.trim() === 'Start build')!.click();
      await settle();
      const dialog = document.body.querySelector('[role="dialog"]')!;
      expect(dialog).not.toBeNull();
      expect(text(dialog.querySelector('[hlmDialogTitle]')!)).toBe('Start build');
      expect(prepare).not.toHaveBeenCalled();
      click('Start build');
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
      expect(prepare.mock.calls[0][4]).toBe(false);
    });

    it('a refused build opens the refusal dialog', async () => {
      const { container, transport } = await mount(MOCK_BUILD_CHANGE);
      vi.spyOn(transport, 'sdlcPluginVersion').mockResolvedValue(null);
      Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent!.trim() === 'Start build')!.click();
      await settle();
      click('Start build');
      await vi.waitFor(() => expect(document.body.textContent).toContain('The build did not start'));
      expect(document.body.textContent).toContain('Update the ai-sdlc plugin to 0.6.0 or later');
    });

    it('leftovers open the confirm dialog titled and listing each repository and file', async () => {
      const { container, transport } = await mount(MOCK_BUILD_CHANGE);
      vi.spyOn(transport, 'sdlcBuildPrepare').mockResolvedValueOnce({ kind: 'needsConfirm', leftovers: [{ repo: 'claims-core', files: ['src/new.rs'] }] });
      Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent!.trim() === 'Start build')!.click();
      await settle();
      click('Start build');
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
    expect(container.querySelector('app-stage-stepper')!.textContent).toContain('Done · pull requests open');
    expect(container.textContent).not.toContain('Build · finished, not yet done');
    expect(labels(container)).not.toContain('Declare done');
    expect(labels(container)).not.toContain('Another round');
    const card = container.querySelector('app-pr-card')!;
    expect(card.querySelector('h2')!.textContent).toBe('Pull requests');
    expect(card.querySelectorAll('a').length).toBe(3);
  });

  it('an unfinished set of pull requests keeps the finished label and its action', async () => {
    const { container } = await mount(MOCK_BUILD_CHANGE, finishedTransport());
    expect(container.textContent).toContain('Build · finished, not yet done');
    expect(labels(container)).toContain('Declare done');
    expect(container.querySelector('app-pr-card')).toBeNull();
  });

  it('unreachable GitHub keeps the finished label with a note', async () => {
    const transport = finishedTransport();
    await openAll(transport);
    vi.spyOn(transport, 'sdlcPullRequests').mockRejectedValue(new Error('GitHub could not be reached. Try again later.'));
    const { container } = await mount(MOCK_BUILD_CHANGE, transport);
    expect(container.textContent).toContain('Build · finished, not yet done');
    expect(container.querySelector('[data-testid="pr-note"]')!.textContent).toContain('Could not check pull requests');
    expect(container.querySelector('app-pr-card')).toBeNull();
  });
});
