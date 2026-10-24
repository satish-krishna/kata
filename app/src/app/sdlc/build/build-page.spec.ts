import { onTestFinished } from 'vitest';
import { ChangeDetectorRef, Component, inject, input, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { BuildRow } from '@bindings/BuildRow';
import type { Pick } from '../../lib/build-sessions';
import type { BuildStage } from '../../lib/build-stage';
import { defaultArrangement, type AreaId, type LayoutMode } from '../../lib/build-layout';
import type { LayoutStage } from '../../lib/build-layout-stage';
import { stopMessage, type Finding, type StageAction } from '../../lib/sdlc';
import { MOCK_BUILD_CHANGE, MOCK_MASTER, MOCK_WORKSPACE_FOLDER } from '../../lib/sdlc-mock';
import { KataTransport } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import { By } from '@angular/platform-browser';
import { ChangesView } from '../changes/changes-view';
import { monaco } from '../../ui/diff-editor/monaco.loader';
import { BuildLayoutViewModel, type ArrangeAction, type BuildLayoutState } from './build-layout.view-model';
import { BuildPage } from './build-page';
import { BuildPageViewModel } from './build-page.view-model';
import type { BuildChanges, BuildPageView, ShownSession, StatusText, TaskGroupView } from './build-page.view-model';

const CHANGES: BuildChanges = { folder: MOCK_WORKSPACE_FOLDER, masterRepo: MOCK_MASTER, system: 'claims', change: MOCK_BUILD_CHANGE };

const NOT_STARTED: StatusText = { tone: 'idle', label: 'Not started' };
const DONE: StatusText = { tone: 'success', label: 'Done' };
const RUNNING: StatusText = { tone: 'success', label: 'Running' };
const WAITING: StatusText = { tone: 'idle', label: 'Waiting for T1 in claims-core' };
const STOPPED: StatusText = { tone: 'error', label: 'Stopped here' };

const task = (id: string, status: StatusText, extra: { departure?: string | null; picked?: boolean } = {}) => ({
  id,
  name: `Task ${id}`,
  status,
  departure: extra.departure ?? null,
  picked: extra.picked ?? false,
});

const group = (repo: string, status: StatusText, action: TaskGroupView['action'], tasks: TaskGroupView['tasks'], picked = false, extra: Partial<TaskGroupView> = {}): TaskGroupView => ({
  repo,
  status,
  clock: null,
  paused: null,
  unseen: 0,
  stopLine: null,
  ...extra,
  action,
  picked,
  tasks,
});

const session = (id: string, over: Partial<ShownSession> = {}): ShownSession => ({
  id,
  startedAt: '09:00:00',
  spec: null,
  state: 'running',
  events: [],
  summary: null,
  asks: [],
  permissions: [],
  given: null,
  unseenFrom: null,
  latest: true,
  expanded: false,
  outcome: 'running',
  live: true,
  note: null,
  ...over,
});

const base = (over: Partial<BuildPageView> = {}): BuildPageView => ({
  stage: 'running',
  stageMessage: null,
  facts: { tasks: '1/3 tasks', elapsed: null },
  actions: [],
  groups: [],
  review: { status: { tone: 'idle', label: 'Not run' }, action: null, picked: false },
  pick: null,
  sessions: [],
  sessionNote: null,
  stops: [],
  findingsArea: { message: 'The review runs by itself once the last task is recorded.', staleNotice: null, review: null, departures: [], noDepartures: 'No departures from the plan.' },
  findingPlace: null,
  waiting: [],
  announcement: '',
  areas: { activity: true, files: true },
  counts: { files: 5, findings: 3 },
  ...over,
});

const LAYOUT: BuildLayoutState = { mode: 'overview', drawn: defaultArrangement('overview'), onShow: ['tasks', 'activity'], focus: null, flipped: {}, suggested: null };

const done3 = [group('claims-core', { tone: 'success', label: 'Finished' }, null, [task('T1', DONE), task('T2', DONE)]), group('customer-portal', { tone: 'success', label: 'Finished' }, null, [task('T3', DONE)])];

const FINDINGS = {
  notice: null,
  findings: [
    { severity: 'critical', text: 'The upload limit is duplicated.' },
    { severity: 'high', text: 'The refusal message has no test.' },
    { severity: 'low', text: 'A comment is stale.' },
  ] as Finding[],
  replaced: [],
  older: false,
  emptyText: 'Reviewed, nothing found.',
};

const SHOWN = { message: null, staleNotice: null, review: FINDINGS, departures: [], noDepartures: 'No departures from the plan.' };

@Component({
  imports: [BuildPage],
  template: `
    <app-build-page
      [view]="view"
      [layout]="layout"
      [context]="context"
      [turns]="0"
      [rows]="rows"
      [task]="task"
      [stopped]="stopped"
      [focus]="focus()"
      (pick)="picks.push($event)"
      (repoAction)="repoActions.push($event)"
      (act)="acts.push($event)"
      (cancelBuild)="cancels = cancels + 1"
      (answer)="answers.push($event)"
      (goTo)="goTos.push($event)"
      (toggleRun)="toggles.push($event)"
    />
  `,
})
class Host {
  view: BuildPageView = base();
  readonly layout = LAYOUT;
  task: { id: string; repo: string } | null = null;
  stopped: string[] = [];
  readonly focus = input<{ repo: string; n: number } | null>(null);
  readonly context = CHANGES;
  readonly rows: BuildRow[] = [];
  readonly picks: Pick[] = [];
  readonly repoActions: { repo: string; action: 'cancel' | 'continue' }[] = [];
  readonly acts: StageAction[] = [];
  cancels = 0;
  readonly answers: unknown[] = [];
  readonly goTos: string[] = [];
  readonly toggles: string[] = [];
}

const settle = async () => {
  for (let i = 0; i < 4; i++) {
    TestBed.tick();
    await new Promise((r) => setTimeout(r, 0));
  }
};
const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

async function mount(view: BuildPageView, extra: { stopped?: string[] } = {}) {
  TestBed.configureTestingModule({ imports: [Host], providers: [{ provide: KataTransport, useValue: new MockTransport() }] });
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.view = view;
  fixture.componentInstance.stopped = extra.stopped ?? [];
  await settle();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const area = (name: string) => el.querySelector<HTMLElement>(`[data-area="${name}"]`);
  const buttons = (root: ParentNode) => Array.from(root.querySelectorAll<HTMLButtonElement>('button'));
  const button = (root: ParentNode, name: string) => buttons(root).find((b) => norm(b.textContent) === name);
  const bar = () => el.querySelector<HTMLElement>('[data-bar]')!;
  const barActions = () =>
    buttons(bar())
      .filter((b) => b.closest('app-segmented') === null)
      .map((b) => norm(b.textContent))
      .filter((t) => !t.includes('tasks') && t !== 'Reset layout');
  const headingButtons = () => Array.from(el.querySelectorAll<HTMLElement>('[data-group]')).flatMap((g) => buttons(g.querySelector('[data-heading]')!).map((b) => norm(b.textContent)));
  return { fixture, host: fixture.componentInstance, el, area, button, buttons, bar, barActions, headingButtons };
}

beforeEach(() => {
  // Monaco never loads in a unit test; the editor waits on a load that does not finish.
  vi.spyOn(monaco, 'load').mockReturnValue(new Promise(() => undefined));
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('the build page at each stage', () => {
  const stage = (s: BuildStage, over: Partial<BuildPageView>) => base({ stage: s, ...over });

  it('not started: every task as not started, the other areas hidden, and start the build offered', async () => {
    const { area, barActions, el } = await mount(
      stage('not-started', {
        actions: ['start-build', 'reopen-intent'],
        groups: [group('claims-core', NOT_STARTED, null, [task('T1', NOT_STARTED), task('T2', NOT_STARTED)])],
        areas: { activity: false, files: false },
      }),
    );
    expect(Array.from(area('tasks')!.querySelectorAll('[data-task]')).map((t) => norm(t.textContent))).toEqual([
      expect.stringContaining('Not started'),
      expect.stringContaining('Not started'),
    ]);
    // The areas stay in the grid with nothing in them.
    expect(area('activity')!.querySelector('app-observe-pane')).toBeNull();
    expect(norm(area('activity')!.textContent)).toContain('The activity shows here once the build runs.');
    expect(area('files')!.querySelector('app-changes-view')).toBeNull();
    expect(el.querySelector('app-changes-view')).toBeNull();
    expect(barActions()).toContain('Start build');
  });

  it('running: tasks as waiting, running or done; the picked live session; the work landed so far; cancel the build and one repository', async () => {
    const v = stage('running', {
      actions: ['cancel-build'],
      groups: [
        group('claims-core', { tone: 'success', label: 'Working · T2' }, 'cancel', [task('T1', DONE), task('T2', RUNNING, { picked: true })], true),
        group('customer-portal', { tone: 'idle', label: 'Waiting for T1 in claims-core' }, null, [task('T3', WAITING)]),
      ],
      pick: { kind: 'repo', repo: 'claims-core' },
      sessions: [session('r1')],
    });
    const { area, barActions, headingButtons, el } = await mount(v);
    const labels = Array.from(area('tasks')!.querySelectorAll('[data-task]')).map((t) => norm(t.textContent));
    expect(labels[0]).toContain('Done');
    expect(labels[1]).toContain('Running');
    expect(labels[2]).toContain('Waiting for T1 in claims-core');
    expect(area('activity')!.querySelectorAll('app-observe-pane')).toHaveLength(1);
    expect(area('files')!.querySelector('app-changes-view')).not.toBeNull();
    expect(barActions()).toEqual(['Cancel build']);
    expect(headingButtons()).toEqual(['claims-core', 'Cancel', 'customer-portal']);
    expect(norm(el.querySelector('[data-bar]')!.textContent)).toContain('1/3 tasks');
  });

  it('a heading shows the work clock, the paused clock, Waiting for you and the unseen count', async () => {
    const v = stage('running', {
      actions: ['cancel-build'],
      groups: [
        group('claims-core', { tone: 'warning', label: 'Waiting for you' }, 'cancel', [task('T1', RUNNING)], true, { clock: 'work 0:12:00 of 2:00:00', paused: '1:15 waiting (not counted)', unseen: 4 }),
        group('customer-portal', { tone: 'success', label: 'Working · T2' }, 'cancel', [task('T2', RUNNING)]),
      ],
    });
    const { el } = await mount(v);
    const [first, second] = Array.from(el.querySelectorAll('[data-heading]')).map((h) => norm(h.textContent));
    expect(first).toContain('Waiting for you');
    expect(first).toContain('work 0:12:00 of 2:00:00');
    expect(first).toContain('1:15 waiting (not counted)');
    expect(first).toContain('4 new');
    expect(second).not.toContain('new');
    expect(second).not.toContain('work ');
  });

  it('running with one repository stopped: where it stopped, why, the work so far, and continue the stopped repository', async () => {
    const reason = stopMessage(124, null);
    const v = stage('running-one-stopped', {
      actions: ['cancel-build'],
      groups: [
        group('claims-core', { tone: 'success', label: 'Working · T2' }, 'cancel', [task('T1', DONE), task('T2', RUNNING)]),
        group('customer-portal', { tone: 'error', label: 'Stopped at T3' }, 'continue', [task('T3', STOPPED)]),
      ],
      stops: [{ repo: 'customer-portal', reason }],
      pick: { kind: 'repo', repo: 'claims-core' },
      sessions: [session('r1')],
    });
    const { area, barActions, headingButtons } = await mount(v, { stopped: ['customer-portal'] });
    expect(norm(area('tasks')!.querySelectorAll('[data-task]')[2].textContent)).toContain('Stopped here');
    expect(area('activity')!.querySelectorAll('app-observe-pane')).toHaveLength(1);
    expect(norm(area('activity')!.querySelector('[data-stops]')!.textContent)).toContain(`customer-portal ${reason}`);
    expect(area('files')!.querySelector('app-changes-view')).not.toBeNull();
    expect(barActions()).toEqual(['Cancel build']);
    expect(headingButtons()).toEqual(['claims-core', 'Cancel', 'customer-portal', 'Continue customer-portal']);
  });

  for (const [name, s, message] of [
    ['stopped with nothing more able to run', 'stopped', 'The build stopped. Nothing more can run.'],
    ['cancelled', 'cancelled', 'The build was cancelled.'],
  ] as const) {
    it(`${name}: each repository's stop, why, leftovers, and continue a repository or ask for another round`, async () => {
      const v = stage(s, {
        actions: ['continue-build', 'another-round'],
        groups: [group('claims-core', { tone: 'error', label: 'Stopped at T2' }, 'continue', [task('T1', DONE), task('T2', STOPPED)])],
        stageMessage: { title: message, lines: [] },
        stops: [{ repo: 'claims-core', reason: stopMessage(130, null) }],
        pick: { kind: 'repo', repo: 'claims-core' },
        sessions: [],
      });
      const { area, barActions, headingButtons } = await mount(v, { stopped: ['claims-core'] });
      expect(norm(area('tasks')!.querySelectorAll('[data-task]')[1].textContent)).toContain('Stopped here');
      expect(norm(area('activity')!.textContent)).toContain(message);
      expect(norm(area('activity')!.querySelector('[data-stops]')!.textContent)).toContain('claims-core');
      expect(area('files')!.querySelector('app-changes-view')).not.toBeNull();
      expect(barActions()).toEqual(['Continue build', 'Another round']);
      expect(headingButtons()).toContain('Continue claims-core');
    });
  }

  it('every task done, review running: every task done, the review live session, the whole change, cancel the build', async () => {
    const v = stage('reviewing', {
      actions: ['cancel-build'],
      groups: done3,
      review: { status: { tone: 'success', label: 'Running' }, action: 'cancel', picked: true },
      pick: { kind: 'review' },
      sessions: [session('rv1')],
      stageMessage: null,
    });
    const { area, barActions } = await mount(v);
    const states = Array.from(area('tasks')!.querySelectorAll('[data-task]')).map((t) => norm(t.textContent));
    expect(states.every((t) => t.includes('Done'))).toBe(true);
    expect(area('activity')!.querySelectorAll('app-observe-pane')).toHaveLength(1);
    expect(area('activity')!.querySelector('app-findings-list')).toBeNull();
    expect(area('files')!.querySelector('app-changes-view')).not.toBeNull();
    expect(barActions()).toEqual(['Cancel build']);
  });

  it('every task done, review finished: the findings, the whole change, declare done, another round, run the review again', async () => {
    const v = stage('review-finished', {
      actions: ['declare-done', 'another-round', 'run-review'],
      groups: done3,
      review: { status: { tone: 'success', label: 'Finished' }, action: null, picked: true },
      pick: { kind: 'review' },
      findingsArea: SHOWN,
      stageMessage: { title: 'Every task is in the build log.', lines: [] },
    });
    const { area, barActions } = await mount(v);
    expect(area('findings')!.querySelector('app-findings-list')).not.toBeNull();
    expect(area('activity')!.querySelector('app-findings-list')).toBeNull();
    expect(area('activity')!.querySelector('app-observe-pane')).toBeNull();
    expect(area('files')!.querySelector('app-changes-view')).not.toBeNull();
    expect(barActions()).toEqual(['Declare done', 'Another round', 'Run review']);
  });

  it('done with pull requests open: the findings, the whole change, no declare done and no actions on the page (the pull request links live in the toolbar)', async () => {
    const v = stage('done', {
      actions: [],
      groups: done3,
      review: { status: { tone: 'success', label: 'Finished' }, action: null, picked: true },
      pick: { kind: 'review' },
      findingsArea: SHOWN,
    });
    const { area, barActions, bar } = await mount(v);
    expect(area('findings')!.querySelector('app-findings-list')).not.toBeNull();
    expect(area('files')!.querySelector('app-changes-view')).not.toBeNull();
    expect(barActions()).toEqual([]);
    expect(norm(bar().textContent)).not.toContain('Declare done');
  });
});

describe('the build page, questions and stops', () => {
  it('a question in another repository shows on the page and one step goes to it', async () => {
    const v = base({
      groups: [group('claims-core', RUNNING, 'cancel', [task('T1', RUNNING)], true), group('customer-portal', RUNNING, 'cancel', [task('T2', RUNNING)])],
      pick: { kind: 'repo', repo: 'claims-core' },
      sessions: [session('r1')],
      waiting: [{ repo: 'customer-portal', kind: 'answer', countdown: null, waited: '0:05' }],
    });
    const { el, host, button } = await mount(v);
    const notice = el.querySelector<HTMLElement>('app-waiting-notice')!;
    expect(norm(notice.textContent)).toContain('The agent in customer-portal is waiting for your answer.');
    button(notice, 'Go to customer-portal')!.click();
    expect(host.goTos).toEqual(['customer-portal']);
  });

  it('Go to brings the picked repository\'s open question into view and focuses it, not an answered one or a hidden session\'s', async () => {
    const ask = (id: string, answers: string[][] | null) => ({
      id,
      questions: [{ kind: 'text' as const, header: 'scope', question: 'Fix or isolate?', optional: false }],
      answers,
      at: 0,
    });
    const scrolled: Element[] = [];
    // jsdom has no scrollIntoView; the page calls it on the card.
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value(this: Element) {
        scrolled.push(this);
      },
    });
    onTestFinished(() => void delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView);
    const v = base({
      groups: [group('claims-core', RUNNING, 'cancel', [task('T1', RUNNING)]), group('customer-portal', RUNNING, 'cancel', [task('T2', RUNNING)], true)],
      pick: { kind: 'repo', repo: 'customer-portal' },
      sessions: [
        session('hidden', { state: 'awaiting', asks: [ask('h1', null)], shown: false }),
        session('answered', { state: 'running', asks: [ask('a1', [['isolate']])], latest: false, expanded: true }),
        session('open', { state: 'awaiting', asks: [ask('q1', null)] }),
      ],
      waiting: [{ repo: 'customer-portal', kind: 'answer', countdown: null, waited: '0:05' }],
    });
    const { el, fixture } = await mount(v);
    expect(scrolled).toEqual([]);
    fixture.componentRef.setInput('focus', { repo: 'customer-portal', n: 1 });
    fixture.detectChanges();
    await settle();
    const card = el.querySelector<HTMLElement>('[data-session="open"] .k-ask')!;
    expect(card).not.toBeNull();
    expect(scrolled).toEqual([card]);
    expect(card.contains(document.activeElement)).toBe(true);
    // A second Go to to the same repository asks again.
    (document.activeElement as HTMLElement).blur();
    fixture.componentRef.setInput('focus', { repo: 'customer-portal', n: 2 });
    fixture.detectChanges();
    await settle();
    expect(scrolled).toEqual([card, card]);
    expect(card.contains(document.activeElement)).toBe(true);
  });

  for (const [reason, exit] of [
    ['it reached the time limit', 124],
    ['it was cancelled', 130],
    ['nobody answered', 123],
    ['the agent failed', 1],
  ] as const) {
    it(`a stopped repository shows why, where it stopped and its leftovers while the others go on: ${reason}`, async () => {
      const text = stopMessage(exit, null);
      await stoppedCase(text);
    });
  }

  it('a stopped repository shows why, where it stopped and its leftovers while the others go on: it ended without its task being recorded', async () => {
    await stoppedCase(stopMessage(0, null, false, false));
  });

  async function stoppedCase(reason: string) {
    const v = base({
      stage: 'running-one-stopped',
      groups: [
        group('claims-core', { tone: 'error', label: 'Stopped at T2' }, 'continue', [task('T1', DONE), task('T2', STOPPED)]),
        group('customer-portal', RUNNING, 'cancel', [task('T3', RUNNING)]),
      ],
      stops: [{ repo: 'claims-core', reason }],
      pick: { kind: 'repo', repo: 'customer-portal' },
      sessions: [session('r1')],
    });
    const { el, area, fixture } = await mount(v, { stopped: ['claims-core'] });
    const stops = norm(area('activity')!.querySelector('[data-stops]')!.textContent);
    expect(stops).toContain('claims-core');
    expect(stops).toContain(reason);
    expect(norm(area('tasks')!.querySelectorAll('[data-task]')[1].textContent)).toContain('Stopped here');
    expect(norm(el.querySelectorAll('[data-group]')[1].textContent)).toContain('Running');
    // The uncommitted file the stopped run left shows in the changed files.
    const open = Array.from(el.querySelectorAll<HTMLElement>('app-repo-file-list [data-repo]')).find((h) => norm(h.textContent).startsWith('claims-core'));
    open?.click();
    await settle();
    fixture.detectChanges();
    expect(norm(area('files')!.querySelector('[data-left]')?.textContent)).toBe('left by the stopped run');
  }

  it('the findings show most serious first with the whole change', async () => {
    const v = base({
      stage: 'review-finished',
      groups: done3,
      pick: { kind: 'review' },
      findingsArea: SHOWN,
      stageMessage: { title: 'Every task is in the build log.', lines: [] },
    });
    const { area } = await mount(v);
    const items = Array.from(area('findings')!.querySelectorAll('app-findings-list li .k-findings__text')).map((e) => norm(e.textContent));
    expect(items).toEqual(['The upload limit is duplicated.', 'The refusal message has no test.', 'A comment is stale.']);
    expect(norm(area('activity')!.textContent)).toContain('Every task is in the build log.');
    expect(area('files')!.querySelector('app-changes-view')).not.toBeNull();
  });
});

describe('the build page, picking and folding', () => {
  it('emits what the engineer picks and the buttons they press', async () => {
    const v = base({
      actions: ['cancel-build'],
      groups: [group('claims-core', RUNNING, 'cancel', [task('T1', RUNNING)])],
      review: { status: { tone: 'idle', label: 'Not run' }, action: null, picked: false },
      sessions: [session('r1')],
    });
    const { host, area, button, bar } = await mount(v);
    (area('tasks')!.querySelector('[data-task]') as HTMLButtonElement).click();
    (area('tasks')!.querySelector('[data-review]') as HTMLButtonElement).click();
    button(area('tasks')!, 'claims-core')!.click();
    button(area('tasks')!, 'Cancel')!.click();
    button(bar(), 'Cancel build')!.click();
    expect(host.picks).toEqual([{ kind: 'task', task: 'T1' }, { kind: 'review' }, { kind: 'repo', repo: 'claims-core' }]);
    expect(host.repoActions).toEqual([{ repo: 'claims-core', action: 'cancel' }]);
    expect(host.cancels).toBe(1);
    expect(host.acts).toEqual([]);
  });

  it('marks a done task with a departure and says the picked session is not known', async () => {
    const v = base({
      groups: [group('claims-core', RUNNING, null, [task('T1', DONE, { departure: 'Used a queue instead' })])],
      pick: { kind: 'task', task: 'T1' },
      sessionNote: 'This task was recorded before Kata linked tasks to runs, or on another machine. Showing every session of claims-core.',
      sessions: [session('r1')],
    });
    const { area } = await mount(v);
    expect(area('tasks')!.querySelector('[data-departure]')).not.toBeNull();
    expect(norm(area('activity')!.textContent)).toContain('Showing every session of claims-core.');
  });

  it('folds an earlier session to one line, keeps its pane mounted, and opens it when picked', async () => {
    const v = base({
      pick: { kind: 'repo', repo: 'claims-core' },
      sessions: [session('r0', { latest: false, outcome: 'exit 124', startedAt: '08:00:00', live: false }), session('r1')],
    });
    const { area, host, el } = await mount(v);
    const panes = area('activity')!.querySelectorAll<HTMLElement>('[data-session]');
    expect(panes).toHaveLength(2);
    expect(panes[0].querySelector<HTMLElement>('[data-pane]')!.hidden).toBe(true);
    expect(panes[0].querySelector('app-observe-pane')).not.toBeNull();
    const line = panes[0].querySelector<HTMLButtonElement>('[data-run-line]')!;
    expect(norm(line.textContent)).toContain('08:00:00');
    expect(norm(line.textContent)).toContain('exit 124');
    line.click();
    expect(host.toggles).toEqual(['r0']);
    expect(el.querySelector('[data-session="r1"] [data-pane]')).not.toBeNull();
  });

  it('a live pane stays mounted, hidden, when another repository is picked', async () => {
    const v = base({
      pick: { kind: 'repo', repo: 'customer-portal' },
      sessions: [session('a', { shown: false }), session('b')],
    });
    const { el } = await mount(v);
    const a = el.querySelector<HTMLElement>('[data-session="a"]');
    const b = el.querySelector<HTMLElement>('[data-session="b"]');
    expect(a?.querySelector('app-observe-pane')).not.toBeNull();
    expect(a?.hidden).toBe(true);
    expect(b?.querySelector('app-observe-pane')).not.toBeNull();
    expect(b?.hidden).toBe(false);
  });

});

/* The arranged page: a host that drives a real layout view model over a stand-in for the build page's view model, so every step goes
 * through the page's DOM and comes back as DOM. */
type Where = 'middle' | 'left' | 'right' | 'bottom' | 'tucked';
const AREAS: AreaId[] = ['tasks', 'activity', 'files', 'findings'];
const NAMES: Record<AreaId, string> = { tasks: 'Tasks', activity: 'Activity', files: 'Changed files', findings: 'Findings' };
const MODE_NAMES: Record<LayoutMode, string> = { overview: 'Overview', watch: 'Watch', changes: 'Changes', review: 'Review' };
const DEFAULT_PLACES: Record<LayoutMode, Record<AreaId, Where>> = {
  overview: { tasks: 'middle', activity: 'right', files: 'tucked', findings: 'tucked' },
  watch: { tasks: 'left', activity: 'middle', files: 'tucked', findings: 'tucked' },
  changes: { tasks: 'tucked', activity: 'bottom', files: 'middle', findings: 'tucked' },
  review: { tasks: 'tucked', activity: 'tucked', files: 'middle', findings: 'left' },
};

function layoutStandIn(stage: LayoutStage) {
  const announcement = signal('');
  return {
    loaded: signal<{ ctx: { change: string } } | null>(null),
    layoutStage: signal<LayoutStage>(stage),
    announcement,
    say: (text: string) => announcement.set(text),
  };
}

/** The stand-in the arranged host reads the announcement from; mountArranged sets it. */
let announced: () => string = () => '';

@Component({
  imports: [BuildPage],
  providers: [BuildLayoutViewModel],
  template: `
    <app-build-page
      [view]="shown()"
      [layout]="layout.view()"
      [context]="context"
      [turns]="0"
      [rows]="rows"
      [task]="task"
      [stopped]="[]"
      [focus]="focusRequest"
      (goTo)="goTo($event)"
      (pick)="choose($event)"
      (pickMode)="layout.pickMode($event)"
      (arrange)="arranged($event)"
      (focusOn)="layout.focusOn($event)"
      (unfocus)="layout.unfocus()"
      (flip)="layout.flip($event.place, $event.area)"
      (room)="layout.room.set($event)"
      (reveal)="layout.reveal($event)"
      (showFinding)="showFinding($event)"
    />
  `,
})
class ArrangedHost {
  private placed = 0;
  private drawn: { from: BuildPageView; said: string; view: BuildPageView } | null = null;
  readonly layout = inject(BuildLayoutViewModel);
  readonly context = CHANGES;
  readonly rows: BuildRow[] = [];
  readonly arranges: ArrangeAction[] = [];
  task: { id: string; repo: string } | null = null;
  /** The request a Go to makes of the page, as the build page's view model makes it. */
  focusRequest: { repo: string; n: number } | null = null;
  /** The session each repository shows, when a test gives the sessions a repository each. */
  sessionOf: Record<string, string> | null = null;
  view: BuildPageView = base({
    groups: [
      group('claims-core', RUNNING, 'cancel', [task('T1', DONE), task('T2', RUNNING)]),
      group('customer-portal', RUNNING, 'cancel', [task('T3', RUNNING)]),
    ],
    sessions: [session('r1')],
    findingsArea: SHOWN,
  });

  /** What the page draws: the host's view with the announcement the layout view model asked the build page's view model to make. */
  shown(): BuildPageView {
    const said = announced();
    if (this.drawn === null || this.drawn.from !== this.view || this.drawn.said !== said) this.drawn = { from: this.view, said, view: { ...this.view, announcement: said } };
    return this.drawn.view;
  }

  /** Set the place the way the build page's view model does. */
  showFinding(f: Finding): void {
    this.view = { ...this.view, findingPlace: { file: f.file!, line: f.line ?? null, text: f.text, n: ++this.placed } };
  }

  arranged(action: ArrangeAction): void {
    this.arranges.push(action);
    this.layout.arrange(action);
  }

  /** Pick the repository and ask for its open question, the way the build page's view model does. */
  goTo(repo: string): void {
    this.choose({ kind: 'repo', repo });
    this.focusRequest = { repo, n: (this.focusRequest?.n ?? 0) + 1 };
  }

  /** Mark the pick the way the build page's view model does. The changed files are not limited to the task, so the list stays whole. */
  choose(pick: Pick): void {
    const repoOf = (id: string) => this.view.groups.find((g) => g.tasks.some((t) => t.id === id))?.repo;
    const repo = pick.kind === 'repo' ? pick.repo : pick.kind === 'task' ? repoOf(pick.task) : undefined;
    this.view = {
      ...this.view,
      pick,
      sessions: this.sessionOf === null ? this.view.sessions : this.view.sessions.map((x) => ({ ...x, shown: this.sessionOf![repo ?? ''] === x.id })),
      groups: this.view.groups.map((g) => ({ ...g, picked: g.repo === repo, tasks: g.tasks.map((t) => ({ ...t, picked: pick.kind === 'task' && pick.task === t.id })) })),
    };
  }
}

const KEY_CODES: Record<string, number> = { Enter: 13, Escape: 27, ' ': 32, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };

async function mountArranged(stage: LayoutStage = 'running') {
  const standIn = layoutStandIn(stage);
  announced = standIn.announcement;
  TestBed.configureTestingModule({
    imports: [ArrangedHost],
    providers: [
      { provide: KataTransport, useValue: new MockTransport() },
      { provide: BuildPageViewModel, useValue: standIn },
    ],
  });
  const fixture = TestBed.createComponent(ArrangedHost);
  const host = fixture.componentInstance;
  fixture.detectChanges();
  await settle();
  host.layout.open('A');
  const el = fixture.nativeElement as HTMLElement;
  const refresh = async () => {
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  };
  await refresh();
  const area = (a: AreaId) => el.querySelector<HTMLElement>(`[data-area="${a}"]`)!;
  const where = (a: AreaId) => area(a).getAttribute('data-place') as Where;
  const places = () => Object.fromEntries(AREAS.map((a) => [a, where(a)])) as Record<AreaId, Where>;
  const text = (e: Element) => norm(e.textContent);
  const inside = (root: ParentNode, selector: string, name: string) =>
    Array.from(root.querySelectorAll<HTMLElement>(selector)).find((b) => text(b) === name || b.getAttribute('aria-label') === name)!;
  const click = async (e: HTMLElement) => {
    e.click();
    await refresh();
  };
  const bar = () => el.querySelector<HTMLElement>('[data-bar]')!;
  const switcher = () => el.querySelector<HTMLElement>('[data-bar] app-segmented')!;
  const mode = async (m: LayoutMode) => {
    const option = Array.from(switcher().querySelectorAll<HTMLElement>('button')).find((b) => text(b).startsWith(MODE_NAMES[m]))!;
    if (option.getAttribute('aria-checked') !== 'true') await click(option);
  };
  const rail = (edge: string) => Array.from(el.querySelectorAll<HTMLElement>(`[data-rail="${edge}"] button`)).map(text);
  const tuckButton = (a: AreaId) => area(a).querySelector<HTMLButtonElement>(`button[aria-label="Tuck ${NAMES[a]} away"]`)!;
  const focusButton = (a: AreaId) => area(a).querySelector<HTMLButtonElement>(`button[aria-label="Focus ${NAMES[a]}"]`)!;
  const trigger = (a: AreaId) => area(a).querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
  /** The items of the open Place menu: the Helm menu is portalled to the overlay container, outside the page. */
  const menuItems = () => Array.from(document.body.querySelectorAll<HTMLElement>('.cdk-overlay-container [role="menuitem"]'));
  const placeTo = async (a: AreaId, to: string) => {
    await click(trigger(a));
    await click(menuItems().find((b) => text(b) === to)!);
  };
  /** Press a key where the focus is, as a browser would: a focused button is activated by Enter, or by Space on release, unless the key was handled. */
  const press = async (key: string, mods: { shift?: boolean; ctrl?: boolean } = {}) => {
    const target = document.activeElement ?? document.body;
    // The CDK menu reads the legacy keyCode, which a real key press carries.
    const down = new KeyboardEvent('keydown', { key, keyCode: KEY_CODES[key], shiftKey: mods.shift ?? false, ctrlKey: mods.ctrl ?? false, bubbles: true, cancelable: true });
    target.dispatchEvent(down);
    // The CDK menu takes a synthetic Enter or Space as the activation itself (it leaves a trusted one to the browser's click), so it is not clicked twice.
    const cdkActs = target instanceof HTMLElement && target.matches('[data-slot="dropdown-menu-trigger"], [data-slot="dropdown-menu-item"]');
    if (!down.defaultPrevented && !cdkActs && target instanceof HTMLButtonElement && !target.disabled && (key === 'Enter' || key === ' ')) {
      if (key === ' ') target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
      target.click();
    }
    await refresh();
    return down;
  };
  /** Go to a control the way Tab does: only one that Tab can reach, which is neither disabled nor hidden nor inert nor taken out of the tab order. */
  const tabTo = (e: HTMLElement) => {
    expect(e.closest('[inert], [hidden]'), 'not inert or hidden').toBeNull();
    expect((e as HTMLButtonElement).disabled, 'not disabled').not.toBe(true);
    expect(e.tabIndex, 'in the tab order').toBeGreaterThanOrEqual(0);
    e.focus();
    expect(document.activeElement).toBe(e);
  };
  const live = () => text(el.querySelector('[aria-live="assertive"]')!);
  const inert = (a: AreaId) => area(a).hasAttribute('inert');
  const banner = () => el.querySelector<HTMLElement>('[data-focus-banner]');
  return { fixture, host, standIn, el, area, where, places, text, inside, click, bar, switcher, mode, rail, tuckButton, focusButton, trigger, menuItems, placeTo, press, tabTo, live, inert, banner, refresh };
}

beforeAll(() => {
  // jsdom has no ResizeObserver (CDK overlay positioning).
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(() => document.body.querySelectorAll('.cdk-overlay-container').forEach((n) => (n.innerHTML = '')));

describe('the arranged build page', () => {
  it('R2.1: each mode opens in its default arrangement, the rest tucked at the right edge', async () => {
    const page = await mountArranged();
    const tucked: Record<LayoutMode, string[]> = {
      overview: ['Changed files', 'Findings'],
      watch: ['Changed files', 'Findings'],
      changes: ['Tasks', 'Findings'],
      review: ['Tasks', 'Activity'],
    };
    for (const m of ['overview', 'watch', 'changes', 'review'] as const) {
      await page.mode(m);
      expect(page.places(), m).toEqual(DEFAULT_PLACES[m]);
      expect(page.rail('right'), m).toEqual(tucked[m]);
    }
  });

  for (const [stage, from, to] of [
    ['started', 'overview', 'watch'],
    ['running', 'watch', 'changes'],
    ['running', 'changes', 'review'],
    ['stopped', 'review', 'overview'],
    ['finished', 'review', 'watch'],
    ['finished', 'overview', 'changes'],
  ] as const) {
    it(`R3.1: ${stage}, from ${from} to ${to}, one pick in the switcher shows the arrangement`, async () => {
      const page = await mountArranged(stage);
      await page.mode(from);
      expect(page.places()).toEqual(DEFAULT_PLACES[from]);
      await page.mode(to);
      expect(page.places()).toEqual(DEFAULT_PLACES[to]);
    });
  }

  it('marks the mode suited to a new stage as suggested, without moving the page', async () => {
    const page = await mountArranged('running');
    expect(page.places()).toEqual(DEFAULT_PLACES.watch);
    page.standIn.layoutStage.set('stopped');
    await page.refresh();
    expect(page.places()).toEqual(DEFAULT_PLACES.watch);
    const options = Array.from(page.switcher().querySelectorAll('button')).map((b) => page.text(b));
    expect(options).toEqual(['Overview suggested', 'Watch', 'Changes', 'Review']);
  });

  it('R3.2: the switcher is the same element in the bar after moves, a tuck, a stack and a focus', async () => {
    const page = await mountArranged();
    const before = page.switcher();
    expect(page.bar().contains(before)).toBe(true);
    await page.placeTo('activity', 'Left');
    await page.click(page.tuckButton('tasks'));
    await page.click(page.inside(page.el, '[data-rail="right"] button', 'Findings'));
    await page.placeTo('findings', 'Left');
    await page.click(page.focusButton('files'));
    expect(page.banner()).not.toBeNull();
    expect(page.switcher()).toBe(before);
    expect(page.bar().contains(page.switcher())).toBe(true);
    await page.mode('review');
    expect(page.switcher()).toBe(before);
  });

  it('R3.3: switching mode keeps the picks and the same changed-files view', async () => {
    const page = await mountArranged();
    const view = page.el.querySelector<HTMLElement>('app-changes-view')!;
    expect(view).not.toBeNull();
    await page.click(page.inside(page.area('tasks'), 'button', 'claims-core'));
    await page.click(page.area('tasks').querySelectorAll<HTMLElement>('[data-task]')[1]);
    await page.click(page.inside(view, 'button', 'Committed'));
    const repoHead = Array.from(view.querySelectorAll<HTMLElement>('app-repo-file-list [data-repo]')).find((h) => page.text(h).startsWith('claims-core'));
    if (view.querySelector('[data-file="src/store.rs"]') === null && repoHead !== undefined) await page.click(repoHead);
    await page.click(view.querySelector<HTMLElement>('[data-file="src/store.rs"]')!);
    expect(view.querySelector('[data-file="src/store.rs"]')!.getAttribute('aria-current')).toBe('true');
    await page.mode('changes');
    expect(page.el.querySelector('app-changes-view')).toBe(view);
    expect(page.inside(view, 'button', 'Committed').getAttribute('aria-checked')).toBe('true');
    expect(view.querySelector('[data-file="src/store.rs"]')!.getAttribute('aria-current')).toBe('true');
    expect(page.area('tasks').querySelector('.k-bp__name[aria-current="true"]')).not.toBeNull();
    expect(page.area('tasks').querySelectorAll('[data-task][aria-current="true"]')).toHaveLength(1);
  });

  it('R5.1: dragging the left separator draws the new size during the drag, emits once on release and stops at the minimum', async () => {
    const page = await mountArranged();
    await page.mode('watch');
    const grid = page.el.querySelector<HTMLElement>('.k-bp__grid')!;
    Object.defineProperty(grid, 'clientWidth', { configurable: true, value: 1280 });
    Object.defineProperty(grid, 'clientHeight', { configurable: true, value: 800 });
    const separator = page.el.querySelector<HTMLElement>('[role="separator"][data-side="left"]')!;
    expect(separator.getAttribute('aria-orientation')).toBe('vertical');
    expect(separator.getAttribute('aria-valuenow')).toBe('300');
    expect(separator.getAttribute('aria-label')).toBe('Resize the tasks and the middle');
    const fire = (type: string, clientX: number) => separator.dispatchEvent(new MouseEvent(type, { clientX, clientY: 0, bubbles: true }));
    fire('pointerdown', 300);
    fire('pointermove', 420);
    expect(grid.style.getPropertyValue('--k-left')).toBe('420px');
    expect(page.host.arranges).toEqual([]);
    fire('pointermove', -500);
    expect(grid.style.getPropertyValue('--k-left')).toBe('160px');
    fire('pointerup', -500);
    await page.refresh();
    expect(page.host.arranges).toEqual([{ kind: 'resize', side: 'left', px: 160 }]);
    expect(page.el.querySelector('[role="separator"][data-side="left"]')!.getAttribute('aria-valuenow')).toBe('160');
    expect(grid.style.getPropertyValue('--k-left')).toBe('');
  });

  for (const [a, from, to, mode] of [
    ['activity', 'right', 'Left', 'overview'],
    ['activity', 'right', 'Bottom', 'overview'],
    ['tasks', 'left', 'Right', 'watch'],
    ['findings', 'left', 'Bottom', 'review'],
    ['files', 'bottom', 'Right', 'changes'],
  ] as const) {
    it(`R5.2: the ${a} area on the ${from} put on the ${to.toLowerCase()} shows there`, async () => {
      const page = await mountArranged();
      await page.mode(mode);
      if (page.where(a) !== from) page.host.layout.arrange({ kind: 'place', area: a, to: from });
      await page.refresh();
      expect(page.where(a)).toBe(from);
      await page.placeTo(a, to);
      expect(page.where(a)).toBe(to.toLowerCase());
    });
  }

  it('R5.3: putting the activity in the middle moves the tasks to the right', async () => {
    const page = await mountArranged();
    await page.mode('overview');
    await page.placeTo('activity', 'Middle');
    expect(page.where('activity')).toBe('middle');
    expect(page.where('tasks')).toBe('right');
  });

  it('R5.4: putting the tasks where the findings are stacks them, named, with the tasks on show and a step to flip', async () => {
    const page = await mountArranged();
    await page.mode('review');
    await page.click(page.inside(page.el, '[data-rail="right"] button', 'Tasks'));
    await page.placeTo('tasks', 'Left');
    expect(page.where('tasks')).toBe('left');
    expect(page.where('findings')).toBe('left');
    const tabs = Array.from(page.area('tasks').querySelectorAll<HTMLElement>('[role="tab"]'));
    expect(tabs.map((t) => page.text(t))).toEqual(['Findings 3', 'Tasks']);
    expect(page.area('tasks').querySelector('[role="tab"][aria-selected="true"]')!.textContent).toContain('Tasks');
    expect(page.inert('tasks')).toBe(false);
    expect(page.inert('findings')).toBe(true);
    await page.click(tabs[0]);
    expect(page.inert('findings')).toBe(false);
    expect(page.inert('tasks')).toBe(true);
    expect(page.area('findings').querySelector('[role="tab"][aria-selected="true"]')!.textContent).toContain('Findings');
  });

  for (const [a, mode, edge, back] of [
    ['tasks', 'watch', 'left', 'left'],
    ['activity', 'overview', 'right', 'right'],
    ['activity', 'changes', 'bottom', 'bottom'],
    ['files', 'changes', 'right', 'right'],
  ] as const) {
    it(`R5.5: tucking the ${a} in ${mode} puts its name on the ${edge} rail and one step brings it back to the ${back}`, async () => {
      const page = await mountArranged();
      await page.mode(mode);
      await page.click(page.tuckButton(a));
      expect(page.where(a)).toBe('tucked');
      expect(page.rail(edge)).toContain(NAMES[a]);
      await page.click(page.inside(page.el, `[data-rail="${edge}"] button`, NAMES[a]));
      expect(page.where(a)).toBe(back);
      expect(page.inert(a)).toBe(false);
    });
  }

  it('R6.1: the last area on show cannot be tucked; its button is disabled and says why', async () => {
    const page = await mountArranged();
    await page.mode('overview');
    await page.click(page.tuckButton('activity'));
    const button = page.tuckButton('tasks');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('title')).toBe('The page always shows at least one area.');
    const note = page.el.querySelector(`#${button.getAttribute('aria-describedby')}`)!;
    expect(page.text(note)).toBe('The page always shows at least one area.');
    button.click();
    await page.refresh();
    expect(page.where('tasks')).toBe('middle');
  });

  it('R6.2: tucking the tasks moves the activity into the middle', async () => {
    const page = await mountArranged();
    await page.mode('overview');
    await page.click(page.tuckButton('tasks'));
    expect(page.where('activity')).toBe('middle');
    expect(page.where('tasks')).toBe('tucked');
  });

  it('R7.1: focus makes the activity fill the grid, inert for the rest, and the banner says so', async () => {
    const page = await mountArranged();
    await page.mode('watch');
    await page.click(page.focusButton('activity'));
    expect(page.area('activity').style.gridArea).toBe('1 / 1 / 5 / 8');
    expect(page.inert('activity')).toBe(false);
    for (const other of ['tasks', 'files', 'findings'] as const) expect(page.inert(other)).toBe(true);
    expect(page.text(page.banner()!)).toContain('Focus: Activity fills the page.');
    expect(page.text(page.banner()!)).toContain('Back to Watch');
    expect(page.banner()!.closest('[data-bar]')).toBeNull();
  });

  it('R7.2: Back restores the same places', async () => {
    const page = await mountArranged();
    await page.mode('watch');
    const before = page.places();
    await page.click(page.focusButton('activity'));
    await page.click(page.inside(page.banner()!, 'button', 'Back to Watch'));
    expect(page.banner()).toBeNull();
    expect(page.places()).toEqual(before);
    expect(page.inert('tasks')).toBe(false);
  });

  it('R7.3: picking Changes while the activity is in focus ends the focus and shows the Changes places', async () => {
    const page = await mountArranged();
    await page.mode('watch');
    await page.click(page.focusButton('activity'));
    await page.mode('changes');
    expect(page.banner()).toBeNull();
    expect(page.places()).toEqual(DEFAULT_PLACES.changes);
    expect(page.inert('files')).toBe(false);
  });

  it('Reset layout returns the mode to its default arrangement', async () => {
    const page = await mountArranged();
    await page.mode('overview');
    await page.placeTo('activity', 'Left');
    expect(page.where('activity')).toBe('left');
    await page.click(page.inside(page.bar(), 'button', 'Reset layout'));
    expect(page.places()).toEqual(DEFAULT_PLACES.overview);
  });

  it('keeps every area in the DOM, in the same order, whatever the arrangement', async () => {
    const page = await mountArranged();
    const order = () => Array.from(page.el.querySelectorAll('.k-bp__grid > [data-area]')).map((e) => e.getAttribute('data-area'));
    expect(order()).toEqual(['tasks', 'activity', 'files', 'findings']);
    await page.mode('review');
    await page.click(page.focusButton('files'));
    expect(order()).toEqual(['tasks', 'activity', 'files', 'findings']);
  });
});

describe('the arranged build page from the keyboard', () => {
  type Page = Awaited<ReturnType<typeof mountArranged>>;
  const NAMES_OF_AREAS = ['Tasks', 'Activity', 'Changed files', 'Findings'];
  const measure = (page: Page) => {
    const grid = page.el.querySelector<HTMLElement>('.k-bp__grid')!;
    Object.defineProperty(grid, 'clientWidth', { configurable: true, value: 1280 });
    Object.defineProperty(grid, 'clientHeight', { configurable: true, value: 800 });
  };
  const separator = (page: Page, side: string) => page.el.querySelector<HTMLElement>(`[role="separator"][data-side="${side}"]`)!;
  const sizeOf = (page: Page, side: string) => Number(separator(page, side).getAttribute('aria-valuenow'));
  const current = () => document.activeElement as HTMLElement;
  /** Walk the open Place menu with the arrow keys to the item, then press Enter on it. */
  const chooseItem = async (page: Page, name: string) => {
    for (let i = 0; i < 8 && page.text(current()) !== name; i++) await page.press('ArrowDown');
    expect(page.text(current())).toBe(name);
    await page.press('Enter');
  };

  it('R13.1: switches to each of the four modes', async () => {
    const page = await mountArranged();
    for (const [key, m] of [['1', 'overview'], ['2', 'watch'], ['3', 'changes'], ['4', 'review']] as const) {
      const down = await page.press(key, { ctrl: true });
      expect(down.defaultPrevented, `Ctrl+${key} is the page's`).toBe(true);
      expect(page.places(), m).toEqual(DEFAULT_PLACES[m]);
    }
  });

  it('R13.1: the switcher says each shortcut in its titles', async () => {
    const page = await mountArranged();
    const titles = Array.from(page.switcher().querySelectorAll('button')).map((b) => b.getAttribute('title'));
    expect(titles).toEqual(['Overview (Ctrl+1)', 'Watch (Ctrl+2)', 'Changes (Ctrl+3)', 'Review (Ctrl+4)']);
  });

  it('R13.1: a key that is not the page\'s is left alone, Esc included while nothing is in focus', async () => {
    const page = await mountArranged();
    await page.mode('overview');
    expect((await page.press('1', { ctrl: true, shift: true })).defaultPrevented).toBe(false);
    expect((await page.press('5', { ctrl: true })).defaultPrevented).toBe(false);
    expect((await page.press('Escape')).defaultPrevented).toBe(false);
    expect(page.places()).toEqual(DEFAULT_PLACES.overview);
    expect(page.host.arranges).toEqual([]);
  });

  it('R13.1: makes an area larger and smaller: the left separator', async () => {
    const page = await mountArranged();
    await page.mode('watch');
    measure(page);
    page.tabTo(separator(page, 'left'));
    expect(sizeOf(page, 'left')).toBe(300);
    const steps: [string, { shift?: boolean }, number][] = [
      ['ArrowRight', {}, 316],
      ['ArrowLeft', {}, 300],
      ['ArrowRight', { shift: true }, 364],
      ['ArrowLeft', { shift: true }, 300],
      ['Home', {}, 160],
      ['End', {}, 1039],
    ];
    for (const [key, mods, size] of steps) {
      const before = page.host.arranges.length;
      await page.press(key, mods);
      expect(sizeOf(page, 'left'), `${mods.shift ? 'Shift+' : ''}${key}`).toBe(size);
      expect(page.host.arranges.length - before, 'one resize a press').toBe(1);
      expect(page.host.arranges[page.host.arranges.length - 1]).toEqual({ kind: 'resize', side: 'left', px: size });
    }
    const before = page.host.arranges.length;
    await page.press('ArrowRight');
    expect(page.host.arranges.length, 'at the largest there is nothing to emit').toBe(before);
    expect(current()).toBe(separator(page, 'left'));
  });

  it('F3: the largest the left separator goes leaves the middle its minimum once the drawn rail and separator are taken off', async () => {
    const page = await mountArranged();
    await page.mode('review');
    measure(page);
    // jsdom lays nothing out, so the right rail (the tucked tasks and activity) is given the 28 px a browser draws.
    const rail = page.el.querySelector<HTMLElement>('[data-rail="right"]')!;
    Object.defineProperty(rail, 'offsetWidth', { configurable: true, value: 28 });
    page.tabTo(separator(page, 'left'));
    await page.press('End');
    // 1280 less the rail and the 1 px separator, less the middle's 240.
    expect(page.host.arranges[page.host.arranges.length - 1]).toEqual({ kind: 'resize', side: 'left', px: 1011 });
    expect(sizeOf(page, 'left')).toBe(1011);
  });

  it('R13.1: makes an area larger and smaller: the right separator moves left to grow', async () => {
    const page = await mountArranged();
    await page.mode('overview');
    measure(page);
    page.tabTo(separator(page, 'right'));
    const start = sizeOf(page, 'right');
    await page.press('ArrowLeft');
    expect(sizeOf(page, 'right')).toBe(start + 16);
    await page.press('ArrowRight', { shift: true });
    expect(sizeOf(page, 'right')).toBe(Math.max(160, start + 16 - 64));
    await page.press('Home');
    expect(sizeOf(page, 'right')).toBe(160);
    await page.press('End');
    expect(sizeOf(page, 'right')).toBe(1039);
    expect(page.host.arranges.every((a) => a.kind === 'resize' && a.side === 'right')).toBe(true);
  });

  it('R13.1: makes an area larger and smaller: the bottom separator grows upward', async () => {
    const page = await mountArranged();
    await page.mode('changes');
    measure(page);
    page.tabTo(separator(page, 'bottom'));
    expect(separator(page, 'bottom').getAttribute('aria-orientation')).toBe('horizontal');
    const start = sizeOf(page, 'bottom');
    await page.press('ArrowUp');
    expect(sizeOf(page, 'bottom')).toBe(start + 16);
    await page.press('ArrowDown', { shift: true });
    expect(sizeOf(page, 'bottom')).toBe(Math.max(160, start + 16 - 64));
    const kept = sizeOf(page, 'bottom');
    await page.press('ArrowLeft');
    expect(sizeOf(page, 'bottom'), 'a horizontal key does nothing to the bottom').toBe(kept);
    await page.press('Home');
    expect(sizeOf(page, 'bottom')).toBe(160);
    await page.press('End');
    expect(sizeOf(page, 'bottom')).toBe(519);
  });

  for (const [a, from, to, mode] of [
    ['activity', 'right', 'Left', 'overview'],
    ['activity', 'right', 'Bottom', 'overview'],
    ['tasks', 'left', 'Right', 'watch'],
    ['files', 'bottom', 'Right', 'changes'],
    ['activity', 'right', 'Middle', 'overview'],
  ] as const) {
    it(`R13.1: puts the ${a} area from the ${from} to the ${to.toLowerCase()} through its Place menu`, async () => {
      const page = await mountArranged();
      await page.mode(mode);
      if (page.where(a) !== from) page.host.layout.arrange({ kind: 'place', area: a, to: from });
      await page.refresh();
      expect(page.where(a)).toBe(from);
      page.tabTo(page.trigger(a));
      await page.press('Enter');
      expect(page.menuItems().map((i) => page.text(i))).toEqual(['Left', 'Middle', 'Right', 'Bottom', 'Tuck away', 'Focus']);
      await chooseItem(page, to);
      expect(page.where(a)).toBe(to.toLowerCase());
      expect(page.menuItems()).toEqual([]);
    });
  }

  it('R13.1: the middle takes the area and sends the one there to the side, as with the mouse', async () => {
    const page = await mountArranged();
    await page.mode('overview');
    page.tabTo(page.trigger('activity'));
    await page.press('Enter');
    await chooseItem(page, 'Middle');
    expect(page.where('activity')).toBe('middle');
    expect(page.where('tasks')).toBe('right');
  });

  it('R13.1: tucks an area away with its button, and through its Place menu', async () => {
    const page = await mountArranged();
    await page.mode('overview');
    page.tabTo(page.tuckButton('activity'));
    await page.press('Enter');
    expect(page.where('activity')).toBe('tucked');
    expect(page.rail('right')).toContain('Activity');
    await page.mode('watch');
    page.tabTo(page.trigger('tasks'));
    await page.press('Enter');
    await chooseItem(page, 'Tuck away');
    expect(page.where('tasks')).toBe('tucked');
    expect(page.rail('left')).toContain('Tasks');
  });

  it('R13.1: the last area on show offers no tuck, in its button or its menu', async () => {
    const page = await mountArranged();
    await page.mode('overview');
    await page.click(page.tuckButton('activity'));
    expect(page.tuckButton('tasks').disabled).toBe(true);
    await page.click(page.trigger('tasks'));
    const tuck = page.menuItems().find((i) => page.text(i) === 'Tuck away')!;
    expect(tuck.hasAttribute('data-disabled')).toBe(true);
  });

  it('R13.1: brings a tucked area back from its name on the rail', async () => {
    const page = await mountArranged();
    await page.mode('changes');
    await page.click(page.tuckButton('activity'));
    page.tabTo(page.inside(page.el, '[data-rail="bottom"] button', 'Bring back Activity'));
    await page.press('Enter');
    expect(page.where('activity')).toBe('bottom');
    expect(page.inert('activity')).toBe(false);
    page.tabTo(page.inside(page.el, '[data-rail="right"] button', 'Bring back Findings'));
    await page.press(' ');
    expect(page.where('findings')).toBe('right');
  });

  it('R13.1: flips between the areas of a stack with the arrow keys, the focus following', async () => {
    const page = await mountArranged();
    await page.mode('review');
    page.host.layout.arrange({ kind: 'bring-back', area: 'tasks' });
    page.host.layout.arrange({ kind: 'place', area: 'tasks', to: 'left' });
    await page.refresh();
    const tablist = page.area('tasks').querySelector<HTMLElement>('[role="tablist"]')!;
    expect(tablist).not.toBeNull();
    const selected = (a: AreaId) => page.area(a).querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')!;
    const others = Array.from(tablist.querySelectorAll<HTMLElement>('[role="tab"][aria-selected="false"]'));
    expect(others.map((t) => t.tabIndex), 'only the selected tab is in the tab order').toEqual([-1]);
    page.tabTo(selected('tasks'));
    await page.press('ArrowLeft');
    expect(page.inert('findings')).toBe(false);
    expect(page.inert('tasks')).toBe(true);
    expect(current()).toBe(selected('findings'));
    expect(page.text(selected('findings'))).toContain('Findings');
    await page.press('ArrowRight');
    expect(page.inert('tasks')).toBe(false);
    expect(current()).toBe(selected('tasks'));
    await page.press('Home');
    expect(page.inert('findings')).toBe(false);
    expect(current()).toBe(selected('findings'));
    await page.press('End');
    expect(page.inert('tasks')).toBe(false);
    expect(current()).toBe(selected('tasks'));
  });

  it('R13.1: puts an area in focus with its button', async () => {
    const page = await mountArranged();
    await page.mode('watch');
    page.tabTo(page.focusButton('activity'));
    await page.press('Enter');
    expect(page.area('activity').style.gridArea).toBe('1 / 1 / 5 / 8');
    for (const other of ['tasks', 'files', 'findings'] as const) expect(page.inert(other)).toBe(true);
    expect(page.text(page.banner()!)).toContain('Focus: Activity fills the page.');
  });

  it('R13.1: puts an area in focus through its Place menu', async () => {
    const page = await mountArranged();
    await page.mode('watch');
    page.tabTo(page.trigger('tasks'));
    await page.press('Enter');
    await chooseItem(page, 'Focus');
    expect(page.text(page.banner()!)).toContain('Focus: Tasks fills the page.');
  });

  it('R13.1: returns from focus with Esc, and with Back', async () => {
    const page = await mountArranged();
    await page.mode('watch');
    const before = page.places();
    await page.click(page.focusButton('activity'));
    expect(page.banner()).not.toBeNull();
    await page.press('Escape');
    expect(page.banner()).toBeNull();
    expect(page.places()).toEqual(before);
    expect(page.inert('tasks')).toBe(false);
    await page.click(page.focusButton('tasks'));
    page.tabTo(page.inside(page.banner()!, 'button', 'Back to Watch'));
    await page.press('Enter');
    expect(page.banner()).toBeNull();
    expect(page.places()).toEqual(before);
  });

  it('R13.1: resets the current mode with Reset layout', async () => {
    const page = await mountArranged();
    await page.mode('overview');
    await page.placeTo('activity', 'Left');
    expect(page.where('activity')).toBe('left');
    page.tabTo(page.inside(page.bar(), 'button', 'Reset layout'));
    await page.press('Enter');
    expect(page.places()).toEqual(DEFAULT_PLACES.overview);
  });

  it('R13.1: goes to a waiting question with the Go to of the waiting notice', async () => {
    const v = base({
      groups: [group('claims-core', RUNNING, 'cancel', [task('T1', RUNNING)], true), group('customer-portal', RUNNING, 'cancel', [task('T2', RUNNING)])],
      pick: { kind: 'repo', repo: 'claims-core' },
      sessions: [session('r1')],
      waiting: [{ repo: 'customer-portal', kind: 'answer', countdown: null, waited: '0:05' }],
    });
    const { el, host, button, fixture } = await mount(v);
    const goTo = button(el.querySelector<HTMLElement>('app-waiting-notice')!, 'Go to customer-portal')!;
    expect(goTo.disabled).toBe(false);
    expect(goTo.tabIndex).toBeGreaterThanOrEqual(0);
    goTo.focus();
    expect(document.activeElement).toBe(goTo);
    const down = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    goTo.dispatchEvent(down);
    if (!down.defaultPrevented) goTo.click();
    fixture.detectChanges();
    expect(host.goTos).toEqual(['customer-portal']);
  });

  it('R13.2: each area is a section named for it, and each rail button and tab carries the name', async () => {
    const page = await mountArranged();
    const sections = Array.from(page.el.querySelectorAll<HTMLElement>('.k-bp__grid > section[data-area]'));
    expect(sections.map((s) => s.getAttribute('aria-label'))).toEqual(NAMES_OF_AREAS);
    const bringBack = new Set<string>();
    for (const m of ['overview', 'changes', 'review'] as const) {
      await page.mode(m);
      for (const b of Array.from(page.el.querySelectorAll<HTMLElement>('[data-rail] button'))) bringBack.add(b.getAttribute('aria-label')!);
    }
    expect(Array.from(bringBack).sort()).toEqual(['Bring back Activity', 'Bring back Changed files', 'Bring back Findings', 'Bring back Tasks']);
    // A stack holds at most three areas, so the four names show in two stacks: the findings with the tasks and the activity, then the changed files in their place.
    await page.mode('review');
    const tabNames = () => Array.from(page.area('findings').parentElement!.querySelectorAll<HTMLElement>('[role="tablist"]')).flatMap((l) => Array.from(l.querySelectorAll<HTMLElement>('[role="tab"]')).map((t) => page.text(t)));
    for (const a of ['tasks', 'activity'] as const) page.host.layout.arrange({ kind: 'bring-back', area: a });
    page.host.layout.arrange({ kind: 'place', area: 'tasks', to: 'left' });
    page.host.layout.arrange({ kind: 'place', area: 'activity', to: 'left' });
    await page.refresh();
    const first = tabNames();
    page.host.layout.arrange({ kind: 'place', area: 'files', to: 'left' });
    await page.refresh();
    const names = new Set([...first, ...tabNames()].map((t) => NAMES_OF_AREAS.find((n) => t.startsWith(n))));
    expect(Array.from(names).sort()).toEqual([...NAMES_OF_AREAS].sort());
  });

  it('R13.3: a mode picked by hand is announced', async () => {
    const page = await mountArranged();
    expect(page.live()).toBe('');
    await page.press('2', { ctrl: true });
    expect(page.live()).toBe('Layout: Watch.');
    await page.press('4', { ctrl: true });
    expect(page.live()).toBe('Layout: Review.');
  });

  it('R13.3: a move the stage drives is announced', async () => {
    const page = await mountArranged('started');
    expect(page.places()).toEqual(DEFAULT_PLACES.overview);
    expect(page.live()).toBe('');
    page.standIn.layoutStage.set('running');
    await page.refresh();
    expect(page.places()).toEqual(DEFAULT_PLACES.watch);
    expect(page.live()).toBe('Layout: Watch.');
  });

  it('R13.3: an area going into focus and out of it is announced', async () => {
    const page = await mountArranged();
    await page.mode('watch');
    await page.click(page.focusButton('activity'));
    expect(page.live()).toBe('Focus: Activity fills the page.');
    await page.press('Escape');
    expect(page.live()).toBe('Layout: Watch.');
  });
});

describe('picking a finding in the findings area', () => {
  const PICKABLE: Finding[] = [
    { severity: 'high', text: 'The limit is not enforced on retry.', file: 'src/a.ts', line: 4 },
    { severity: null, text: 'The refusal message has no test.' },
  ];
  const withFindings = (host: ArrangedHost) => {
    host.view = { ...host.view, findingsArea: { ...SHOWN, review: { ...FINDINGS, findings: PICKABLE } } };
  };
  const showAt = (page: Awaited<ReturnType<typeof mountArranged>>) => page.fixture.debugElement.query(By.directive(ChangesView)).componentInstance.showAt();

  it('R4.2: in Review with the changed files moved right and then tucked, it brings them back to the right and shows the line', async () => {
    const page = await mountArranged();
    withFindings(page.host);
    await page.mode('review');
    await page.placeTo('files', 'Right');
    await page.click(page.tuckButton('files'));
    expect(page.where('files')).toBe('tucked');
    await page.click(page.inside(page.area('findings'), 'button', 'src/a.ts:4'));
    expect(page.where('files')).toBe('right');
    expect(page.inert('files')).toBe(false);
    expect(showAt(page)).toEqual({ file: 'src/a.ts', line: 4, text: PICKABLE[0].text, n: 1 });
  });

  it('R4.2 and R5.5: the same with the changed files tucked from the middle brings them back to the right', async () => {
    const page = await mountArranged();
    withFindings(page.host);
    await page.mode('review');
    await page.click(page.tuckButton('files'));
    expect(page.where('files')).toBe('tucked');
    await page.click(page.inside(page.area('findings'), 'button', 'src/a.ts:4'));
    expect(page.where('files')).toBe('right');
    expect(showAt(page)).toMatchObject({ file: 'src/a.ts', line: 4 });
  });

  it('a finding that names no file says so and picks nothing', async () => {
    const page = await mountArranged();
    withFindings(page.host);
    await page.mode('review');
    const items = Array.from(page.area('findings').querySelectorAll('li'));
    expect(page.text(items[1])).toContain('This finding names no file.');
    expect(items[1].querySelector('button')).toBeNull();
    expect(showAt(page)).toBeNull();
  });
});

describe('a waiting question on the arranged page', () => {
  const asking = {
    id: 'q1',
    questions: [{ kind: 'text' as const, header: 'scope', question: 'Fix or isolate?', optional: false }],
    answers: null,
    at: 0,
  };
  const WAIT = [{ repo: 'customer-portal', kind: 'answer' as const, countdown: '4:00', waited: '0:05' }];
  const FIRST_CONTROL = 'button:not([disabled]), input, textarea, select, [tabindex="0"]';

  async function waitingPage(stage: LayoutStage = 'running') {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value() {} });
    onTestFinished(() => void delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView);
    const page = await mountArranged(stage);
    await page.mode('watch');
    page.host.sessionOf = { 'claims-core': 'mine', 'customer-portal': 'asking' };
    page.host.view = {
      ...page.host.view,
      sessions: [session('mine', { shown: true }), session('asking', { state: 'awaiting', asks: [asking], shown: false })],
      waiting: WAIT,
    };
    page.host.choose({ kind: 'repo', repo: 'claims-core' });
    page.fixture.debugElement.injector.get(ChangeDetectorRef).markForCheck();
    await page.refresh();
    const goTo = () => page.inside(page.el.querySelector<HTMLElement>('app-waiting-notice')!, 'button', 'Go to customer-portal');
    const current = () => page.host.layout.view().mode;
    const pickedRepo = () => page.el.querySelector('[data-area="tasks"] [data-heading] button[aria-current="true"]')?.textContent?.trim();
    const card = () => page.area('activity').querySelector<HTMLElement>('[data-session="asking"] .k-ask')!;
    return { ...page, goTo, current, pickedRepo, card };
  }

  /** The middle always holds an area, so the changed files take it, and the activity joins the tasks on the left. */
  const stackBehindTasks = async (page: Awaited<ReturnType<typeof waitingPage>>) => {
    await page.click(page.inside(page.el, '[data-rail] button', 'Changed files'));
    await page.placeTo('files', 'Middle');
    await page.placeTo('activity', 'Left');
  };

  const noticeNames = (page: Awaited<ReturnType<typeof waitingPage>>) => {
    const notice = page.text(page.el.querySelector('app-waiting-notice')!);
    expect(notice).toContain('customer-portal');
    expect(notice).toContain('waiting for your answer');
    expect(notice).toContain('4:00');
  };

  it('R11.1: on show in Watch, the activity header carries the waiting mark and no other area does', async () => {
    const page = await waitingPage();
    noticeNames(page);
    expect(page.where('activity')).toBe('middle');
    expect(page.text(page.area('activity').querySelector('header')!)).toContain('Activity waiting');
    for (const a of ['tasks', 'files', 'findings'] as const) expect(page.area(a).querySelector('[data-waiting-mark]'), a).toBeNull();
  });

  it('R11.1: tucked in Review, its rail button is named with the wait', async () => {
    const page = await waitingPage();
    await page.mode('review');
    expect(page.where('activity')).toBe('tucked');
    noticeNames(page);
    const rail = page.inside(page.el, '[data-rail] button', 'Bring back Activity, waiting');
    expect(rail).toBeDefined();
    expect(rail.querySelector('[data-waiting-mark]')).not.toBeNull();
  });

  it('R11.1: stacked behind the tasks, its stack tab carries the mark', async () => {
    const page = await waitingPage();
    await stackBehindTasks(page);
    expect(page.where('activity')).toBe('left');
    expect(page.where('tasks')).toBe('left');
    const tabs = Array.from(page.area('tasks').querySelectorAll<HTMLElement>('[role="tab"]'));
    const tab = tabs.find((t) => page.text(t).startsWith('Activity'))!;
    expect(page.text(tab)).toBe('Activity waiting');
    expect(tab.querySelector('[data-waiting-mark]')).not.toBeNull();
    expect(page.text(tabs.find((t) => page.text(t).startsWith('Tasks'))!)).toBe('Tasks');
    noticeNames(page);
  });

  it('R11.1: while the changed files are in focus, the notice names the wait and the activity keeps its mark', async () => {
    const page = await waitingPage();
    await page.mode('changes');
    await page.click(page.focusButton('files'));
    expect(page.banner()).not.toBeNull();
    noticeNames(page);
    expect(page.text(page.area('activity').querySelector('header')!)).toContain('Activity waiting');
  });

  it('R11.2: with the activity on show, Go to switches it to the asking repository and focuses its question', async () => {
    const page = await waitingPage();
    const before = page.current();
    expect(page.pickedRepo()).toBe('claims-core');
    await page.click(page.goTo());
    expect(page.where('activity')).toBe('middle');
    expect(page.inert('activity')).toBe(false);
    expect(page.pickedRepo()).toBe('customer-portal');
    expect(page.card().querySelector(FIRST_CONTROL)).toBe(document.activeElement);
    expect(page.current()).toBe(before);
  });

  it('R11.2: with the activity tucked away, Go to brings it back to where it was tucked from', async () => {
    const page = await waitingPage();
    await page.placeTo('activity', 'Right');
    await page.click(page.tuckButton('activity'));
    expect(page.where('activity')).toBe('tucked');
    await page.click(page.goTo());
    expect(page.where('activity')).toBe('right');
    expect(page.inert('activity')).toBe(false);
    expect(page.pickedRepo()).toBe('customer-portal');
    expect(page.card().querySelector(FIRST_CONTROL)).toBe(document.activeElement);
    expect(page.current()).toBe('watch');
  });

  it('R11.2: with the activity stacked behind the tasks, Go to flips the stack to it', async () => {
    const page = await waitingPage();
    await stackBehindTasks(page);
    await page.click(page.inside(page.area('tasks'), '[role="tab"]', 'Tasks'));
    expect(page.inert('activity')).toBe(true);
    await page.click(page.goTo());
    expect(page.where('activity')).toBe('left');
    expect(page.inert('activity')).toBe(false);
    expect(page.inert('tasks')).toBe(true);
    expect(page.pickedRepo()).toBe('customer-portal');
    expect(page.card().querySelector(FIRST_CONTROL)).toBe(document.activeElement);
    expect(page.current()).toBe('watch');
  });

  it('R11.2: with the changed files in focus, Go to ends the focus and brings the activity into view', async () => {
    const page = await waitingPage();
    await page.mode('changes');
    await page.click(page.focusButton('files'));
    expect(page.inert('activity')).toBe(true);
    await page.click(page.goTo());
    expect(page.banner()).toBeNull();
    expect(page.inert('activity')).toBe(false);
    expect(page.pickedRepo()).toBe('customer-portal');
    expect(page.card().querySelector(FIRST_CONTROL)).toBe(document.activeElement);
    expect(page.current()).toBe('changes');
  });

  it('R11.2: with the activity in focus, Go to keeps it in focus and switches repository', async () => {
    const page = await waitingPage();
    await page.click(page.focusButton('activity'));
    expect(page.banner()).not.toBeNull();
    await page.click(page.goTo());
    expect(page.banner()).not.toBeNull();
    expect(page.host.layout.view().focus).toBe('activity');
    expect(page.inert('activity')).toBe(false);
    expect(page.pickedRepo()).toBe('customer-portal');
    expect(page.card().querySelector(FIRST_CONTROL)).toBe(document.activeElement);
    expect(page.current()).toBe('watch');
  });
});
