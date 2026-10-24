import { onTestFinished } from 'vitest';
import { Component, inject, input, signal } from '@angular/core';
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
  narrow: false,
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
      waiting: [{ repo: 'customer-portal', kind: 'answer', countdown: null }],
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
      waiting: [{ repo: 'customer-portal', kind: 'answer', countdown: null }],
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

  it('the waiting notice shows while the changed files are in view', async () => {
    const v = base({
      narrow: true,
      groups: [group('claims-core', RUNNING, 'cancel', [task('T1', RUNNING)], true)],
      pick: { kind: 'repo', repo: 'claims-core' },
      sessions: [session('r1')],
      waiting: [{ repo: 'claims-core', kind: 'approval', countdown: '4:00' }],
    });
    const { el, area, fixture, button } = await mount(v);
    button(el, 'Files')!.click();
    await settle();
    fixture.detectChanges();
    expect(area('files')!.hidden).toBe(false);
    expect(area('tasks')!.hidden).toBe(true);
    expect(area('activity')!.hidden).toBe(true);
    const notice = el.querySelector<HTMLElement>('app-waiting-notice')!;
    expect(notice.closest('[hidden]')).toBeNull();
    expect(norm(notice.textContent)).toContain('claims-core');
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

  it('keeps every area reachable below 1024 pixels: a three-way switch, the panels not on show hidden and not removed', async () => {
    const v = base({
      narrow: true,
      pick: { kind: 'repo', repo: 'claims-core' },
      groups: [group('claims-core', RUNNING, 'cancel', [task('T1', RUNNING)], true)],
      sessions: [session('r1')],
    });
    const { el, area, button, fixture } = await mount(v);
    const names = Array.from(el.querySelectorAll('.k-bp__switch button')).map((b) => norm(b.textContent));
    expect(names).toEqual(['Tasks', 'Activity', 'Files']);
    expect(area('activity')!.hidden).toBe(false);
    expect(area('tasks')!.hidden).toBe(true);
    expect(area('files')!.hidden).toBe(true);
    expect(area('activity')!.querySelector('app-observe-pane')).not.toBeNull();
    button(el, 'Tasks')!.click();
    await settle();
    fixture.detectChanges();
    expect(area('tasks')!.hidden).toBe(false);
    expect(area('activity')!.hidden).toBe(true);
    expect(area('activity')!.querySelector('app-observe-pane')).not.toBeNull();
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

@Component({
  imports: [BuildPage],
  providers: [BuildLayoutViewModel],
  template: `
    <app-build-page
      [view]="view"
      [layout]="layout.view()"
      [context]="context"
      [turns]="0"
      [rows]="rows"
      [task]="task"
      [stopped]="[]"
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
  readonly layout = inject(BuildLayoutViewModel);
  readonly context = CHANGES;
  readonly rows: BuildRow[] = [];
  readonly arranges: ArrangeAction[] = [];
  task: { id: string; repo: string } | null = null;
  view: BuildPageView = base({
    groups: [
      group('claims-core', RUNNING, 'cancel', [task('T1', DONE), task('T2', RUNNING)]),
      group('customer-portal', RUNNING, 'cancel', [task('T3', RUNNING)]),
    ],
    sessions: [session('r1')],
    findingsArea: SHOWN,
  });

  /** Set the place the way the build page's view model does. */
  showFinding(f: Finding): void {
    this.view = { ...this.view, findingPlace: { file: f.file!, line: f.line ?? null, text: f.text, n: ++this.placed } };
  }

  arranged(action: ArrangeAction): void {
    this.arranges.push(action);
    this.layout.arrange(action);
  }

  /** Mark the pick the way the build page's view model does. The changed files are not narrowed to the task, so the list stays whole. */
  choose(pick: Pick): void {
    const repoOf = (id: string) => this.view.groups.find((g) => g.tasks.some((t) => t.id === id))?.repo;
    const repo = pick.kind === 'repo' ? pick.repo : pick.kind === 'task' ? repoOf(pick.task) : undefined;
    this.view = {
      ...this.view,
      pick,
      groups: this.view.groups.map((g) => ({ ...g, picked: g.repo === repo, tasks: g.tasks.map((t) => ({ ...t, picked: pick.kind === 'task' && pick.task === t.id })) })),
    };
  }
}

async function mountArranged(stage: LayoutStage = 'running') {
  const standIn = layoutStandIn(stage);
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
  const placeTo = async (a: AreaId, to: string) => {
    const item = Array.from(area(a).querySelectorAll<HTMLElement>('[role="menuitem"]')).find((b) => text(b) === to)!;
    await click(item);
  };
  const inert = (a: AreaId) => area(a).hasAttribute('inert');
  const banner = () => el.querySelector<HTMLElement>('[data-focus-banner]');
  return { fixture, host, standIn, el, area, where, places, text, inside, click, bar, switcher, mode, rail, tuckButton, focusButton, placeTo, inert, banner, refresh };
}

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
