import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { OpenRun } from '@bindings/OpenRun';
import type { RunningEntry } from '@bindings/RunningEntry';
import type { RunningStrip as Strip } from '@bindings/RunningStrip';
import type { StripCounts } from '@bindings/StripCounts';
import { render } from '../../testing/render';
import { KataTransport } from '../core/transport/kata-transport';
import { RunningStripViewModel } from '../sdlc/running-strip.view-model';
import type { RunChoice, StripPick, StripRow } from '../lib/running-strip';
import { RunningStrip } from './running-strip';

const open: OpenRun = { run: 7, kind: 'build', repo: 'kata', waiting: true };
const choice: RunChoice = { run: 7, kind: 'build', repo: 'kata', waiting: true, label: 'kata', action: 'Answer', open };
const row = (change: string, over: Partial<StripRow> = {}): StripRow => ({
  id: `/w|kata|${change}`,
  workspaceId: 'w1',
  system: 'kata',
  change,
  name: change,
  state: 'needs an answer',
  tone: 'awaiting',
  text: 'Which branch?',
  direct: choice,
  choices: [],
  title: 'needs an answer: Which branch?',
  ...over,
});
const text = (c: ParentNode) => c.textContent!.replace(/\s+/g, ' ').trim();

// The strip is presentational: it draws the rows it is given and says which one was picked, with no transport, router or store.
describe('RunningStrip', () => {
  it('draws the rows it is given and the All running label, with nothing provided', async () => {
    const rows = [row('c-one'), row('c-two', { state: 'working', tone: 'running', text: 'build in kata', direct: null })];
    const { container } = await render(RunningStrip, { shown: rows, all: rows, allLabel: 'All running (2)' });
    const entries = Array.from(container.querySelectorAll('[data-testid="running-entry"]'));
    expect(entries.map((e) => e.getAttribute('data-change'))).toEqual(['c-one', 'c-two']);
    expect(text(entries[0])).toContain('needs an answer');
    expect(text(container)).toContain('All running (2)');
  });

  it('draws nothing when no change is running', async () => {
    const { container } = await render(RunningStrip, { shown: [], all: [], allLabel: 'All running (0)' });
    expect(container.querySelector('.k-running')).toBeNull();
  });

  it('picking an entry that opens one run says which row and run were picked', async () => {
    const r = row('c-one');
    const { container, fixture } = await render(RunningStrip, { shown: [r], all: [r], allLabel: 'All running (1)' });
    const picked: StripPick[] = [];
    fixture.componentInstance.pick.subscribe((p) => picked.push(p));
    container.querySelector<HTMLButtonElement>('[data-testid="running-entry"]')!.click();
    expect(picked).toEqual([{ row: r, choice }]);
  });

  // The group holds the list of changes with activity, which may be only finished ones, so it is never named running as a whole.
  it('the group is never named running as a whole r13.1', async () => {
    const r = row('c-one');
    const { container } = await render(RunningStrip, { shown: [r], all: [r], allLabel: 'All running (1)' });
    const group = container.querySelector('[role="group"]')!;
    expect(group.getAttribute('aria-label')).toBe('Changes with activity');
    const names = Array.from(container.querySelectorAll('[aria-label]')).map((e) => e.getAttribute('aria-label') ?? '');
    expect(names.some((n) => n.includes('Running changes'))).toBe(false);
  });

  // The label is the view-model's word for what the list holds; the strip draws it on the button and as the popover title.
  describe('the label of the list', () => {
    const entry = (n: number): RunningEntry => ({
      change: { workspace: { key: '/w', name: 'w' }, system: 'kata', change: `c-${n}` },
      since: n,
      waiting: [],
      workspaceId: 'w1',
      opens: { kind: 'change' },
      state: 'finished',
    });
    const stripOf = (counts: StripCounts): Strip => {
      const total = counts.running + counts.needsYou + counts.waiting + counts.finished;
      const all = Array.from({ length: total }, (_, i) => entry(i));
      return { shown: all.slice(0, 3), all, counts };
    };
    const settle = async () => {
      for (let i = 0; i < 4; i++) {
        TestBed.tick();
        await new Promise((r) => setTimeout(r, 0));
      }
    };
    async function mount(counts: StripCounts) {
      const transport = { sdlcRunning: async () => stripOf(counts), onRunning: async () => () => {} };
      const out = await render(RunningStrip, {}, [provideRouter([]), { provide: KataTransport, useValue: transport }, RunningStripViewModel]);
      const vm = TestBed.inject(RunningStripViewModel);
      await settle();
      out.fixture.componentRef.setInput('shown', vm.shown());
      out.fixture.componentRef.setInput('all', vm.all());
      out.fixture.componentRef.setInput('allLabel', vm.allLabel());
      out.fixture.detectChanges();
      return { ...out, vm };
    }
    const none: StripCounts = { running: 0, needsYou: 0, waiting: 0, finished: 0 };

    it.each([
      ['one change whose run finished unseen', { ...none, finished: 1 }, '1 finished'],
      ['two changes working and one waiting on an answer', { ...none, running: 2, needsYou: 1 }, '2 running · 1 needs you'],
      ['two working, one waiting on an answer, one finished unseen', { ...none, running: 2, needsYou: 1, finished: 1 }, '2 running · 1 needs you · 1 finished'],
      ["one change whose build stopped and one held by another change's build", { ...none, needsYou: 1, waiting: 1 }, '1 needs you · 1 waiting'],
      ['one change waiting for its review while another change holds its repositories', { ...none, waiting: 1 }, '1 waiting'],
    ])('the label names what the list holds r13.1: %s', async (_entries, counts, label) => {
      const { container, fixture, vm } = await mount(counts);
      expect(vm.allLabel()).toBe(label);
      const button = container.querySelector<HTMLButtonElement>('.k-running__all')!;
      expect(text(button)).toBe(label);
      button.click();
      await settle();
      fixture.detectChanges();
      const title = document.body.querySelector('[hlmPopoverTitle]');
      expect(text(title!)).toBe(label);
      expect(document.body.querySelector('.k-running__all-list')!.getAttribute('aria-label')).toBe('Changes with activity');
    });

    it('no label for an empty list r13.2', async () => {
      const { container, vm } = await mount(none);
      expect(vm.allLabel()).toBe('');
      expect(container.querySelector('.k-running__all')).toBeNull();
    });
  });
});
