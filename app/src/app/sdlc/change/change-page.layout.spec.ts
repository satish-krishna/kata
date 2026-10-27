import type { ChangeInfo } from '@bindings/ChangeInfo';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { render } from '../../../testing/render';
import { toastState } from '@spartan-ng/brain/sonner';
import { RunPreviewViewModel } from '../../core/given/run-preview.view-model';
import { LockStore } from '../../core/lock/lock.store';
import { KataTransport } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import { diagrams } from '../../lib/mermaid';
import { MOCK_BUILD_CHANGE } from '../../lib/sdlc-mock';
import { BuildPageViewModel } from '../build/build-page.view-model';
import { ChangePage } from './change-page';
import { ChangePageViewModel } from './change-page.view-model';

const FNOL = '2026-10-12-fnol-photo-upload';
const settle = async () => {
  for (let i = 0; i < 4; i++) {
    TestBed.tick();
    await new Promise((r) => setTimeout(r, 0));
  }
};
const text = (e: Element) => e.textContent!.replace(/\s+/g, ' ').trim();

async function mount(change = FNOL, transport = new MockTransport()) {
  const out = await render(ChangePage, {}, [
    provideRouter([]),
    { provide: KataTransport, useValue: transport },
    { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ system: 'claims', change })), snapshot: { queryParamMap: convertToParamMap({}) } } },
  ]);
  await settle();
  return { ...out, transport };
}
const pill = (c: HTMLElement, start: string) => Array.from(c.querySelectorAll<HTMLButtonElement>('header [role="tab"]')).find((t) => text(t).startsWith(start))!;

describe('ChangePage layout', () => {
  let draw: ReturnType<typeof vi.spyOn>;
  let scrolled: Element[];
  beforeEach(() => {
    draw = vi.spyOn(diagrams, 'render').mockResolvedValue('<svg></svg>');
    scrolled = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
  });
  afterEach(() => {
    draw.mockRestore();
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('puts the stage pills in the toolbar, in place of the stage cards and the pull request card', async () => {
    const { container } = await mount();
    const header = container.querySelector('header')!;
    expect(Array.from(header.querySelectorAll('[role="tab"]')).map(text)).toEqual(['Intent', 'Spec · awaiting acceptance', 'Plan · not started', 'Build · locked']);
    expect(container.querySelector('app-stage-stepper')).toBeNull();
    expect(container.querySelector('app-pr-card')).toBeNull();
    expect(container.querySelector('main [role="tab"]')).toBeNull();
  });

  it('crosses the seam: clicking the Intent pill shows the accepted intent in the document layout and marks the pill', async () => {
    const { container } = await mount();
    pill(container, 'Intent').click();
    await vi.waitFor(() => expect(container.querySelector('app-doc-layout h1')?.textContent).toBe('Photo upload at first notice of loss'));
    expect(pill(container, 'Intent').getAttribute('aria-selected')).toBe('true');
    expect(pill(container, 'Spec').getAttribute('aria-current')).toBe('step');
    const panel = container.querySelector('[role="tabpanel"]:not([hidden])')!;
    expect(panel.getAttribute('aria-labelledby')).toBe(pill(container, 'Intent').id);
  });

  it('holds the stage actions in the strip under the toolbar, not in the toolbar', async () => {
    const { container } = await mount();
    const strip = container.querySelector('[data-testid="strip"]')!;
    const labels = Array.from(strip.querySelectorAll('button')).map(text);
    expect(labels).toEqual(expect.arrayContaining(['Continue spec', 'Accept spec', 'Reopen intent']));
    expect(Array.from(container.querySelector('header')!.querySelectorAll('button')).map(text)).not.toContain('Accept spec');
    const primary = Array.from(strip.querySelectorAll('button')).find((b) => text(b) === 'Accept spec')!;
    expect(primary.classList.contains('k-btn--primary')).toBe(true);
  });

  it('disables the strip actions while a task holds the page', async () => {
    const { container, fixture } = await mount();
    const strip = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="strip"] button'));
    expect(strip().length).toBeGreaterThan(0);
    expect(strip().every((b) => !b.disabled)).toBe(true);
    void fixture.debugElement.injector.get(LockStore).runSteps('Working', [{ label: 'wait', run: () => new Promise<string | null>(() => undefined) }]);
    await settle();
    expect(strip().every((b) => b.disabled)).toBe(true);
  });

  it('says the open document status in words with a dot, and its file name', async () => {
    const { container } = await mount();
    const strip = container.querySelector('[data-testid="strip"]')!;
    expect(text(strip)).toContain('Draft');
    expect(strip.querySelector('.k-status--warning .k-status__dot')).not.toBeNull();
    expect(text(strip)).toContain('spec.md');
  });

  it('shows the front matter in the rail as fields, and no longer as a line above the text', async () => {
    const transport = new MockTransport();
    vi.spyOn(transport, 'sdlcReadDoc').mockResolvedValue('---\nauthor: Sam\nstatus: draft\n---\n# Spec: photo upload\n\n## Rules\n\nOne.\n');
    const { container } = await mount(FNOL, transport);
    const rail = container.querySelector('aside[aria-label="About this document"]')!;
    expect(Array.from(rail.querySelectorAll('dt')).map(text)).toEqual(['author']);
    expect(Array.from(rail.querySelectorAll('dd')).map(text)).toEqual(['Sam']);
    expect(container.querySelector('.k-doc__front')).toBeNull();
  });

  it('lists the document sections in the outline and scrolls the clicked one inside its own document', async () => {
    const transport = new MockTransport();
    vi.spyOn(transport, 'sdlcReadDoc').mockResolvedValue('# Spec\n\n## Rules\n\nOne.\n\n## Design\n\nTwo.\n');
    const { container } = await mount(FNOL, transport);
    const entries = Array.from(container.querySelectorAll<HTMLButtonElement>('nav[aria-label="On this page"] button'));
    expect(entries.map(text)).toEqual(['Rules', 'Design']);
    entries[1].click();
    await settle();
    expect(scrolled.length).toBe(1);
    expect(scrolled[0].textContent).toBe('Design');
    expect(container.querySelector('app-doc-layout')!.contains(scrolled[0])).toBe(true);
  });

  it('lists the recent runs of the open stage in the rail, as kind and time with no link', async () => {
    const transport = new MockTransport();
    vi.spyOn(transport, 'sdlcRunLinks').mockResolvedValue([
      { workspace_id: 'acme-claims', system: 'claims', change: FNOL, stage: 'spec', run_id: 'r1', started_at: 1_790_000_000 },
      { workspace_id: 'acme-claims', system: 'claims', change: FNOL, stage: 'spec', run_id: 'r2', started_at: 1_790_100_000 },
    ]);
    const { container } = await mount(FNOL, transport);
    const runs = container.querySelector('[data-testid="recent-runs"]')!;
    expect(text(runs.querySelector('h2')!)).toBe('Recent runs · 2');
    const rows = Array.from(runs.querySelectorAll('li')).map(text);
    expect(rows.length).toBe(2);
    expect(rows.every((r) => /^(Succeeded|Failed|No result) Spec [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}$/.test(r))).toBe(true);
    expect(runs.querySelector('a, button')).toBeNull();
  });

  it('says what uses the intent in the rail of the intent', async () => {
    const { container } = await mount();
    pill(container, 'Intent').click();
    await vi.waitFor(() => expect(container.querySelector('app-doc-layout h1')?.textContent).toBe('Photo upload at first notice of loss'));
    expect(text(container.querySelector('[data-testid="used-by"]')!)).toContain('spec.md');
  });

  it('keeps the not-in-folder message when the document is missing', async () => {
    const transport = new MockTransport();
    vi.spyOn(transport, 'sdlcReadDoc').mockResolvedValue(null);
    const { container } = await mount(FNOL, transport);
    expect(container.textContent).toContain('spec.md is not in this change folder.');
    expect(container.querySelector('app-doc-layout')).toBeNull();
  });

  it('keeps the plan banner above the plan in the new layout', async () => {
    const transport = new MockTransport();
    const real = transport.sdlcChanges.bind(transport);
    vi.spyOn(transport, 'sdlcChanges').mockImplementation(async (m, s) =>
      (await real(m, s)).map((c) => (c.change === '2026-10-09-adjuster-reassign' ? { ...c, stage: 'plan-superseded' as ChangeInfo['stage'] } : c)),
    );
    const { container } = await mount('2026-10-09-adjuster-reassign', transport);
    const banner = container.querySelector('[data-testid="plan-banner"]')!;
    expect(banner).not.toBeNull();
    expect(banner.nextElementSibling!.tagName).toBe('APP-DOC-LAYOUT');
  });

  describe('the Build tab strip', () => {
    afterEach(() => vi.restoreAllMocks());
    const openBuild = async () => {
      const out = await mount(MOCK_BUILD_CHANGE);
      pill(out.container, 'Build').click();
      await settle();
      return out;
    };

    it('draws no page strip: the build page bar holds the facts and the stage actions', async () => {
      const { container } = await openBuild();
      expect(container.querySelector('[data-testid="strip"]')).toBeNull();
      const bar = container.querySelector('app-build-page [data-bar]')!;
      expect(text(bar.querySelector('.k-lock__count')!)).toMatch(/^\d+\/\d+ tasks$/);
      expect(Array.from(bar.querySelectorAll('button')).map(text)).toContain('Start build');
    });

    it('refuses a stage action while a task holds the page, and opens no preview', async () => {
      const { container, fixture } = await openBuild();
      void fixture.debugElement.injector.get(LockStore).runSteps('Working', [{ label: 'wait', run: () => new Promise<string | null>(() => undefined) }]);
      await settle();
      Array.from(container.querySelectorAll<HTMLButtonElement>('app-build-page [data-bar] button')).find((b) => text(b) === 'Start build')!.click();
      await settle();
      expect(toastState.toasts().map((t) => String(t.title)).join(' | ')).toContain('Another task is already running.');
      expect(fixture.debugElement.injector.get(RunPreviewViewModel).isOpen()).toBe(false);
      toastState.reset();
    });

    it('keeps the changed files strip of the build page free of facts and actions', async () => {
      const { container } = await openBuild();
      const strip = container.querySelector('app-build-page app-changes-view [data-testid="changes-strip"]')!;
      expect(strip).not.toBeNull();
      expect(strip.querySelector('[data-testid="build-facts"]')).toBeNull();
      expect(Array.from(strip.querySelectorAll('button')).map(text)).toEqual([...Array.from(strip.querySelectorAll('[role="radio"]')).map(text), 'By type']);
    });
  });

  describe('after the pull requests', () => {
    const finished = async (only?: number) => {
      const transport = new MockTransport();
      const real = transport.sdlcChanges.bind(transport);
      vi.spyOn(transport, 'sdlcChanges').mockImplementation(async (m, s) =>
        (await real(m, s)).map((c) => (c.change === MOCK_BUILD_CHANGE ? { ...c, stage: 'build-finished' as const } : c)),
      );
      const status = transport.sdlcBuildStatus.bind(transport);
      vi.spyOn(transport, 'sdlcBuildStatus').mockImplementation(async (m, sys, c) => {
        const got = await status(m, sys, c);
        return {
          ...got,
          repos: got.repos.map((r) => ({ ...r, firstUnfinished: null, state: { kind: 'done' as const }, finished: r.tasks })),
          tasks: got.tasks.map((t) => ({ ...t, row: { task: t.id, repo: t.repo, commits: ['c0ffee1'], departure: null } })),
        };
      });
      const repos = await transport.sdlcTouchedRepos('f', 'claims-intent', 'claims', MOCK_BUILD_CHANGE);
      await transport.sdlcPublish('f', 'w1', 'claims-intent', 'claims', MOCK_BUILD_CHANGE, only === undefined ? repos : repos.slice(0, only));
      return transport;
    };

    it('collapses three pull requests into one "3 PRs" button at the right of the toolbar, with no inline links', async () => {
      const { container } = await mount(MOCK_BUILD_CHANGE, await finished());
      const menu = container.querySelectorAll<HTMLButtonElement>('header [data-testid="pr-menu"]');
      expect(menu.length).toBe(1);
      expect(text(menu[0])).toBe('3 PRs');
      expect(menu[0].getAttribute('aria-haspopup')).not.toBeNull();
      expect(container.querySelectorAll('header a').length).toBe(0);
    });

    it('shows a single pull request as the inline link, repository name and number, opening GitHub', async () => {
      const { container } = await mount(MOCK_BUILD_CHANGE, await finished(1));
      const links = Array.from(container.querySelectorAll<HTMLAnchorElement>('header a'));
      expect(links.length).toBe(1);
      expect(text(links[0].querySelector('.k-prlinks__repo')!)).toMatch(/^[a-z-]+$/);
      expect(text(links[0].querySelector('.k-prlinks__num')!)).toMatch(/^#[0-9]+$/);
      expect(links[0].rel.includes('noopener') && links[0].href.startsWith('https://')).toBe(true);
      expect(container.querySelector('[data-testid="pr-menu"]')).toBeNull();
    });

    it('keeps the pills and the pull request button while a build is live, with the build page on show', async () => {
      const { container, fixture } = await mount(MOCK_BUILD_CHANGE, await finished());
      expect(container.querySelectorAll('header [role="tab"]').length).toBe(4);
      expect(container.querySelector('[data-testid="pr-menu"]')).not.toBeNull();
      const vm = fixture.debugElement.injector.get(ChangePageViewModel);
      await vm.submitBuild({ timeoutSecs: 5400, instructions: null, repo: null });
      await settle();
      expect(container.querySelector('app-build-page')).not.toBeNull();
      expect(container.querySelector('app-build-view')).toBeNull();
      expect(container.querySelectorAll('header [role="tab"]').length).toBe(4);
      expect(container.querySelector('[data-testid="pr-menu"]')).not.toBeNull();
      fixture.debugElement.injector.get(BuildPageViewModel).cancelBuild();
    });
  });

  describe('picking a document tab', () => {
    const selected = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLButtonElement>('header [role="tab"]')).filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => text(t).split(' ')[0]);

    afterEach(() => vi.useRealTimers());

    it('pulls the pills back to the old tab when the read fails', async () => {
      const transport = new MockTransport();
      const { container } = await mount(FNOL, transport);
      expect(selected(container)).toEqual(['Spec']);
      let fail!: (e: unknown) => void;
      vi.spyOn(transport, 'sdlcReadDoc').mockReturnValue(new Promise<string>((_, no) => (fail = no)));
      // The progress line shows once a read has run for 400 ms.
      vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
      pill(container, 'Intent').click();
      await settle();
      vi.advanceTimersByTime(500);
      await settle();
      expect(selected(container)).toEqual(['Intent']);
      expect(container.querySelector('[role="tabpanel"]:not([hidden])')!.textContent).toContain('Reading intent.md');
      fail('permission denied');
      await settle();
      expect(selected(container)).toEqual(['Spec']);
      expect(container.querySelector('[role="tabpanel"]:not([hidden]) app-doc-layout')).not.toBeNull();
    });

    it('keeps the Build pill and the Build panel together when a click back on Build outruns a read for another tab', async () => {
      const transport = new MockTransport();
      const { container } = await mount(MOCK_BUILD_CHANGE, transport);
      pill(container, 'Build').click();
      await settle();
      expect(selected(container)).toEqual(['Build']);
      let release!: (text: string) => void;
      vi.spyOn(transport, 'sdlcReadDoc').mockReturnValue(new Promise<string>((r) => (release = r)));
      pill(container, 'Intent').click();
      await settle();
      expect(selected(container)).toEqual(['Intent']);
      pill(container, 'Build').click();
      await settle();
      release('# the intent text');
      await settle();
      expect(selected(container)).toEqual(['Build']);
      const panel = container.querySelector('[role="tabpanel"]:not([hidden])')!;
      expect(panel.querySelector('app-build-page')).not.toBeNull();
      expect(panel.querySelector('app-doc-layout')).toBeNull();
      expect(panel.getAttribute('aria-labelledby')).toBe(pill(container, 'Build').id);
    });

    it('leaves the pills on the new tab once the read succeeds', async () => {
      const { container } = await mount();
      pill(container, 'Intent').click();
      await vi.waitFor(() => expect(container.querySelector('app-doc-layout h1')?.textContent).toBe('Photo upload at first notice of loss'));
      expect(selected(container)).toEqual(['Intent']);
    });
  });
});
