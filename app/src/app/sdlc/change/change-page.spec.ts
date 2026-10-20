import type { ChangeInfo } from '@bindings/ChangeInfo';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { render } from '../../../testing/render';
import { KataTransport } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import { diagrams } from '../../lib/mermaid';
import { ChangePage } from './change-page';

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
    const run = vi.spyOn(transport, 'runSpec').mockResolvedValue();
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

    it('out-of-date plan and spec banners and actions (R1.4)', async () => {
      const plan = await mount(REASSIGN, staged('plan-out-of-date', 'plan-pin'));
      expect(banner(plan.container)).toBe('This plan was not written from the spec accepted now. Rewrite the plan before building.');
      expect(labels(plan.container)).toContain('Re-run plan');
      expect(labels(plan.container)).not.toContain('Start build');
      plan.fixture.destroy();
      const spec = await mount(REASSIGN, staged('plan-out-of-date', 'spec-pin'));
      expect(banner(spec.container)).toBe('This spec was not written from the intent accepted now. Rewrite the spec, then the plan.');
      expect(labels(spec.container)).toContain('Reopen spec');
      expect(labels(spec.container)).not.toContain('Re-run plan');
      expect(labels(spec.container)).not.toContain('Start build');
    });

    it('a reopened intent or spec is named and blocks the build (R1.5)', async () => {
      const intent = await mount(REASSIGN, staged('plan-out-of-date', 'intent-reopened'));
      expect(banner(intent.container)).toBe('The intent was reopened.');
      expect(labels(intent.container)).not.toContain('Start build');
      expect(labels(intent.container)).not.toContain('Continue build');
      intent.fixture.destroy();
      const spec = await mount(REASSIGN, staged('plan-out-of-date', 'spec-reopened'));
      expect(banner(spec.container)).toBe('The spec was reopened.');
      expect(labels(spec.container)).not.toContain('Start build');
      expect(labels(spec.container)).not.toContain('Continue build');
    });
  });
});
