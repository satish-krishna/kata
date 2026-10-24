import { onTestFinished } from 'vitest';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { BuildRow } from '@bindings/BuildRow';
import type { Pick } from '../../lib/build-sessions';
import type { BuildStage } from '../../lib/build-stage';
import { stopMessage, type Finding, type StageAction } from '../../lib/sdlc';
import { MOCK_BUILD_CHANGE, MOCK_MASTER, MOCK_WORKSPACE_FOLDER } from '../../lib/sdlc-mock';
import { KataTransport } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import { monaco } from '../../ui/diff-editor/monaco.loader';
import { BuildPage } from './build-page';
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
  findings: null,
  waiting: [],
  announcement: '',
  areas: { activity: true, files: true },
  narrow: false,
  ...over,
});

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

@Component({
  imports: [BuildPage],
  template: `
    <app-build-page
      [view]="view"
      [context]="context"
      [turns]="0"
      [rows]="rows"
      [task]="task"
      [stopped]="stopped"
      [focus]="focus"
      (pick)="picks.push($event)"
      (repoAction)="repoActions.push($event)"
      (act)="acts.push($event)"
      (answer)="answers.push($event)"
      (goTo)="goTos.push($event)"
      (toggleRun)="toggles.push($event)"
    />
  `,
})
class Host {
  view: BuildPageView = base();
  task: { id: string; repo: string } | null = null;
  stopped: string[] = [];
  focus: { repo: string; n: number } | null = null;
  readonly context = CHANGES;
  readonly rows: BuildRow[] = [];
  readonly picks: Pick[] = [];
  readonly repoActions: { repo: string; action: 'cancel' | 'continue' }[] = [];
  readonly acts: StageAction[] = [];
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
  const barActions = () => buttons(bar()).map((b) => norm(b.textContent)).filter((t) => !t.includes('tasks'));
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
    expect(area('activity')).toBeNull();
    expect(area('files')).toBeNull();
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
      findings: FINDINGS,
      stageMessage: { title: 'Every task is in the build log.', lines: [] },
    });
    const { area, barActions } = await mount(v);
    expect(area('activity')!.querySelector('app-findings-list')).not.toBeNull();
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
      findings: FINDINGS,
    });
    const { area, barActions, bar } = await mount(v);
    expect(area('activity')!.querySelector('app-findings-list')).not.toBeNull();
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
    fixture.componentInstance.focus = { repo: 'customer-portal', n: 1 };
    fixture.detectChanges();
    await settle();
    const card = el.querySelector<HTMLElement>('[data-session="open"] .k-ask')!;
    expect(card).not.toBeNull();
    expect(scrolled).toEqual([card]);
    expect(card.contains(document.activeElement)).toBe(true);
    // A second Go to to the same repository asks again.
    (document.activeElement as HTMLElement).blur();
    fixture.componentInstance.focus = { repo: 'customer-portal', n: 2 };
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
      findings: FINDINGS,
      stageMessage: { title: 'Every task is in the build log.', lines: [] },
    });
    const { area } = await mount(v);
    const items = Array.from(area('activity')!.querySelectorAll('app-findings-list li .k-findings__text')).map((e) => norm(e.textContent));
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
    expect(host.acts).toEqual(['cancel-build']);
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
