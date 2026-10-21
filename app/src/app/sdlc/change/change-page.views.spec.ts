import type { BuildStatus } from '@bindings/BuildStatus';
import type { TaskStatus } from '@bindings/TaskStatus';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { render } from '../../../testing/render';
import { KataTransport } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import { diagrams } from '../../lib/mermaid';
import { MOCK_BUILD_CHANGE } from '../../lib/sdlc-mock';
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

const SPEC = [
  '---',
  'status: accepted',
  '---',
  '# Spec: demo',
  '',
  '## Requirements',
  '',
  '```gherkin',
  'Feature: Demo',
  '',
  '  Rule: R1 — A policyholder attaches photos (from: Proposed outcome 1, D2)',
  '',
  '    Scenario: R1.1 — An eleventh photo is refused',
  '      Given a claim with 10 photos',
  '      When the policyholder adds one',
  '      Then the upload is refused',
  '',
  '  Rule: R2 — The portal says why (from: D3)',
  '',
  '    Scenario Outline: R2.1 — Each refusal has a reason',
  '      Given a photo that is <problem>',
  '      Then the portal says "<message>"',
  '',
  '      Examples:',
  '        | problem | message |',
  '        | too big | Over 10 MB |',
  '        | wrong type | JPEG or PNG only |',
  '',
  '    Scenario: R2.2 — The reason stays',
  '      Given a refusal',
  '      Then it stays visible',
  '',
  '  Rule: R3 — Nothing is lost (from: D4)',
  '',
  '    Scenario: R3.1 — A draft survives',
  '      Given a draft claim',
  '      Then it is kept',
  '```',
  '',
  '## Design',
  '',
  'The design text.',
  '',
].join('\n');
const SPEC_NO_DESIGN = SPEC.replace(/## Design[\s\S]*$/, '');
const SPEC_RULES_ONLY = ['---', 'status: accepted', '---', '# Spec: demo', '', '```gherkin', 'Feature: Demo', '', '  Rule: R1 — A rule (from: D1)', '', '  Rule: R2 — Another rule (from: D2)', '```', '', 'Whole text of the rules-only spec.', ''].join('\n');
const SPEC_NO_REQUIREMENTS = '---\nstatus: accepted\n---\n# Spec: demo\n\n## Rules\n\n1. Plain numbered rules.\n';

const PLAN = [
  '---',
  'status: accepted',
  '---',
  '# Plan: demo',
  '',
  '## Approach',
  '',
  'The approach text.',
  '',
  '## Tasks',
  '',
  '### T1: Refuse an eleventh photo (`claims-core`)',
  '',
].join('\n');

const text1 = [
  '### T1: Refuse an eleventh photo (`claims-core`)',
  '',
  '- **Depends on:** none',
  '- **Files:** `store.rs`',
  '- **Change:**',
  '  - Refuse the eleventh.',
  '  - Keep the first ten.',
  '- **Tests:** covers R2.1 and `R9` stays code.',
  '- **Done when:** the store refuses.',
].join('\n');
const text3 = '### T3: Show the message (`customer-portal`)\n\n- **Depends on:** T1\n- **Change:** Show it. Needs R1.1.\n- **Done when:** it shows.';
const text4 = '### T4: Notes only (`customer-portal`)\n\nJust do the thing described here.\n';
const task = (id: string, name: string, repo: string, dependsOn: string[], body: string, row: TaskStatus['row']): TaskStatus => ({
  id, name, repo, dependsOn, text: body, row,
});
const TASKS: TaskStatus[] = [
  task('T1', 'Refuse an eleventh photo', 'claims-core', [], text1, { task: 'T1', repo: 'claims-core', commits: ['aaa1111', 'bbb2222'], departure: null }),
  task('T2', 'Add the picker', 'customer-portal', [], '### T2: Add the picker (`customer-portal`)\n\n- **Depends on:** none\n- **Done when:** it picks.', {
    task: 'T2', repo: 'customer-portal', commits: ['ccc3333'], departure: 'Reused the existing picker.',
  }),
  task('T3', 'Show the message', 'customer-portal', ['T1'], text3, null),
  task('T4', 'Notes only', 'customer-portal', [], text4, null),
];
const status = (tasks: TaskStatus[]): BuildStatus => ({ tasks, repos: [], departures: [], hasTasks: tasks.length > 0, problems: [] });

async function mount(change: string, docs: Record<string, string | null>, tasks: TaskStatus[] = []) {
  const transport = new MockTransport();
  vi.spyOn(transport, 'sdlcReadDoc').mockImplementation(async (_m, _s, _c, stem) => docs[stem] ?? null);
  vi.spyOn(transport, 'sdlcBuildStatus').mockResolvedValue(status(tasks));
  const out = await render(ChangePage, {}, [
    provideRouter([]),
    { provide: KataTransport, useValue: transport },
    { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ system: 'claims', change })), snapshot: { queryParamMap: convertToParamMap({}) } } },
  ]);
  await settle();
  return out;
}
const pill = (c: HTMLElement, start: string) => Array.from(c.querySelectorAll<HTMLButtonElement>('header [role="tab"]')).find((t) => text(t).startsWith(start))!;
const toggle = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLButtonElement>('[data-testid="strip"] [role="radio"]'));
const checked = (c: HTMLElement) => toggle(c).filter((b) => b.getAttribute('aria-checked') === 'true').map(text);
const reqs = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLButtonElement>('nav[aria-label="Requirements"] button'));
const tasksNav = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLButtonElement>('nav[aria-label="Tasks"] button'));
const pickedOf = (buttons: HTMLElement[]) => buttons.filter((b) => b.getAttribute('aria-current') === 'true').map((b) => text(b).split(' ')[0]);

describe('ChangePage spec views', () => {
  let draw: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    draw = vi.spyOn(diagrams, 'render').mockResolvedValue('<svg></svg>');
  });
  afterEach(() => draw.mockRestore());

  it('puts the view toggle in the strip: Requirements with its count (the default), Design, Whole document', async () => {
    const { container } = await mount(FNOL, { spec: SPEC });
    expect(toggle(container).map(text)).toEqual(['Requirements · 3', 'Design', 'Whole document']);
    expect(checked(container)).toEqual(['Requirements · 3']);
  });

  it('lists the requirements with id, title and scenario count, and marks the first as picked', async () => {
    const { container } = await mount(FNOL, { spec: SPEC });
    expect(reqs(container).map(text)).toEqual([
      'R1 A policyholder attaches photos 1',
      'R2 The portal says why 2',
      'R3 Nothing is lost 1',
    ]);
    expect(pickedOf(reqs(container))).toEqual(['R1']);
  });

  it('shows the picked requirement: a muted line, the title as a heading, and one card per scenario', async () => {
    const { container } = await mount(FNOL, { spec: SPEC });
    const detail = container.querySelector('[data-testid="requirement"]')!;
    expect(text(detail.querySelector('.k-req__meta')!)).toBe('R1 · from Proposed outcome 1, D2 · 1 scenario');
    expect(text(detail.querySelector('h2')!)).toBe('A policyholder attaches photos');
    const cards = Array.from(detail.querySelectorAll('article'));
    expect(cards.map((c) => text(c.querySelector('h3')!))).toEqual(['R1.1 An eleventh photo is refused']);
    expect(Array.from(cards[0].querySelectorAll('.k-gherkin__kw')).map(text)).toEqual(['Given', 'When', 'Then']);
    expect(text(cards[0])).toContain('Given a claim with 10 photos');
  });

  it('crosses the seam: clicking a requirement picks it, and a Scenario Outline shows its examples as a table', async () => {
    const { container } = await mount(FNOL, { spec: SPEC });
    reqs(container)[1].click();
    await settle();
    expect(pickedOf(reqs(container))).toEqual(['R2']);
    const detail = container.querySelector('[data-testid="requirement"]')!;
    expect(text(detail.querySelector('.k-req__meta')!)).toBe('R2 · from D3 · 2 scenarios');
    const table = detail.querySelector('table')!;
    expect(Array.from(table.querySelectorAll('th')).map(text)).toEqual(['problem', 'message']);
    expect(Array.from(table.querySelectorAll('tbody tr')).map(text)).toEqual(['too big Over 10 MB', 'wrong type JPEG or PNG only']);
    expect(table.closest('article')!.classList.contains('k-scenario--wide')).toBe(true);
  });

  it('shows the Design section in the document layout, or says the spec has none', async () => {
    const { container } = await mount(FNOL, { spec: SPEC });
    toggle(container)[1].click();
    await settle();
    expect(checked(container)).toEqual(['Design']);
    expect(container.querySelector('nav[aria-label="Requirements"]')).toBeNull();
    expect(text(container.querySelector('app-doc-layout article')!)).toBe('Design The design text.');
    TestBed.resetTestingModule();
    const bare = await mount(FNOL, { spec: SPEC_NO_DESIGN });
    toggle(bare.container)[1].click();
    await settle();
    expect(text(bare.container.querySelector('[data-testid="no-section"]')!)).toBe('This spec has no Design section.');
  });

  it('shows the whole document in the document layout', async () => {
    const { container } = await mount(FNOL, { spec: SPEC });
    toggle(container)[2].click();
    await settle();
    expect(checked(container)).toEqual(['Whole document']);
    expect(container.querySelector('app-doc-layout article')!.textContent).toContain('The design text.');
    expect(container.querySelector('app-doc-layout article')!.textContent).toContain('Requirements');
  });

  it('shows only the whole document, with no toggle, for a spec without requirements', async () => {
    const { container } = await mount(FNOL, { spec: SPEC_NO_REQUIREMENTS });
    expect(toggle(container)).toEqual([]);
    expect(container.querySelector('nav[aria-label="Requirements"]')).toBeNull();
    expect(container.querySelector('app-doc-layout article')!.textContent).toContain('Plain numbered rules.');
  });

  it('shows only the whole document when the rules parse but no scenario does, never a list of 0 scenarios', async () => {
    const { container } = await mount(FNOL, { spec: SPEC_RULES_ONLY });
    expect(toggle(container)).toEqual([]);
    expect(container.querySelector('nav[aria-label="Requirements"]')).toBeNull();
    expect(container.querySelector('app-doc-layout article')!.textContent).toContain('Whole text of the rules-only spec.');
  });

  it('puts the view back to the default on another tab, and has no toggle on the intent', async () => {
    const { container } = await mount(FNOL, { spec: SPEC, intent: '# Intent\n\nWords.\n' });
    toggle(container)[1].click();
    await settle();
    pill(container, 'Intent').click();
    await settle();
    expect(toggle(container)).toEqual([]);
    pill(container, 'Spec').click();
    await settle();
    expect(checked(container)).toEqual(['Requirements · 3']);
  });

  it('keeps the not-in-folder message and shows no toggle when the spec is missing', async () => {
    const { container } = await mount(FNOL, { spec: null });
    expect(container.textContent).toContain('spec.md is not in this change folder.');
    expect(toggle(container)).toEqual([]);
  });
});

describe('ChangePage plan views', () => {
  let draw: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    draw = vi.spyOn(diagrams, 'render').mockResolvedValue('<svg></svg>');
  });
  afterEach(() => draw.mockRestore());
  const docs = { plan: PLAN, spec: SPEC };

  it('puts the view toggle in the strip: Tasks with the built count (the default), Approach, Whole document', async () => {
    const { container } = await mount(MOCK_BUILD_CHANGE, docs, TASKS);
    expect(toggle(container).map(text)).toEqual(['Tasks · 2/4 built', 'Approach', 'Whole document']);
    expect(checked(container)).toEqual(['Tasks · 2/4 built']);
  });

  it('lists the tasks in plan order with a built or not built text alternative, and picks the first unbuilt one', async () => {
    const { container } = await mount(MOCK_BUILD_CHANGE, docs, TASKS);
    expect(tasksNav(container).map(text)).toEqual(['T1 Refuse an eleventh photo', 'T2 Add the picker', 'T3 Show the message', 'T4 Notes only']);
    expect(tasksNav(container).map((b) => b.querySelector('[role="img"]')!.getAttribute('aria-label'))).toEqual(['built', 'built', 'not built', 'not built']);
    expect(pickedOf(tasksNav(container))).toEqual(['T3']);
  });

  it('picks the first task when every task is built', async () => {
    const built = TASKS.map((t) => ({ ...t, row: t.row ?? { task: t.id, repo: t.repo, commits: ['x'], departure: null } }));
    const { container } = await mount(MOCK_BUILD_CHANGE, docs, built);
    expect(pickedOf(tasksNav(container))).toEqual(['T1']);
  });

  it('shows the picked task: a muted line, the name as a heading, and each field but Depends on as a labeled section', async () => {
    const { container } = await mount(MOCK_BUILD_CHANGE, docs, TASKS);
    tasksNav(container)[0].click();
    await settle();
    const detail = container.querySelector('[data-testid="task"]')!;
    expect(text(detail.querySelector('.k-task__meta')!)).toBe('T1 · claims-core · depends on none');
    expect(text(detail.querySelector('h2')!)).toBe('Refuse an eleventh photo');
    const sections = Array.from(detail.querySelectorAll('section'));
    expect(sections.map((s) => text(s.querySelector('h3')!))).toEqual(['Files', 'Change', 'Tests', 'Done when']);
    expect(Array.from(sections[1].querySelectorAll('li')).map(text)).toEqual(['Refuse the eleventh.', 'Keep the first ten.']);
  });

  it('names the dependencies of a task in the muted line', async () => {
    const { container } = await mount(MOCK_BUILD_CHANGE, docs, TASKS);
    expect(text(container.querySelector('[data-testid="task"] .k-task__meta')!)).toBe('T3 · customer-portal · depends on T1');
  });

  it('shows the task text itself, without its heading line, when the task has no field bullets', async () => {
    const { container } = await mount(MOCK_BUILD_CHANGE, docs, TASKS);
    tasksNav(container)[3].click();
    await settle();
    const detail = container.querySelector('[data-testid="task"]')!;
    expect(text(detail.querySelector('h2')!)).toBe('Notes only');
    expect(detail.querySelectorAll('section').length).toBe(0);
    expect(text(detail.querySelector('.k-task__plain')!)).toBe('Just do the thing described here.');
  });

  it('shows the build record in the rail: as planned, with its commits as chips', async () => {
    const { container } = await mount(MOCK_BUILD_CHANGE, docs, TASKS);
    tasksNav(container)[0].click();
    await settle();
    const rail = container.querySelector('aside[aria-label="Build record"]')!;
    expect(text(rail.querySelector('.k-record__label')!)).toBe('As planned');
    expect(Array.from(rail.querySelectorAll('.k-chip')).map(text)).toEqual(['aaa1111', 'bbb2222']);
  });

  it('shows a departure in the rail, and says not built for a task without a row', async () => {
    const { container } = await mount(MOCK_BUILD_CHANGE, docs, TASKS);
    tasksNav(container)[1].click();
    await settle();
    const rail = container.querySelector('aside[aria-label="Build record"]')!;
    expect(text(rail.querySelector('.k-record__label')!)).toBe('Differs from plan');
    expect(text(rail)).toContain('Reused the existing picker.');
    tasksNav(container)[2].click();
    await settle();
    expect(text(rail.querySelector('.k-record__label')!)).toBe('Not built yet');
    expect(rail.querySelectorAll('.k-chip').length).toBe(0);
  });

  it('crosses the seam: Needed by lists the tasks that depend on this one, and a click picks that task', async () => {
    const { container } = await mount(MOCK_BUILD_CHANGE, docs, TASKS);
    tasksNav(container)[0].click();
    await settle();
    const needed = container.querySelector('[data-testid="needed-by"]')!;
    expect(Array.from(needed.querySelectorAll('button')).map(text)).toEqual(['T3']);
    needed.querySelector('button')!.click();
    await settle();
    expect(pickedOf(tasksNav(container))).toEqual(['T3']);
  });

  it('turns requirement ids in a task field into links that open that requirement on the Spec tab', async () => {
    const { container } = await mount(MOCK_BUILD_CHANGE, docs, TASKS);
    tasksNav(container)[0].click();
    await settle();
    const refs = Array.from(container.querySelectorAll<HTMLAnchorElement>('[data-testid="task"] a[href^="#req-"]'));
    expect(refs.map(text)).toEqual(['R2.1']);
    expect(container.querySelector('[data-testid="task"] code')!.textContent).toBe('store.rs');
    refs[0].click();
    await vi.waitFor(() => {
      TestBed.tick();
      expect(pickedOf(reqs(container))).toEqual(['R2']);
    });
    expect(pill(container, 'Spec').getAttribute('aria-selected')).toBe('true');
    expect(checked(container)).toEqual(['Requirements · 3']);
  });

  it('opens the Spec tab on its whole document, not on R1, for a requirement id the spec does not have', async () => {
    const tasks = TASKS.map((t) => (t.id === 'T3' ? { ...t, text: t.text.replace('R1.1', 'R99.1') } : t));
    const { container } = await mount(MOCK_BUILD_CHANGE, docs, tasks);
    tasksNav(container)[2].click();
    await settle();
    const ref = container.querySelector<HTMLAnchorElement>('[data-testid="task"] a[href="#req-R99.1"]')!;
    expect(text(ref)).toBe('R99.1');
    ref.click();
    await vi.waitFor(() => {
      TestBed.tick();
      expect(pill(container, 'Spec').getAttribute('aria-selected')).toBe('true');
    });
    await settle();
    expect(checked(container)).toEqual(['Whole document']);
    expect(container.querySelector('[data-testid="requirement"]')).toBeNull();
    expect(container.querySelector('app-doc-layout article')!.textContent).toContain('The design text.');
  });

  it('shows the lines between a task heading and its first field above the labeled sections', async () => {
    const lead = task('T5', 'Lead first', 'claims-core', [], '### T5: Lead first (`claims-core`)\n\nRead this before you start.\n\n- **Depends on:** none\n- **Change:** Do it.\n', null);
    const { container } = await mount(MOCK_BUILD_CHANGE, docs, [...TASKS, lead]);
    tasksNav(container)[4].click();
    await settle();
    const detail = container.querySelector('[data-testid="task"]')!;
    expect(text(detail.querySelector('.k-task__plain')!)).toBe('Read this before you start.');
    const sections = Array.from(detail.querySelectorAll('section'));
    expect(sections.map((x) => text(x.querySelector('h3')!))).toEqual(['Change']);
    expect(detail.querySelector('.k-task__plain')!.compareDocumentPosition(sections[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the Approach section, or the whole document, in the document layout', async () => {
    const { container } = await mount(MOCK_BUILD_CHANGE, docs, TASKS);
    toggle(container)[1].click();
    await settle();
    expect(container.querySelector('nav[aria-label="Tasks"]')).toBeNull();
    expect(text(container.querySelector('app-doc-layout article')!)).toBe('Approach The approach text.');
    toggle(container)[2].click();
    await settle();
    expect(container.querySelector('app-doc-layout article')!.textContent).toContain('Plan: demo');
    expect(container.querySelector('app-build-log-table')).toBeNull();
  });

  it('shows only the whole document, with no toggle, for a plan without tasks', async () => {
    const { container } = await mount(MOCK_BUILD_CHANGE, docs, []);
    expect(toggle(container)).toEqual([]);
    expect(container.querySelector('nav[aria-label="Tasks"]')).toBeNull();
    expect(container.querySelector('app-doc-layout')).not.toBeNull();
  });

  it('keeps the view state in the ViewModel and puts it back when the tab changes', async () => {
    const { fixture } = await mount(MOCK_BUILD_CHANGE, docs, TASKS);
    const vm = fixture.debugElement.injector.get(ChangePageViewModel);
    expect(vm.shownView()).toBe('list');
    vm.setView('whole');
    expect(vm.shownView()).toBe('whole');
    vm.pickTask('T2');
    expect(vm.pickedTask()?.id).toBe('T2');
    await vm.showDoc('spec');
    await settle();
    await vm.showDoc('plan');
    await settle();
    expect(vm.shownView()).toBe('list');
    expect(vm.pickedTask()?.id).toBe('T3');
  });
});
