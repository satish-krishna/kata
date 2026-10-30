import type { ChangeInfo } from '@bindings/ChangeInfo';
import type { ReadResult } from '@bindings/ReadResult';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { builtTasks, NUMBERS, parsedPlan, parsedSpec, reviewOfSix } from '../../../testing/fixtures/parsed-change';
import { render } from '../../../testing/render';
import { KataTransport } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import { diagrams } from '../../lib/mermaid';
import { MOCK_BUILD_CHANGE } from '../../lib/sdlc-mock';
import { ChangePage } from './change-page';
import { ChangePageViewModel } from './change-page.view-model';

const settle = async () => {
  for (let i = 0; i < 4; i++) {
    TestBed.tick();
    await new Promise((r) => setTimeout(r, 0));
  }
};
const text = (e: Element) => e.textContent!.replace(/\s+/g, ' ').trim();
const RUN = `sdlc-commerce-${MOCK_BUILD_CHANGE}-review-1`;
const REPOS = ['commerce-core', 'customer-portal'];

/** The documents are on disk as prose with nothing in them a page could read a requirement or a task from. */
const PROSE = (title: string) => `---\nstatus: accepted\n---\n# ${title}\n\nWords only.\n`;

describe('ChangePage parsed documents', () => {
  let draw: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    draw = vi.spyOn(diagrams, 'render').mockResolvedValue('<svg></svg>');
  });
  afterEach(() => draw.mockRestore());

  it('change page shows every requirement, scenario, task, build record and finding', async () => {
    const transport = new MockTransport();
    const real = transport.sdlcReadChange.bind(transport);
    vi.spyOn(transport, 'sdlcReadChange').mockImplementation(async (m, s, n) =>
      [await real(m, s, n)].map((c): ChangeInfo => (c.change === MOCK_BUILD_CHANGE ? { ...c, stage: 'build-finished' } : c))[0],
    );
    vi.spyOn(transport, 'sdlcReadDoc').mockImplementation(async (_m, _s, _c, stem) => PROSE(stem));
    const documents: Record<string, ReadResult> = { spec: parsedSpec(), plan: parsedPlan() };
    vi.spyOn(transport, 'sdlcReadParsed').mockImplementation(async (_m, _s, _c, stem) => documents[stem] ?? null);
    const status = transport.sdlcBuildStatus.bind(transport);
    vi.spyOn(transport, 'sdlcBuildStatus').mockImplementation(async (m, s, c) => {
      const got = await status(m, s, c);
      return { ...got, repos: got.repos.map((r) => ({ ...r, firstUnfinished: null, state: { kind: 'done' as const }, finished: r.tasks })), tasks: builtTasks() };
    });
    vi.spyOn(transport, 'sdlcDiffFiles').mockResolvedValue({ files: [], loc: [] });
    vi.spyOn(transport, 'listRuns').mockResolvedValue([{ id: RUN, kata: 'k', started_at: 1, isolation: 'none', steered: false, exit: 0 }]);
    const heads = await transport.sdlcBuildHeads('', 'commerce-docs', 'commerce', ['commerce-docs', ...REPOS], MOCK_BUILD_CHANGE);
    const commits = Object.fromEntries(Object.entries(heads).map(([repo, sha]) => [repo, sha.slice(0, 7)]));
    vi.spyOn(transport, 'sdlcReviewRecord').mockResolvedValue(reviewOfSix(commits));
    const { container, fixture } = await render(ChangePage, {}, [
      provideRouter([]),
      { provide: KataTransport, useValue: transport },
      { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ system: 'commerce', change: MOCK_BUILD_CHANGE })), snapshot: { queryParamMap: convertToParamMap({}) } } },
    ]);
    await settle();
    const vm = fixture.debugElement.injector.get(ChangePageViewModel);
    await transport.sdlcLinkRun({ workspace_id: vm.current()!.id, system: 'commerce', change: MOCK_BUILD_CHANGE, stage: 'review', run_id: RUN, started_at: 1790000000, heads });

    const pill = (start: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('header [role="tab"]')).find((t) => text(t).startsWith(start))!;
    pill('Spec').click();
    await settle();
    const reqs = () => Array.from(container.querySelectorAll<HTMLButtonElement>('nav[aria-label="Requirements"] button'));
    expect(reqs().length).toBe(NUMBERS.requirements);
    let scenarios = 0;
    for (let i = 0; i < reqs().length; i++) {
      reqs()[i].click();
      await settle();
      scenarios += container.querySelectorAll('[data-testid="requirement"] article').length;
    }
    expect(scenarios).toBe(NUMBERS.scenarios);

    pill('Plan').click();
    await settle();
    const tasks = Array.from(container.querySelectorAll<HTMLButtonElement>('nav[aria-label="Tasks"] button'));
    expect(tasks.length).toBe(NUMBERS.tasks);
    expect(tasks.filter((b) => b.querySelector('[role="img"]')!.getAttribute('aria-label') === 'built').length).toBe(NUMBERS.buildRecords);
    expect(text(container.querySelector('[data-testid="task"] .k-docview__label')!)).toBe('Change');

    await vm.act('declare-done');
    const review = vm.doneReport()!.review;
    expect('findings' in review && review.findings.length).toBe(NUMBERS.findings);
  });
});
