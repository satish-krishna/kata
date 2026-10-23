import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { Stage } from '@bindings/Stage';
import { HlmTabsImports } from '@spartan-ng/helm/tabs';
import { stagePills, type DocsPresent } from '../lib/sdlc';
import { StagePills } from './stage-pills';

const ALL_DOCS: DocsPresent = { intent: true, spec: true, plan: true };
const ALL: Stage[] = [
  'intent-in-progress', 'intent-awaiting', 'intent-accepted-uncommitted', 'rejected', 'spec-ready',
  'spec-awaiting', 'spec-accepted-uncommitted', 'plan-ready', 'plan-awaiting', 'plan-accepted-uncommitted', 'plan-out-of-date', 'plan-superseded', 'build-ready', 'build-stopped', 'build-finished',
];

/* The pills are tab triggers, so they need the tabs root the change page puts above the toolbar. */
@Component({
  imports: [StagePills, HlmTabsImports],
  template: `
    <div hlmTabs variant="bare" [tab]="tab()" (tabActivated)="activated.push($event)">
      <app-stage-pills [pills]="pills()" />
    </div>
  `,
})
class Host {
  readonly tab = signal('spec');
  readonly pills = signal(stagePills('spec-awaiting', false, ALL_DOCS));
  readonly activated: string[] = [];
}

async function mount(over: { stage?: Stage; docs?: DocsPresent; done?: boolean; tab?: string } = {}) {
  TestBed.configureTestingModule({ imports: [Host] });
  const fixture = TestBed.createComponent(Host);
  const host = fixture.componentInstance;
  host.pills.set(stagePills(over.stage ?? 'spec-awaiting', over.done ?? false, over.docs ?? ALL_DOCS));
  if (over.tab) host.tab.set(over.tab);
  await fixture.whenStable();
  const container = fixture.nativeElement as HTMLElement;
  const tabs = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  return { fixture, host, container, tabs };
}
const text = (e: Element) => e.textContent!.replace(/\s+/g, ' ').trim();

describe('StagePills', () => {
  it.each(ALL)('draws four tabs and marks exactly one as the current step for %s', async (stage) => {
    const { container, tabs } = await mount({ stage });
    expect(tabs().length).toBe(4);
    expect(container.querySelectorAll('[aria-current="step"]').length).toBe(1);
  });

  it('reads the current pill from the stage and the others by position, each with a status dot', async () => {
    const { container, tabs } = await mount();
    expect(tabs().map(text)).toEqual(['Intent', 'Spec · awaiting acceptance', 'Plan · not started', 'Build · locked']);
    expect(tabs().every((t) => t.querySelector('.k-status__dot') !== null)).toBe(true);
    expect(tabs()[0].querySelector('.k-status--success')).not.toBeNull();
    expect(tabs()[1].querySelector('.k-status--warning')).not.toBeNull();
    expect(container.querySelector('[aria-current="step"]')).toBe(tabs()[1]);
  });

  it('names a finished pill as accepted for assistive technology, and no other', async () => {
    const { tabs } = await mount();
    expect(tabs().map((t) => t.getAttribute('aria-label'))).toEqual(['Intent, accepted', null, null, null]);
  });

  it('disables a document pill whose document does not exist, and Build while it is locked', async () => {
    const { tabs } = await mount({ stage: 'spec-ready', docs: { intent: true, spec: false, plan: false } });
    expect(tabs().map((t) => t.disabled)).toEqual([false, true, true, true]);
  });

  it('opens Build once the plan is accepted', async () => {
    const locked = await mount({ stage: 'plan-awaiting' });
    expect(locked.tabs()[3].disabled).toBe(true);
    expect(text(locked.tabs()[3])).toBe('Build · locked');
    TestBed.resetTestingModule();
    const open = await mount({ stage: 'build-ready' });
    expect(open.tabs()[3].disabled).toBe(false);
    expect(text(open.tabs()[3])).toBe('Build · ready to start');
  });

  it('reads Build · done on a finished change', async () => {
    const { tabs } = await mount({ stage: 'build-finished', done: true });
    expect(text(tabs()[3])).toBe('Build · done');
    expect(tabs()[3].getAttribute('aria-current')).toBe('step');
  });

  it('selects the tab the host holds, and reports a click', async () => {
    const { tabs, host, fixture } = await mount({ tab: 'intent' });
    expect(tabs()[0].getAttribute('aria-selected')).toBe('true');
    tabs()[2].click();
    await fixture.whenStable();
    expect(host.activated).toEqual(['plan']);
  });
});
