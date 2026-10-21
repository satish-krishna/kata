import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { Stage } from '@bindings/Stage';
import { HlmTabsImports } from '@spartan-ng/helm/tabs';
import type { DocsPresent } from '../lib/sdlc';
import { StageStepper, type BuildTile } from './stage-stepper';

const COUNTS = { intent: 2, spec: 1, plan: 0, build: 0, review: 0 };
const ALL_DOCS: DocsPresent = { intent: true, spec: true, plan: true };
const ALL: Stage[] = [
  'intent-in-progress', 'intent-awaiting', 'intent-accepted-uncommitted', 'rejected', 'spec-ready',
  'spec-awaiting', 'spec-accepted-uncommitted', 'plan-ready', 'plan-awaiting', 'plan-accepted-uncommitted', 'plan-out-of-date', 'plan-superseded', 'build-ready', 'build-stopped', 'build-finished',
];
const text = (c: HTMLElement) => c.textContent!.replace(/\s+/g, ' ');

/* The tiles are tab triggers, so they need the tabs root the change page puts around them. */
@Component({
  imports: [StageStepper, HlmTabsImports],
  template: `
    <div hlmTabs variant="bare" [tab]="tab()" (tabActivated)="tab.set($event)">
      <app-stage-stepper [stage]="stage()" [counts]="counts()" [docs]="docs()" [build]="build()" />
    </div>
  `,
})
class Host {
  readonly tab = signal('spec');
  readonly stage = signal<Stage>('spec-awaiting');
  readonly docs = signal<DocsPresent>(ALL_DOCS);
  readonly counts = signal(COUNTS);
  readonly build = signal<BuildTile>({ hasBranch: false, done: 0, total: 0, repos: 0 });
}

async function mount(over: { stage?: Stage; docs?: DocsPresent; tab?: string; build?: BuildTile; counts?: typeof COUNTS } = {}) {
  TestBed.configureTestingModule({ imports: [Host] });
  const fixture = TestBed.createComponent(Host);
  const host = fixture.componentInstance;
  if (over.build) host.build.set(over.build);
  if (over.counts) host.counts.set(over.counts);
  if (over.stage) host.stage.set(over.stage);
  if (over.docs) host.docs.set(over.docs);
  if (over.tab) host.tab.set(over.tab);
  await fixture.whenStable();
  const container = fixture.nativeElement as HTMLElement;
  const tabs = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  return { fixture, host, container, tabs };
}

describe('StageStepper', () => {
  it.each(ALL)('marks exactly one step as current for %s', async (stage) => {
    const { container, tabs } = await mount({ stage });
    expect(container.querySelectorAll('[aria-current="step"]').length).toBe(1);
    expect(tabs().length).toBe(4);
  });

  it('labels the current step from the stage and the others by position, each with a status dot', async () => {
    const { container, tabs } = await mount();
    const steps = tabs();
    expect(steps.map((s) => s.querySelector('.k-step__name')!.textContent!.trim())).toEqual(['Intent', 'Spec', 'Plan', 'Build']);
    expect(steps[0].textContent).toContain('Accepted');
    expect(steps[1].getAttribute('aria-current')).toBe('step');
    expect(steps[1].textContent).toContain('Spec · awaiting acceptance');
    expect(steps[2].textContent).toContain('Not started');
    expect(container.querySelectorAll('.k-status__dot').length).toBe(4);
  });

  it('shows a rejected change as closed on the intent step', async () => {
    const { tabs } = await mount({ stage: 'rejected', tab: 'intent' });
    expect(tabs()[0].getAttribute('aria-current')).toBe('step');
    expect(tabs()[0].textContent).toContain('Closed · rejected');
  });

  it('shows the run count per step', async () => {
    const { container } = await mount({ stage: 'plan-ready' });
    const t = text(container);
    expect(t).toContain('2 runs');
    expect(t).toContain('1 run');
    expect(t).toContain('No runs');
  });

  it('is a tab list whose tiles select a document, with a tile disabled while its document does not exist', async () => {
    const { container, host, tabs, fixture } = await mount({ docs: { intent: true, spec: true, plan: false } });
    expect(container.querySelector('[role="tablist"]')!.getAttribute('aria-label')).toBe('Stage documents');
    expect(tabs().map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false', 'false']);
    expect(tabs()[2].disabled).toBe(true);
    tabs()[0].click();
    await fixture.whenStable();
    expect(host.tab()).toBe('intent');
    expect(tabs()[0].getAttribute('aria-selected')).toBe('true');
  });

  it('build tile is locked until the plan is accepted', async () => {
    const { tabs } = await mount({ stage: 'plan-awaiting', build: { hasBranch: true, done: 0, total: 3, repos: 2 } });
    const build = tabs()[3];
    expect(build.disabled).toBe(true);
    expect(build.querySelector('.k-step__name')!.textContent!.trim()).toBe('Build');
    expect(build.textContent!.replace(/\s+/g, ' ')).toContain('Build · locked until the plan is accepted');
  });

  it('keeps the build tile disabled after acceptance until a repository has the change branch', async () => {
    const { tabs } = await mount({ stage: 'build-ready' });
    expect(tabs()[3].disabled).toBe(true);
    expect(tabs()[3].textContent).toContain('Build · ready to start');
    expect(tabs()[3].textContent).toContain('no runs yet');
    expect(tabs()[3].getAttribute('aria-current')).toBe('step');
    expect(tabs()[2].getAttribute('aria-current')).toBeNull();
  });

  it('enables the build tile once a repository has the change branch and counts tasks and repositories', async () => {
    const { tabs } = await mount({
      stage: 'build-stopped',
      build: { hasBranch: true, done: 1, total: 3, repos: 2 },
      counts: { ...COUNTS, build: 2 },
    });
    expect(tabs()[3].disabled).toBe(false);
    expect(tabs()[3].textContent).toContain('Build · in progress (stopped)');
    expect(tabs()[3].textContent).toContain('1/3 tasks · 2 repositories');
  });
});
