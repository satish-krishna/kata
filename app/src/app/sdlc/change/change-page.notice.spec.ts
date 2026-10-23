import type { ChangeInfo } from '@bindings/ChangeInfo';
import type { Problem } from '@bindings/Problem';
import type { ReadResult } from '@bindings/ReadResult';
import type { Readiness } from '@bindings/Readiness';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { parsedPlan, parsedSpec, NUMBERS } from '../../../testing/fixtures/parsed-change';
import { render } from '../../../testing/render';
import { KataTransport } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import { diagrams } from '../../lib/mermaid';
import { MOCK_BUILD_CHANGE } from '../../lib/sdlc-mock';
import { ChangePage } from './change-page';

const settle = async () => {
  for (let i = 0; i < 4; i++) {
    TestBed.tick();
    await new Promise((r) => setTimeout(r, 0));
  }
};
const text = (e: Element | null) => e?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
const PROSE = (title: string) => `---\nstatus: accepted\n---\n# ${title}\n\nWords only.\n`;
const READY: Readiness = { kind: 'ready', dir: '~/.claude/plugins/ai-sdlc', version: '0.9.0', layouts: [1, 2] };

type Setup = {
  readiness?: Readiness;
  spec?: ReadResult;
  plan?: ReadResult;
  logLayouts?: { repo: string; layout: number }[];
  /** What the format program reported across the plan and the build logs. */
  buildProblems?: Problem[];
  /** Stems the program cannot read: its rejection carries the message. */
  unreadable?: Record<string, string>;
};

async function open(setup: Setup) {
  const transport = new MockTransport();
  const real = transport.sdlcChanges.bind(transport);
  vi.spyOn(transport, 'sdlcChanges').mockImplementation(async (m, s) =>
    (await real(m, s)).map((c): ChangeInfo => (c.change === MOCK_BUILD_CHANGE && !setup.logLayouts ? { ...c, stage: 'plan-awaiting' } : c)),
  );
  vi.spyOn(transport, 'sdlcReadDoc').mockImplementation(async (_m, _s, _c, stem) => PROSE(stem));
  vi.spyOn(transport, 'sdlcPluginReadiness').mockResolvedValue(setup.readiness ?? READY);
  if (setup.logLayouts) {
    const status = transport.sdlcBuildStatus.bind(transport);
    vi.spyOn(transport, 'sdlcBuildStatus').mockImplementation(
      async (...args) => ({ ...(await status(...args)), logLayouts: setup.logLayouts, problems: setup.buildProblems ?? [] }) as never,
    );
  }
  const documents: Record<string, ReadResult> = { spec: setup.spec ?? parsedSpec(), plan: setup.plan ?? parsedPlan() };
  vi.spyOn(transport, 'sdlcReadParsed').mockImplementation(async (_m, _s, _c, stem) => {
    if (setup.unreadable?.[stem] !== undefined) throw new Error(setup.unreadable[stem]);
    return documents[stem] ?? null;
  });
  const view = await render(ChangePage, {}, [
    provideRouter([]),
    { provide: KataTransport, useValue: transport },
    { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ system: 'claims', change: MOCK_BUILD_CHANGE })), snapshot: { queryParamMap: convertToParamMap({}) } } },
  ]);
  await settle();
  const tab = async (start: string) => {
    Array.from(view.container.querySelectorAll<HTMLButtonElement>('header [role="tab"]')).find((t) => text(t)!.startsWith(start))!.click();
    await settle();
  };
  const notice = () => view.container.querySelector('[data-testid="doc-notice"]');
  const requirements = () => view.container.querySelectorAll('nav[aria-label="Requirements"] button').length;
  const tasks = () => view.container.querySelectorAll('nav[aria-label="Tasks"] button').length;
  return { ...view, tab, notice, requirements, tasks };
}

describe('ChangePage document notices', () => {
  let draw: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    draw = vi.spyOn(diagrams, 'render').mockResolvedValue('<svg></svg>');
  });
  afterEach(() => draw.mockRestore());

  it('a spec with problems shows its notice and every readable requirement', async () => {
    const problems: Problem[] = [{ file: 'spec.md', line: 42, message: 'requirement has no ID' }];
    const broken = { ...parsedSpec(), problems } as ReadResult;
    const page = await open({ spec: broken });
    await page.tab('Spec');
    expect(text(page.notice())).toContain('line 42: requirement has no ID');
    expect(page.notice()!.className).toContain('wb-banner--warn');
    expect(page.notice()!.querySelector('.k-status__dot')).not.toBeNull();
    expect(page.requirements()).toBe(NUMBERS.requirements);
  });

  it('an older-layout change shows everything with the older-layout label', async () => {
    const page = await open({ spec: { ...parsedSpec(), layout: 1 } as ReadResult, plan: { ...parsedPlan(), layout: 1 } as ReadResult });
    await page.tab('Spec');
    expect(text(page.notice())).toBe('Older layout');
    expect(page.requirements()).toBe(NUMBERS.requirements);
    await page.tab('Plan');
    expect(text(page.notice())).toBe('Older layout');
    expect(page.tasks()).toBe(NUMBERS.tasks);
  });

  it('an older-layout change labels its Build tab when a build log is in the older layout', async () => {
    const page = await open({ logLayouts: [{ repo: 'app', layout: 2 }, { repo: 'api', layout: 1 }] });
    await page.tab('Build');
    expect(text(page.notice())).toBe('Older layout');
  });

  it('a newer layout and a too-old plugin each get their notice', async () => {
    const newer = await open({ plan: { ...parsedPlan(), layout: 3 } as ReadResult });
    await newer.tab('Plan');
    expect(text(newer.notice())).toContain('This document needs a newer Workbench');
    expect(newer.tasks()).toBe(NUMBERS.tasks);
    TestBed.resetTestingModule();

    const old = await open({ readiness: { kind: 'tooOld', have: '0.6.0', need: '0.9.0' } });
    await old.tab('Spec');
    expect(text(old.notice())).toContain('Update the ai-sdlc plugin to 0.9.0 or later');
    expect(old.requirements()).toBe(0);
  });

  it('a layout 1 spec with problems shows the warning and the problems, not the older-layout label (F3)', async () => {
    const problems: Problem[] = [{ file: 'spec.md', line: 7, message: 'no layout version' }];
    const page = await open({ spec: { ...parsedSpec(), layout: 1, problems } as ReadResult });
    await page.tab('Spec');
    expect(text(page.notice())).toContain('line 7: no layout version');
    expect(page.notice()!.className).toContain('wb-banner--warn');
    expect(page.requirements()).toBe(NUMBERS.requirements);
  });

  it('an older build log does not hide the problems of the others on the Build tab (F3)', async () => {
    const buildProblems: Problem[] = [{ file: 'build/app.md', line: 9, message: 'task T2 is recorded twice' }];
    const page = await open({ logLayouts: [{ repo: 'app', layout: 2 }, { repo: 'api', layout: 1 }], buildProblems });
    await page.tab('Build');
    expect(text(page.notice())).toContain('line 9: task T2 is recorded twice');
    expect(text(page.notice())).not.toBe('Older layout');
  });

  it("a spec the program cannot read is shown as plain text with the program's message (F4)", async () => {
    const page = await open({ unreadable: { spec: 'front matter is not closed' } });
    await page.tab('Spec');
    expect(text(page.notice())).toContain('front matter is not closed');
    expect(page.notice()!.className).toContain('wb-banner--warn');
    expect(page.requirements()).toBe(0);
  });
});
